// Offline tests for learner accounts and subscriptions. Supabase and Razorpay are simulated; no real call is made.
import tutor from "./api/tutor.js";
import billing from "./api/billing.js";
import {handleWebhook} from "./api/razorpay-webhook.js";
import {hmacHex, config} from "./lib/accounts.js";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS: " : "FAIL: ") + m); if (!c) failed++; };

const ENV = {
  ANTHROPIC_API_KEY: "sk-ant-api03-test", SUPABASE_URL: "https://proj.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc",
  SUPABASE_SECRET_KEY: "sb_secret_xyz", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_secret_123",
  RAZORPAY_WEBHOOK_SECRET: "whsec_456", RAZORPAY_PLAN_BASIC: "plan_BASIC000000001", RAZORPAY_PLAN_PLUS: "plan_PLUS0000000001", ACCESS_CODE: "bolo26",
};
const setEnv = extra => { for (const k of Object.keys(process.env)) if (/^(SUPABASE|RAZORPAY|PLUS|ACCESS|ANTHROPIC)/i.test(k)) delete process.env[k]; Object.assign(process.env, ENV, extra || {}); };
setEnv();

// ---------- simulated services ----------
const USER = {id: "11111111-1111-1111-1111-111111111111", email: "ravi@example.in"};
let calls = [], sub, rzpSub, allowance, userOk, rzpFail, dbFail, events, claudeAborted;
function reset() {
  calls = []; userOk = true; rzpFail = false; dbFail = false; events = new Set(); claudeAborted = false;
  sub = {user_id: USER.id, plan: "trial", status: "trialing", razorpay_subscription_id: null, pending_plan: null, current_end: null};
  rzpSub = {id: "sub_TEST000000001", plan_id: ENV.RAZORPAY_PLAN_BASIC, status: "active", current_end: 1793000000, notes: {user_id: USER.id}};
  allowance = {status: 200, data: {ok: true, plan: "trial", left: 139}};
}
const reply = JSON.stringify({rule: "", better: "", reply: "Good. Tell me more.", good: "", said: "", tip: ""});
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET", headers = opts.headers || {}, body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({url, method, headers, body});
  const J = (status, d) => ({ok: status < 300, status, text: async () => JSON.stringify(d), json: async () => d});
  if (url.startsWith("https://api.anthropic.com")) {
    opts.signal?.addEventListener("abort", () => { claudeAborted = true; });
    const enc = new TextEncoder(); let sent = false;
    return {ok: true, status: 200, body: new ReadableStream({async pull(c) {
      await new Promise(r => setTimeout(r, 5));
      if (sent) return c.close(); sent = true;
      c.enqueue(enc.encode(`data: ${JSON.stringify({type: "content_block_delta", delta: {type: "text_delta", text: reply}})}\n\n`));
    }})};
  }
  if (url.endsWith("/rest/v1/rpc/use_reply")) { await new Promise(r => setTimeout(r, 15)); return J(allowance.status, allowance.data); }
  if (url.endsWith("/auth/v1/user")) return userOk && headers.authorization === "Bearer learner-token" ? J(200, USER) : J(401, {msg: "bad jwt"});
  if (url.includes("/rest/v1/subscriptions?user_id=eq.") && method === "GET") return J(200, [sub]);
  if (url.includes("/rest/v1/subscriptions?") && method === "PATCH") {
    if (dbFail) return J(500, {message: "db down"});
    const m = url.match(/razorpay_subscription_id=eq\.([^&]+)/);
    if (m && sub.razorpay_subscription_id !== decodeURIComponent(m[1])) return J(200, []);
    Object.assign(sub, body); return J(200, [sub]);
  }
  if (url.includes("/rest/v1/razorpay_events?event_id=eq.")) return J(200, events.has(decodeURIComponent(url.split("eq.")[1].split("&")[0])) ? [{event_id: "x"}] : []);
  if (url.endsWith("/rest/v1/razorpay_events") && method === "POST") { events.add(body.event_id); return J(201, null); }
  if (url.includes("/auth/v1/admin/users/") && method === "DELETE") return J(200, {});
  if (url === "https://api.razorpay.com/v1/subscriptions" && method === "POST") return rzpFail ? J(400, {error: {description: "bad"}}) : J(200, {...rzpSub, status: "created", current_end: null});
  if (url.startsWith("https://api.razorpay.com/v1/subscriptions/") && url.endsWith("/cancel")) return J(200, {...rzpSub, status: "active"});
  if (url.startsWith("https://api.razorpay.com/v1/subscriptions/") && method === "GET") return rzpFail ? J(500, {}) : J(200, rzpSub);
  return J(404, {error: "unexpected " + url});
};

// ---------- request helpers ----------
function call(handler, body, {method = "POST", token = "learner-token"} = {}) {
  return new Promise(resolve => {
    const lines = [];
    const res = {code: 200, headers: {}, writableEnded: false, setHeader(k, v) { this.headers[k] = v; }, on() {},
      status(c) { this.code = c; return this; },
      json(d) { this.writableEnded = true; resolve({code: this.code, data: d, headers: this.headers}); return this; },
      write(s) { lines.push(JSON.parse(s)); },
      end() { this.writableEnded = true; resolve({code: this.code, lines, headers: this.headers}); }};
    handler({method, body, headers: {"x-forwarded-for": "1.2.3." + Math.floor(Math.random() * 200), ...(token ? {authorization: "Bearer " + token} : {})}}, res);
  });
}
const said = {scenario: "intro", lang: "Hindi", level: "A2", said: "I am working here since two years", history: []};

// ================= tutor in accounts mode =================
reset();
let r = await call(tutor, null, {method: "GET", token: ""});
ok(r.data.auth === "accounts" && r.data.supabaseUrl === ENV.SUPABASE_URL && r.data.supabaseKey === ENV.SUPABASE_PUBLISHABLE_KEY && r.data.payments === true && r.data.plusEnabled === false && r.data.needCode === false,
  "GET tells the page that accounts are on, with only the public Supabase key");
const pub = JSON.stringify(r.data);
ok(!/sb_secret|rzp_secret|whsec|sk-ant/.test(pub), "no secret key is ever sent to the browser");
r = await call(tutor, said, {token: ""});
ok(r.code === 401 && r.data.needLogin, "no login: no reply");
reset();
r = await call(tutor, {...said, code: "wrong"});
const rpc = calls.find(x => x.url.endsWith("/rpc/use_reply"));
ok(r.code === 200 && r.lines.at(-1).done, "signed in with allowance: the tutor replies (class code not needed)");
ok(rpc.headers.apikey === ENV.SUPABASE_PUBLISHABLE_KEY && rpc.headers.authorization === "Bearer learner-token" && rpc.body.consume === true, "allowance checked with the learner's own token and the public key");
ok(r.headers["X-Replies-Left"] === "139", "replies left passed to the page");
const iRpc = calls.findIndex(x => x.url.endsWith("/rpc/use_reply")), iClaude = calls.findIndex(x => x.url.startsWith("https://api.anthropic.com"));
ok(iRpc >= 0 && iClaude >= 0 && Math.abs(iRpc - iClaude) === 1, "allowance check and Claude start together (no added wait)");
reset(); allowance = {status: 200, data: {ok: false, reason: "trial_over"}};
r = await call(tutor, said);
await new Promise(r => setTimeout(r, 20));
ok(r.code === 402 && r.data.needPlan && /trial has ended/.test(r.data.error) && claudeAborted, "trial over: clear message, Claude call stopped");
reset(); allowance = {status: 200, data: {ok: false, reason: "month_used_up"}};
r = await call(tutor, said);
ok(r.code === 402 && /renew on the 1st/.test(r.data.error), "monthly allowance used up: clear message");
reset(); allowance = {status: 401, data: {message: "JWT expired"}};
r = await call(tutor, said);
ok(r.code === 401 && r.data.needLogin, "expired login: asked to sign in again");
reset(); allowance = {status: 500, data: null};
r = await call(tutor, said);
ok(r.code === 503, "allowance check failing: no free reply given");

// ================= billing =================
reset();
r = await call(billing, {action: "subscribe", plan: "basic"}, {token: "stolen"});
ok(r.code === 401, "billing needs a valid login");
reset();
r = await call(billing, {action: "subscribe", plan: "basic"});
const create = calls.find(x => x.url === "https://api.razorpay.com/v1/subscriptions");
ok(r.code === 200 && r.data.subscription_id === "sub_TEST000000001" && r.data.key === "rzp_test_key", "subscribe returns what Razorpay Checkout needs");
ok(create.body.plan_id === ENV.RAZORPAY_PLAN_BASIC && create.body.total_count === 120 && create.body.notes.user_id === USER.id, "Razorpay subscription created on the Basic plan, tagged with the learner");
ok(create.headers.authorization === "Basic " + Buffer.from("rzp_test_key:rzp_secret_123").toString("base64"), "Razorpay called with the key id and secret (server side only)");
ok(sub.razorpay_subscription_id === "sub_TEST000000001" && sub.pending_plan === "basic" && sub.plan === "trial", "checkout opened: trial kept until payment is confirmed");
const dbWrite = calls.find(x => x.method === "PATCH");
ok(dbWrite.headers.apikey === ENV.SUPABASE_SECRET_KEY && !dbWrite.headers.authorization, "new-style secret key sent only as apikey");
ok(!JSON.stringify(r.data).includes("rzp_secret"), "key secret not returned");
reset();
r = await call(billing, {action: "subscribe", plan: "plus"});
ok(r.code === 400 && /not available/.test(r.data.error), "Plus refused until it is switched on");
setEnv({PLUS_ENABLED: "1"}); reset();
r = await call(billing, {action: "subscribe", plan: "plus"});
ok(r.code === 200 && calls.find(x => x.url === "https://api.razorpay.com/v1/subscriptions").body.plan_id === ENV.RAZORPAY_PLAN_PLUS, "Plus available once PLUS_ENABLED is set");
setEnv(); reset(); sub.plan = "basic"; sub.status = "active";
r = await call(billing, {action: "subscribe", plan: "basic"});
ok(r.code === 409, "cannot buy a second plan while one is running");
setEnv({RAZORPAY_PLAN_BASIC: ""}); reset();
r = await call(billing, {action: "subscribe", plan: "basic"});
ok(r.code === 503, "payments not set up: clear message");
setEnv(); reset(); rzpFail = true;
r = await call(billing, {action: "subscribe", plan: "basic"});
ok(r.code === 502, "Razorpay refusal reported");

// verify
reset(); sub.razorpay_subscription_id = "sub_TEST000000001"; sub.pending_plan = "basic";
const goodSig = hmacHex("rzp_secret_123", "pay_ABC123|sub_TEST000000001");
r = await call(billing, {action: "verify", razorpay_payment_id: "pay_ABC123", razorpay_subscription_id: "sub_TEST000000001", razorpay_signature: goodSig});
ok(r.code === 200 && sub.plan === "basic" && sub.status === "active" && sub.pending_plan === null && sub.current_end === new Date(1793000000 * 1000).toISOString(), "correct signature: Basic plan active, paid period saved");
reset(); sub.razorpay_subscription_id = "sub_TEST000000001";
r = await call(billing, {action: "verify", razorpay_payment_id: "pay_ABC123", razorpay_subscription_id: "sub_TEST000000001", razorpay_signature: goodSig.replace(/.$/, c => c === "0" ? "1" : "0")});
ok(r.code === 400 && sub.plan === "trial", "wrong signature: nothing activated");
reset(); sub.razorpay_subscription_id = "sub_OTHER00000001";
r = await call(billing, {action: "verify", razorpay_payment_id: "pay_ABC123", razorpay_subscription_id: "sub_TEST000000001", razorpay_signature: goodSig});
ok(r.code === 400, "signature for someone else's subscription refused");
reset(); sub.razorpay_subscription_id = "sub_TEST000000001"; rzpSub.status = "created";
r = await call(billing, {action: "verify", razorpay_payment_id: "pay_ABC123", razorpay_subscription_id: "sub_TEST000000001", razorpay_signature: goodSig});
ok(sub.plan === "trial" && sub.status === "trialing", "Razorpay still says 'created': trial left as it is");

// cancel and delete
reset(); Object.assign(sub, {plan: "basic", status: "active", razorpay_subscription_id: "sub_TEST000000001"});
r = await call(billing, {action: "cancel"});
const cancel = calls.find(x => x.url.endsWith("/cancel"));
ok(r.code === 200 && cancel.body.cancel_at_cycle_end === 1 && sub.cancel_at_cycle_end === true, "cancel stops the plan at the end of the paid period");
reset();
r = await call(billing, {action: "cancel"});
ok(r.code === 400, "nothing to cancel on a trial");
reset(); Object.assign(sub, {plan: "basic", status: "active", razorpay_subscription_id: "sub_TEST000000001"});
r = await call(billing, {action: "delete_account"});
const iCancel = calls.findIndex(x => x.url.endsWith("/cancel")), iDel = calls.findIndex(x => x.method === "DELETE");
ok(r.code === 200 && r.data.deleted && iCancel >= 0 && iDel > iCancel && JSON.stringify(calls[iCancel].body) === "{}", "delete account: plan stopped at once, then account deleted");
const del = calls[iDel];
ok(del.url === `${ENV.SUPABASE_URL}/auth/v1/admin/users/${USER.id}` && del.headers.apikey === ENV.SUPABASE_SECRET_KEY, "account deleted through the Supabase admin API with the secret key");

// legacy service_role key is a token, so it is also sent as Bearer
setEnv({SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.legacy.sig"}); reset();
await call(billing, {action: "subscribe", plan: "basic"});
const legacy = calls.find(x => x.method === "PATCH");
ok(legacy.headers.apikey.startsWith("eyJ") && legacy.headers.authorization === "Bearer eyJhbGciOiJIUzI1NiJ9.legacy.sig", "legacy service_role key also works");
setEnv();

// ================= webhook =================
const hook = (obj, {sig, eventId = "evt_1"} = {}) => {
  const raw = JSON.stringify(obj);
  return handleWebhook(new Request("https://x/api/razorpay-webhook", {method: "POST", body: raw,
    headers: {"x-razorpay-signature": sig ?? hmacHex("whsec_456", raw), "x-razorpay-event-id": eventId}}), process.env);
};
const charged = {event: "subscription.charged", payload: {subscription: {entity: {id: "sub_TEST000000001", status: "active", notes: {user_id: USER.id}}}}};
reset(); sub.razorpay_subscription_id = "sub_TEST000000001";
r = await hook(charged, {sig: "0".repeat(64)});
ok(r.status === 400 && sub.plan === "trial", "webhook with a wrong signature ignored");
reset(); sub.razorpay_subscription_id = "sub_TEST000000001";
r = await hook(charged);
ok(r.status === 200 && sub.plan === "basic" && sub.status === "active" && events.has("evt_1"), "subscription.charged: plan saved from Razorpay's current state, event recorded");
calls = [];
r = await hook(charged);
ok(r.status === 200 && (await r.json()).duplicate && !calls.some(x => x.url.includes("razorpay.com")), "same event delivered twice: handled once");
reset(); sub.razorpay_subscription_id = "sub_TEST000000001"; rzpSub.status = "halted";
r = await hook({...charged, event: "subscription.halted"}, {eventId: "evt_2"});
ok(r.status === 200 && sub.status === "halted", "subscription.halted: access stops (status saved)");
reset(); sub.razorpay_subscription_id = "sub_TEST000000001"; dbFail = true;
r = await hook(charged, {eventId: "evt_3"});
ok(r.status === 500 && !events.has("evt_3"), "save failed: error returned so Razorpay retries, event not marked done");
reset();
r = await hook({event: "payment.captured", payload: {}}, {eventId: "evt_4"});
ok(r.status === 200 && (await r.json()).ignored, "non-subscription events ignored");
reset(); sub.razorpay_subscription_id = null;
r = await hook(charged, {eventId: "evt_5"});
ok(r.status === 200 && sub.plan === "basic" && sub.razorpay_subscription_id === "sub_TEST000000001", "subscription not yet linked: found through the learner id in its notes");
setEnv({RAZORPAY_WEBHOOK_SECRET: ""});
r = await hook(charged);
ok(r.status === 503, "webhook refused until its secret is set");
setEnv();
ok(config({SUPABASE_URL: "https://p.supabase.co/", SUPABASE_ANON_KEY: '"anon"'}).url === "https://p.supabase.co" && config({SUPABASE_ANON_KEY: '"anon"', SUPABASE_URL: "x"}).pub === "anon", "settings cleaned of a trailing slash and quotes");

console.log(failed ? `${failed} failed` : "ALL PASS");
process.exit(failed ? 1 : 0);
