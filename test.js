// Offline tests for the server function. No real Anthropic call is made.
import handler, {SCENARIOS, validate} from "./api/tutor.js";
import fs from "node:fs";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS: " : "FAIL: ") + m); if (!c) failed++; };

function call(body, {ip = "1.1.1.1", method = "POST"} = {}) {
  return new Promise(resolve => {
    const res = {code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; }, json(d) { resolve({code: this.code, data: d}); return this; }};
    handler({method, body, headers: {"x-forwarded-for": ip}}, res);
  });
}

let sent = null;
globalThis.fetch = async (url, opts) => {
  sent = {url, opts, body: JSON.parse(opts.body)};
  const reply = {reply: "Good. What work do you do?", good: "Clear answer.",
    correction: {said: "I am completed", better: "I completed my BCom last year", tip: "\"I completed\" बोलें।", type: "tense"}};
  return {ok: true, status: 200, json: async () => ({content: [{type: "text", text: "```json\n" + JSON.stringify(reply) + "\n```"}]})};
};

const good = {scenario: "intro", lang: "Hindi", level: "A2", said: "I am completed my BCom",
  history: [{role: "assistant", content: SCENARIOS[0].opener}]};

delete process.env.ANTHROPIC_API_KEY;
ok((await call(good)).code === 500, "refuses to run without the owner's key");

process.env.ANTHROPIC_API_KEY = "sk-test";
ok((await call(good, {method: "GET"})).code === 405, "GET is refused");

let r = await call(good);
ok(r.code === 200 && r.data.correction.better === "I completed my BCom last year", "returns reply and correction");
ok(sent.url === "https://api.anthropic.com/v1/messages" && sent.opts.headers["x-api-key"] === "sk-test", "key used only on the server call");
ok(!JSON.stringify(r.data).includes("sk-test"), "key never returned to the browser");
ok(sent.body.model === "claude-haiku-5-5" && sent.body.messages.length === 1 && sent.body.messages[0].role === "user", "leading tutor opener dropped; conversation starts with the learner");
ok(sent.body.system[0].text.includes("Tell me about yourself") && sent.body.system[0].text.includes("Hindi"), "prompt built on the server from the situation");

r = await call({...good, history: [{role: "assistant", content: "x"}, {role: "user", content: "a"}, {role: "assistant", content: "b"}, {role: "user", content: "c"}]});
ok(sent.body.messages.map(m => m.role).join(",") === "user,assistant,user", "history trimmed to alternate and end before the new answer: " + sent.body.messages.map(m => m.role).join(","));

ok((await call({...good, scenario: "hack"})).code === 400, "unknown situation refused");
ok((await call({...good, lang: "French"})).code === 400, "unknown language refused");
ok((await call({...good, said: "x".repeat(401)})).code === 400, "over-long answer refused");
ok((await call({...good, said: ""})).code === 400, "empty answer refused");
ok(validate({...good, history: [{role: "system", content: "x"}]}).ok === false, "system role in history refused");

process.env.ACCESS_CODE = "BOLO26";
r = await call(good);
ok(r.code === 401 && r.data.needCode === true, "class code required when set");
ok((await call({...good, code: "BOLO26"})).code === 200, "correct class code accepted");
delete process.env.ACCESS_CODE;

process.env.RATE_LIMIT = "3";
const codes = [];
for (let i = 0; i < 4; i++) codes.push((await call(good, {ip: "9.9.9.9"})).code);
ok(codes.join(",") === "200,200,200,429", "rate limit per device: " + codes.join(","));
delete process.env.RATE_LIMIT;

// The page's situation list must match the server's.
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const pageList = html.match(/const SCENARIOS = (\[[\s\S]*?\n\]);/)[1];
const pageScenarios = Function("return " + pageList)();
ok(JSON.stringify(pageScenarios) === JSON.stringify(SCENARIOS), "page and server situations identical");
ok(!/x-api-key|anthropic\.com/.test(html), "page holds no key and never calls Anthropic directly");

console.log(failed ? `${failed} failed` : "ALL PASS");
process.exit(failed ? 1 : 0);
