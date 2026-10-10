// Offline tests for the server function. No real Anthropic call is made.
import handler, {SCENARIOS, validate, parseReply, finishedField, codeAccepted, MAX_TOKENS} from "./api/tutor.js";
import fs from "node:fs";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS: " : "FAIL: ") + m); if (!c) failed++; };

// Fake response object: collects JSON or streamed lines.
function call(body, {ip = "1.1.1.1", method = "POST"} = {}) {
  return new Promise(resolve => {
    const res = {code: 200, headers: {}, lines: [], writeAt: [],
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(d) { resolve({code: this.code, data: d, headers: this.headers}); return this; },
      write(s) { this.lines.push(JSON.parse(s)); this.writeAt.push(chunksSent); },
      end() { resolve({code: this.code, lines: this.lines, writeAt: this.writeAt, headers: this.headers}); }};
    handler({method, body, headers: {"x-forwarded-for": ip}}, res);
  });
}

// Fake Anthropic streaming endpoint: sends the model text in small chunks as server-sent events.
let sent = null, calls = 0, chunksSent = 0, modelText = "", failMidway = false, upstreamStatus = 200;
const reply = {better: "I completed my BCom last year", reply: "Good. What work do you do?", good: "Clear answer.",
  said: "I am completed", tip: "\"I completed\" बोलें।", type: "tense"};
globalThis.fetch = async (url, opts) => {
  calls++; sent = {url, opts, body: JSON.parse(opts.body)}; chunksSent = 0;
  if (upstreamStatus !== 200) return {ok: false, status: upstreamStatus, text: async () => "overloaded"};
  const pieces = modelText.match(/[\s\S]{1,6}/g) || [];
  const enc = new TextEncoder();
  const events = [`event: message_start\ndata: {"type":"message_start"}\n\n`,
    ...pieces.map(p => `event: content_block_delta\ndata: ${JSON.stringify({type: "content_block_delta", index: 0, delta: {type: "text_delta", text: p}})}\n\n`),
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`];
  if (failMidway) events.splice(4, events.length, `event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n`);
  let i = 0;
  const body = new ReadableStream({pull(c) {
    if (i < events.length) { chunksSent = i; c.enqueue(enc.encode(events[i++])); } else c.close();
  }});
  return {ok: true, status: 200, body};
};

const good = {scenario: "intro", lang: "Hindi", level: "A2", said: "I am completed my BCom",
  history: [{role: "assistant", content: SCENARIOS[0].opener}]};

// ---- set-up and plain checks
delete process.env.ANTHROPIC_API_KEY;
modelText = JSON.stringify(reply);
ok((await call(good)).code === 500, "refuses to run without the owner's key");
process.env.ANTHROPIC_API_KEY = "sk-test";

let r = await call(null, {method: "GET"});
ok(r.code === 200 && r.data.needCode === false, "GET answers at once (wakes the server) and says no code is needed");
ok((await call(good, {method: "PUT"})).code === 405, "other methods refused");

// ---- streaming
calls = 0;
r = await call(good);
const kinds = r.lines.map(l => Object.keys(l)[0]).join(",");
ok(r.code === 200 && kinds === "better,reply,done", "streams better, then reply, then done: " + kinds);
ok(r.headers["Content-Type"].startsWith("application/x-ndjson"), "streamed as NDJSON");
const totalChunks = Math.ceil(modelText.length / 6) + 1;
ok(r.writeAt[0] < totalChunks / 2, `corrected sentence sent early (after chunk ${r.writeAt[0]} of ${totalChunks})`);
ok(r.writeAt[1] < totalChunks - 3, `reply sent before the tip is finished (after chunk ${r.writeAt[1]} of ${totalChunks})`);
ok(r.lines[0].better === reply.better && r.lines[1].reply === reply.reply, "early pieces match the model's text");
const done = r.lines[2].done;
ok(done.correction.better === reply.better && done.correction.tip === reply.tip && done.good === reply.good, "final answer complete, with the Hindi tip");
ok(sent.body.stream === true && sent.body.max_tokens === MAX_TOKENS && MAX_TOKENS === 300, "Claude called with streaming and max_tokens 300");
ok(sent.url === "https://api.anthropic.com/v1/messages" && sent.opts.headers["x-api-key"] === "sk-test", "key used only on the server call");
ok(!JSON.stringify(r.lines).includes("sk-test"), "key never returned to the browser");
ok(sent.body.model === "claude-haiku-5-5" && sent.body.messages.length === 1 && sent.body.messages[0].role === "user", "leading tutor opener dropped; conversation starts with the learner");
ok(sent.body.system[0].text.includes("Tell me about yourself") && sent.body.system[0].text.includes("Hindi"), "prompt built on the server from the situation");
ok(/"better".*"reply".*"good".*"said".*"tip".*"type"/.test(sent.body.system[0].text), "prompt asks for the fast key order");

modelText = JSON.stringify({...reply, better: "", said: "", tip: "", type: ""});
r = await call(good);
ok(r.lines[0].better === "" && r.lines[1].reply === reply.reply && r.lines[2].done.correction === null, "no mistake: empty better, reply streamed, no correction");

modelText = "Nice. Where do you work now?";
r = await call(good);
ok(r.lines.at(-1).done?.reply === "Nice. Where do you work now?" && r.lines.at(-1).done.correction === null, "plain-text answer still used as the reply");

failMidway = true; modelText = JSON.stringify(reply);
r = await call(good);
ok(r.lines.at(-1).error && !r.lines.some(l => l.done), "error mid-stream reported as an error line");
failMidway = false;

upstreamStatus = 529;
r = await call(good);
ok(r.code === 502 && r.data.error, "Claude failure before streaming gives a clear 502");
upstreamStatus = 200;

// ---- helpers
ok(finishedField('{"better":"I wen', "better") === null && finishedField('{"better":"I \\"went\\" home","re', "better") === 'I "went" home', "field read only once its closing quote arrives");
ok(parseReply(JSON.stringify({reply: "Hi", good: "", correction: {said: "a", better: "b", tip: "c", type: "tense"}})).correction.better === "b", "older nested format still read");

// ---- input checks
r = await call({...good, history: [{role: "assistant", content: "x"}, {role: "user", content: "a"}, {role: "assistant", content: "b"}, {role: "user", content: "c"}]});
ok(sent.body.messages.map(m => m.role).join(",") === "user,assistant,user", "history trimmed to alternate and end before the new answer: " + sent.body.messages.map(m => m.role).join(","));
ok((await call({...good, scenario: "hack"})).code === 400, "unknown situation refused");
ok((await call({...good, lang: "French"})).code === 400, "unknown language refused");
ok((await call({...good, said: "x".repeat(401)})).code === 400, "over-long answer refused");
ok((await call({...good, said: ""})).code === 400, "empty answer refused");
ok(validate({...good, history: [{role: "system", content: "x"}]}).ok === false, "system role in history refused");

// ---- class code
process.env.ACCESS_CODE = "BOLO26";
r = await call(null, {method: "GET"});
ok(r.data.needCode === true, "GET tells the page a class code is needed");
r = await call(good);
ok(r.code === 401 && r.data.needCode === true, "class code required when set");
ok((await call({...good, code: "BOLO26"})).code === 200, "exact class code accepted");
ok((await call({...good, code: " bolo26 "})).code === 200, "class code accepted in small letters with spaces (phone keyboards)");
ok((await call({...good, code: "Bolo26"})).code === 200, "class code accepted with a capital first letter (phone auto-capitals)");
ok((await call({...good, code: "BOLO27"})).code === 401, "wrong class code refused");
calls = 0;
r = await call({check: true, code: "bolo26"});
ok(r.code === 200 && r.data.codeOk === true && calls === 0, "code check answers without calling Claude");
ok((await call({check: true, code: "nope"})).code === 401, "code check refuses a wrong code");
delete process.env.ACCESS_CODE;

ok(codeAccepted("Mumbai", {Access_code: "mumbai"}), "code in the variable named Access_code also works");
ok(codeAccepted("batch2", {ACCESS_CODE: "Batch1, Batch2"}) && !codeAccepted("batch3", {ACCESS_CODE: "Batch1, Batch2"}), "several codes separated by commas");
ok(codeAccepted("anything", {}), "no code set: open to all");

// ---- spend protection
process.env.RATE_LIMIT = "3";
const codes = [];
for (let i = 0; i < 4; i++) codes.push((await call(good, {ip: "9.9.9.9"})).code);
ok(codes.join(",") === "200,200,200,429", "rate limit per device: " + codes.join(","));
const guesses = [];
process.env.ACCESS_CODE = "secret";
for (let i = 0; i < 4; i++) guesses.push((await call({check: true, code: "guess" + i}, {ip: "8.8.8.8"})).code);
ok(guesses.join(",") === "401,401,401,429", "code guessing is rate-limited too: " + guesses.join(","));
delete process.env.ACCESS_CODE; delete process.env.RATE_LIMIT;

// ---- page
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const pageList = html.match(/const SCENARIOS = (\[[\s\S]*?\n\]);/)[1];
ok(JSON.stringify(Function("return " + pageList)()) === JSON.stringify(SCENARIOS), "page and server situations identical");
ok(!/x-api-key|anthropic\.com/.test(html), "page holds no key and never calls Anthropic directly");
ok(/id="code"[^>]*autocapitalize="none"/.test(html), "code box turns off phone auto-capitals");

console.log(failed ? `${failed} failed` : "ALL PASS");
process.exit(failed ? 1 : 0);
