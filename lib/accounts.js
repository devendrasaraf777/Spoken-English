// Shared server helpers for learner accounts (Supabase) and subscriptions (Razorpay).
// Nothing here runs in the browser; the secret keys stay on the server.
import crypto from "node:crypto";

// ---------------- settings (Vercel environment variables) ----------------
const clean = v => String(v ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
export function config(env = process.env) {
  const url = clean(env.SUPABASE_URL).replace(/\/+$/, "");
  const pub = clean(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY);
  const secret = clean(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
  return {
    url, pub, secret,
    on: Boolean(url && pub),                       // accounts switched on
    rzpKey: clean(env.RAZORPAY_KEY_ID),
    rzpSecret: clean(env.RAZORPAY_KEY_SECRET),
    webhookSecret: clean(env.RAZORPAY_WEBHOOK_SECRET),
    plans: {basic: clean(env.RAZORPAY_PLAN_BASIC), plus: clean(env.RAZORPAY_PLAN_PLUS)},
    plusOn: /^(1|true|yes)$/i.test(clean(env.PLUS_ENABLED)),
  };
}
export const paymentsReady = c => Boolean(c.on && c.secret && c.rzpKey && c.rzpSecret && c.plans.basic);
export const bearer = req => {
  const h = String(req.headers?.authorization || req.headers?.Authorization || "");
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};

// ---------------- Supabase ----------------
// The project key goes in "apikey"; a learner's login token goes in "Authorization: Bearer".
// A legacy service_role key is itself a token, so it is also sent as Bearer; a new secret key is not.
async function sb(c, path, {method = "GET", body, token, admin = false, prefer} = {}) {
  const headers = {apikey: admin ? c.secret : c.pub, "content-type": "application/json"};
  if (token) headers.authorization = `Bearer ${token}`;
  else if (admin && c.secret.startsWith("eyJ")) headers.authorization = `Bearer ${c.secret}`;
  if (prefer) headers.prefer = prefer;
  let r;
  try { r = await fetch(c.url + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)}); }
  catch { return {ok: false, status: 0, data: null}; }
  const t = await r.text().catch(() => "");
  let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return {ok: r.ok, status: r.status, data};
}
export const useReply = (c, token, consume = true) => sb(c, "/rest/v1/rpc/use_reply", {method: "POST", body: {consume}, token});
export async function getUser(c, token) {
  if (!token) return null;
  const r = await sb(c, "/auth/v1/user", {token});
  return r.ok && r.data && r.data.id ? r.data : null;
}
const id = v => encodeURIComponent(String(v));
export async function getSub(c, userId) {
  const r = await sb(c, `/rest/v1/subscriptions?user_id=eq.${id(userId)}&select=*`, {admin: true});
  return r.ok && Array.isArray(r.data) ? r.data[0] || null : null;
}
export const patchSub = (c, filter, body) =>
  sb(c, `/rest/v1/subscriptions?${filter}`, {method: "PATCH", body: {...body, updated_at: new Date().toISOString()}, admin: true, prefer: "return=representation"});
export async function eventSeen(c, eventId) {
  const r = await sb(c, `/rest/v1/razorpay_events?event_id=eq.${id(eventId)}&select=event_id`, {admin: true});
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}
export const recordEvent = (c, eventId, event) =>
  sb(c, "/rest/v1/razorpay_events", {method: "POST", body: {event_id: eventId, event}, admin: true, prefer: "return=minimal"});
export const deleteUser = (c, userId) => sb(c, `/auth/v1/admin/users/${id(userId)}`, {method: "DELETE", admin: true});

// ---------------- Razorpay ----------------
async function rzp(c, path, {method = "GET", body} = {}) {
  const headers = {authorization: "Basic " + Buffer.from(`${c.rzpKey}:${c.rzpSecret}`).toString("base64"), "content-type": "application/json"};
  let r;
  try { r = await fetch("https://api.razorpay.com/v1" + path, {method, headers, body: body ? JSON.stringify(body) : undefined}); }
  catch { return {ok: false, status: 0, data: null}; }
  const data = await r.json().catch(() => null);
  if (!r.ok) console.error("razorpay error", r.status, JSON.stringify(data?.error || data).slice(0, 300));
  return {ok: r.ok, status: r.status, data};
}
// Monthly plan for up to 120 months (10 years); Razorpay sends its own payment reminders and receipts.
export const createSubscription = (c, planId, notes) =>
  rzp(c, "/subscriptions", {method: "POST", body: {plan_id: planId, total_count: 120, quantity: 1, customer_notify: 1, notes}});
export const fetchSubscription = (c, subId) => rzp(c, `/subscriptions/${id(subId)}`);
export const cancelSubscription = (c, subId, atCycleEnd) =>
  rzp(c, `/subscriptions/${id(subId)}/cancel`, {method: "POST", body: atCycleEnd ? {cancel_at_cycle_end: 1} : {}});

// Signatures: HMAC-SHA256, hex. Checkout: payment id + "|" + the subscription id stored on our side,
// with the key secret. Webhook: the raw request body, with the webhook secret.
export const hmacHex = (secret, msg) => crypto.createHmac("sha256", secret).update(msg).digest("hex");
export function sameHex(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export const checkoutSignatureOk = (c, paymentId, subId, signature) =>
  Boolean(c.rzpSecret && paymentId && subId) && sameHex(hmacHex(c.rzpSecret, `${paymentId}|${subId}`), signature);
export const webhookSignatureOk = (secret, raw, signature) => Boolean(secret) && sameHex(hmacHex(secret, raw), signature);

export function planFor(c, planId) {
  if (planId && planId === c.plans.basic) return "basic";
  if (planId && planId === c.plans.plus) return "plus";
  return null;
}
export const PAID_RUNNING = ["active", "authenticated", "pending"];

// Copy Razorpay's current state of a subscription into our table. Fetching it fresh (rather than
// trusting one event) keeps the record right even when webhook events arrive out of order.
export async function syncSubscription(c, subId, fallbackUserId) {
  const r = await fetchSubscription(c, subId);
  if (!r.ok || !r.data || !r.data.id) return {ok: false};
  const e = r.data, plan = planFor(c, e.plan_id);
  const patch = {razorpay_subscription_id: e.id};
  // "created" means checkout was opened but not paid: leave the learner's current plan and trial alone.
  if (e.status !== "created" && plan) {
    patch.plan = plan; patch.status = e.status; patch.pending_plan = null;
    patch.current_end = e.current_end ? new Date(e.current_end * 1000).toISOString() : null;
  }
  if (["cancelled", "completed", "expired"].includes(e.status)) patch.cancel_at_cycle_end = false;
  let u = await patchSub(c, `razorpay_subscription_id=eq.${id(e.id)}`, patch);
  const userId = fallbackUserId || (e.notes && !Array.isArray(e.notes) ? e.notes.user_id : "");
  if (u.ok && Array.isArray(u.data) && u.data.length === 0 && userId) u = await patchSub(c, `user_id=eq.${id(userId)}`, patch);
  if (!u.ok) return {ok: false};
  return {ok: true, status: e.status, plan, current_end: patch.current_end || null, saved: Array.isArray(u.data) ? u.data.length : 0};
}
