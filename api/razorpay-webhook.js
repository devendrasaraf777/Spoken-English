// Vercel function: POST /api/razorpay-webhook   (Razorpay Dashboard -> Webhooks -> this address)
// Uses the Web-standard handler so the body arrives exactly as Razorpay sent it, which the signature needs.
import {config, webhookSignatureOk, eventSeen, recordEvent, syncSubscription} from "../lib/accounts.js";

const json = (status, obj) => new Response(JSON.stringify(obj), {status, headers: {"content-type": "application/json", "cache-control": "no-store"}});

export async function handleWebhook(request, env = process.env) {
  if (request.method !== "POST") return json(405, {error: "Use POST."});
  const c = config(env);
  if (!c.webhookSecret || !c.on || !c.secret) return json(503, {error: "Webhook not set up."});
  const raw = await request.text();
  if (!webhookSignatureOk(c.webhookSecret, raw, request.headers.get("x-razorpay-signature"))) return json(400, {error: "Bad signature."});
  let ev; try { ev = JSON.parse(raw); } catch { return json(400, {error: "Bad body."}); }
  if (!String(ev.event || "").startsWith("subscription.")) return json(200, {ignored: true});
  const sub = ev.payload && ev.payload.subscription && ev.payload.subscription.entity;
  if (!sub || !sub.id) return json(200, {ignored: true});

  const eventId = request.headers.get("x-razorpay-event-id") || "";
  if (eventId && await eventSeen(c, eventId)) return json(200, {duplicate: true});
  const userId = sub.notes && !Array.isArray(sub.notes) ? sub.notes.user_id : "";
  const s = await syncSubscription(c, sub.id, userId);
  if (!s.ok) return json(500, {error: "Could not save; Razorpay will retry."});   // a non-2xx reply makes Razorpay retry
  if (eventId) await recordEvent(c, eventId, ev.event);                             // only after the change is saved
  return json(200, {ok: true, status: s.status});
}

export default { fetch: request => handleWebhook(request) };
