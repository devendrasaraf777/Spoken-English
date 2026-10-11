-- English Bolo Tutor: learner accounts, profiles, free trial, subscriptions and usage.
-- Run once in Supabase: SQL Editor -> New query -> paste this whole file -> Run.
-- Safe to run again: every object is created only if missing, and functions are replaced.

-- ---------------------------------------------------------------------------
-- Plan allowances. Change the numbers here (Table Editor -> plan_limits) without touching code.
-- Prices include 18% GST and must match the plans created in the Razorpay Dashboard.
-- ---------------------------------------------------------------------------
create table if not exists public.plan_limits (
  plan            text primary key check (plan in ('trial', 'basic', 'plus')),
  replies         integer not null check (replies >= 0),   -- tutor replies: whole trial, or per calendar month
  price_inr       integer not null check (price_inr >= 0),
  trial_days      integer not null default 0
);
insert into public.plan_limits (plan, replies, price_inr, trial_days) values
  ('trial', 140, 0, 7),
  ('basic', 400, 149, 0),
  ('plus',  400, 299, 0)
on conflict (plan) do nothing;

-- ---------------------------------------------------------------------------
-- Learner profile: the learner may read and edit these fields only.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  full_name     text not null default '' check (char_length(full_name) <= 80),
  mobile        text not null default '' check (mobile ~ '^[0-9+ ]{0,16}$'),
  tip_language  text not null default 'Hindi' check (tip_language in ('Hindi', 'Marathi', 'Bengali')),
  level         text not null default 'A2' check (level in ('A1', 'A2', 'B1', 'B2')),
  goal          text not null default 'Job interview'
                check (goal in ('Job interview', 'Workplace and customers', 'Students', 'Everyday')),
  age_confirmed boolean not null default false,   -- 18 or older, or a parent or guardian agrees
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Subscription: written only by the server (trial start, Razorpay results). Learners can read their own.
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  user_id                  uuid primary key references auth.users on delete cascade,
  plan                     text not null default 'trial' check (plan in ('trial', 'basic', 'plus')),
  status                   text not null default 'trialing',
                           -- trialing, or Razorpay's: created, authenticated, active, pending, halted,
                           -- cancelled, completed, expired
  trial_ends_at            timestamptz not null default now() + interval '7 days',
  trial_replies            integer not null default 0,
  razorpay_subscription_id text unique,
  pending_plan             text check (pending_plan in ('basic', 'plus')),
  current_end              timestamptz,
  cancel_at_cycle_end      boolean not null default false,
  updated_at               timestamptz not null default now()
);

-- Replies used per calendar month (India time) on a paid plan.
create table if not exists public.usage (
  user_id  uuid not null references auth.users on delete cascade,
  month    text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  replies  integer not null default 0,
  primary key (user_id, month)
);

-- Razorpay webhook events already handled (Razorpay may deliver the same event more than once).
create table if not exists public.razorpay_events (
  event_id    text primary key,
  event       text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Access rules (row level security). The server uses the secret key, which bypasses these rules.
-- ---------------------------------------------------------------------------
alter table public.plan_limits     enable row level security;
alter table public.profiles        enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.usage           enable row level security;
alter table public.razorpay_events enable row level security;

revoke all on public.plan_limits, public.profiles, public.subscriptions, public.usage, public.razorpay_events
  from anon, authenticated;

grant select on public.plan_limits to anon, authenticated;
grant select on public.profiles, public.subscriptions, public.usage to authenticated;
grant update (full_name, mobile, tip_language, level, goal, age_confirmed) on public.profiles to authenticated;

drop policy if exists "plans are public" on public.plan_limits;
create policy "plans are public" on public.plan_limits for select to anon, authenticated using (true);

drop policy if exists "own profile: read" on public.profiles;
create policy "own profile: read" on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
drop policy if exists "own profile: update" on public.profiles;
create policy "own profile: update" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "own subscription: read" on public.subscriptions;
create policy "own subscription: read" on public.subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own usage: read" on public.usage;
create policy "own usage: read" on public.usage for select to authenticated
  using ((select auth.uid()) = user_id);
-- razorpay_events: no policy, so only the server can see it.

-- Keep profiles.updated_at current.
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute procedure public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- New learner: create the profile and start the free trial.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_learner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  days integer;
begin
  select coalesce(trial_days, 7) into days from public.plan_limits where plan = 'trial';
  insert into public.profiles (id, full_name, age_confirmed)
  values (new.id,
          left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 80),
          coalesce((new.raw_user_meta_data ->> 'age_confirmed')::boolean, false))
  on conflict (id) do nothing;
  insert into public.subscriptions (user_id, trial_ends_at)
  values (new.id, now() + make_interval(days => coalesce(days, 7)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_bolo on auth.users;
create trigger on_auth_user_created_bolo after insert on auth.users
  for each row execute procedure public.handle_new_learner();

-- ---------------------------------------------------------------------------
-- use_reply: called by the server before each tutor reply, with the learner's own login token.
-- consume = true uses one reply; false only reports. Returns ok, reason, plan, replies left, period end.
-- ---------------------------------------------------------------------------
create or replace function public.use_reply(consume boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid   uuid := auth.uid();
  s     public.subscriptions%rowtype;
  lim   integer;
  used  integer;
  m     text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM');
  paid  boolean;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'signed_out');
  end if;

  select * into s from public.subscriptions where user_id = uid for update;
  if not found then                                   -- account made before this schema: start a trial
    insert into public.subscriptions (user_id) values (uid) returning * into s;
  end if;

  -- A paid plan counts while Razorpay says it is running, or until the end of a period already paid for.
  paid := s.plan in ('basic', 'plus') and (
            s.status in ('active', 'pending', 'authenticated')
            or (s.status = 'cancelled' and s.current_end is not null and s.current_end > now()));

  if paid then
    select replies into lim from public.plan_limits where plan = s.plan;
    insert into public.usage (user_id, month, replies) values (uid, m, 0) on conflict do nothing;
    select replies into used from public.usage where user_id = uid and month = m for update;
    if used >= lim then
      return jsonb_build_object('ok', false, 'reason', 'month_used_up', 'plan', s.plan, 'left', 0,
                                'until', s.current_end);
    end if;
    if consume then
      update public.usage set replies = replies + 1 where user_id = uid and month = m;
      used := used + 1;
    end if;
    return jsonb_build_object('ok', true, 'plan', s.plan, 'left', lim - used, 'until', s.current_end);
  end if;

  if s.plan = 'trial' or s.status = 'trialing' then
    select replies into lim from public.plan_limits where plan = 'trial';
    if s.trial_ends_at <= now() then
      return jsonb_build_object('ok', false, 'reason', 'trial_over', 'plan', 'trial', 'left', 0,
                                'until', s.trial_ends_at);
    end if;
    if s.trial_replies >= lim then
      return jsonb_build_object('ok', false, 'reason', 'trial_used_up', 'plan', 'trial', 'left', 0,
                                'until', s.trial_ends_at);
    end if;
    if consume then
      update public.subscriptions set trial_replies = trial_replies + 1 where user_id = uid;
      s.trial_replies := s.trial_replies + 1;
    end if;
    return jsonb_build_object('ok', true, 'plan', 'trial', 'left', lim - s.trial_replies,
                              'until', s.trial_ends_at);
  end if;

  return jsonb_build_object('ok', false, 'reason', 'no_plan', 'plan', s.plan, 'left', 0,
                            'status', s.status, 'until', s.current_end);
end;
$$;

revoke execute on function public.use_reply(boolean) from public, anon;
grant execute on function public.use_reply(boolean) to authenticated;
revoke execute on function public.handle_new_learner() from public, anon, authenticated;
