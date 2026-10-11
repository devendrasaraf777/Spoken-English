// Vercel serverless function: POST /api/billing   (learner must be signed in)
//   {action:"subscribe", plan:"basic"|"plus"} -> starts a Razorpay subscription, returns what Checkout needs
//   {action:"verify", razorpay_payment_id, razorpay_subscription_id, razorpay_signature} -> checks Checkout's result
//   {action:"cancel"}          -> stops the plan at the end of the period already paid for
//   {action:"delete_account"}  -> cancels any plan at once and deletes the account and its data
import {config, paymentsReady, bearer, getUser, getSub, patchSub, createSubscription, cancelSubscription,
  checkoutSignatureOk, syncSubscription, deleteUser, PAID_RUNNING} from "../lib/accounts.js";

const PLAN_NAMES = {basic: "Basic", plus: "Plus"};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error: "Use POST."});
  const c = config();
  if (!c.on || !c.secret) return res.status(503).json({error: "Learner accounts are not set up yet."});

  const user = await getUser(c, bearer(req));
  if (!user) return res.status(401).json({error: "Please sign in again.", needLogin: true});

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const action = body && body.action;
  const sub = await getSub(c, user.id);
  const running = sub && ["basic", "plus"].includes(sub.plan) && PAID_RUNNING.includes(sub.status);

  if (action === "subscribe") {
    const plan = body.plan;
    if (!["basic", "plus"].includes(plan)) return res.status(400).json({error: "Unknown plan."});
    if (plan === "plus" && !c.plusOn) return res.status(400).json({error: "The Plus plan is not available yet."});
    if (!paymentsReady(c) || !c.plans[plan]) return res.status(503).json({error: "Payments are not set up yet."});
    if (running) return res.status(409).json({error: `You already have the ${PLAN_NAMES[sub.plan]} plan.`});
    const r = await createSubscription(c, c.plans[plan], {user_id: user.id, plan});
    if (!r.ok || !r.data || !r.data.id) return res.status(502).json({error: "Could not start the payment. Please try again."});
    const saved = await patchSub(c, `user_id=eq.${encodeURIComponent(user.id)}`, {razorpay_subscription_id: r.data.id, pending_plan: plan});
    if (!saved.ok) return res.status(502).json({error: "Could not start the payment. Please try again."});
    return res.status(200).json({key: c.rzpKey, subscription_id: r.data.id, plan, email: user.email || ""});
  }

  if (action === "verify") {
    const subId = sub && sub.razorpay_subscription_id;
    // The signature is checked against the subscription id stored on our side, not the one sent back.
    if (!subId || body.razorpay_subscription_id !== subId ||
        !checkoutSignatureOk(c, body.razorpay_payment_id, subId, body.razorpay_signature)) {
      return res.status(400).json({error: "The payment could not be verified. If money was taken, it will show here within a few minutes."});
    }
    const s = await syncSubscription(c, subId, user.id);
    if (!s.ok) return res.status(502).json({error: "Payment received; your plan will show here within a few minutes."});
    return res.status(200).json({ok: true, status: s.status, plan: s.plan});
  }

  if (action === "cancel") {
    if (!running || !sub.razorpay_subscription_id) return res.status(400).json({error: "You have no running plan to cancel."});
    const r = await cancelSubscription(c, sub.razorpay_subscription_id, true);
    if (!r.ok) return res.status(502).json({error: "Could not cancel just now. Please try again."});
    await patchSub(c, `user_id=eq.${encodeURIComponent(user.id)}`, {cancel_at_cycle_end: true});
    await syncSubscription(c, sub.razorpay_subscription_id, user.id);
    return res.status(200).json({ok: true});
  }

  if (action === "delete_account") {
    if (running && sub.razorpay_subscription_id) {
      const r = await cancelSubscription(c, sub.razorpay_subscription_id, false);
      if (!r.ok) return res.status(502).json({error: "Could not stop your plan, so the account was not deleted. Please try again."});
    }
    const d = await deleteUser(c, user.id);
    if (!d.ok) return res.status(502).json({error: "Could not delete the account just now. Please try again."});
    return res.status(200).json({deleted: true});
  }

  return res.status(400).json({error: "Unknown action."});
}
