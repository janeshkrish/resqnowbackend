import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createVoiceRouter } from "../routes/voice.js";
import { sanitizeRequestDetails } from "../services/requestDetails.js";
import {
  VoiceAiError, cleanResult, createVoiceUnderstanding, sanitizeVoiceContext, voiceConfig, voiceEnabledFor,
} from "../services/voiceUnderstanding.js";

const CONTEXT = {
  text: "Ennoda Honda Shine puncture aayiduchu, tubeless, pinnadi tyre",
  lang: "tg",
  services: [{ id: "flat-tire", title: "Puncture" }, { id: "towing", title: "Towing" }],
  families: ["bike", "car", "commercial", "ev"],
  service: "flat-tire",
  family: null,
  questions: [
    { id: "tyretype", label: "Tyre type", multi: false, options: [{ v: "tubeless", label: "Tubeless" }, { v: "tube", label: "Tube tyre" }, { v: "dk", label: "Not sure" }] },
    { id: "tyre", label: "Which tyre is flat?", multi: true, options: [{ v: "rear", label: "Back tyre" }, { v: "front", label: "Front tyre" }] },
  ],
};

const toolReply = (input) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "fill_request", input }] }) });

test("voice is on for everyone by default, off when switched off, and limited to listed customers", () => {
  assert.equal(voiceEnabledFor(voiceConfig({}), 41), true);
  assert.equal(voiceEnabledFor(voiceConfig({ VOICE_THOZHAN: "off" }), 41), false);
  const some = voiceConfig({ VOICE_THOZHAN: "41, 52" });
  assert.equal(voiceEnabledFor(some, 41), true);
  assert.equal(voiceEnabledFor(some, 7), false);
  assert.equal(voiceConfig({}).apiKey, "");
  assert.equal(voiceConfig({}).model, "claude-haiku-5-5");
});

test("the app's request is trimmed and checked before it reaches the model", () => {
  const ctx = sanitizeVoiceContext({ ...CONTEXT, text: "  x ".repeat(300), service: "not-a-service", questions: [...CONTEXT.questions, { id: "bad id!", options: [{ v: "x" }] }] });
  assert.ok(ctx.text.length <= 400);
  assert.equal(ctx.service, null);
  assert.deepEqual(ctx.services, ["flat-tire", "towing"]);
  assert.equal(ctx.questions.length, 2);
  assert.throws(() => sanitizeVoiceContext({ ...CONTEXT, text: "  " }), VoiceAiError);
  assert.throws(() => sanitizeVoiceContext({ text: "hi" }), VoiceAiError);
});

test("only values the form allows come back", () => {
  const ctx = sanitizeVoiceContext(CONTEXT);
  const out = cleanResult({
    service: "flat-tire", family: "bike", brand: "Honda", model: "Shine",
    answers: { tyretype: "tubeless", tyre: ["rear", "spare-wheel"], made_up: "x" }, landmark: "near the bus stop", extra: "ignored",
  }, ctx);
  assert.deepEqual(out, { service: "flat-tire", family: "bike", brand: "Honda", model: "Shine", landmark: "near the bus stop", answers: { tyretype: "tubeless", tyre: ["rear"] } });
  assert.deepEqual(cleanResult({ service: "flying", family: "boat", answers: { tyretype: "square" } }, ctx), {});
});

test("asks the model with the form's choices and returns its checked reading", async () => {
  const calls = [];
  const ai = createVoiceUnderstanding({
    apiKey: "test-key", model: "claude-haiku-5-5",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return toolReply({ service: "flat-tire", family: "bike", brand: "Honda", model: "Shine", answers: { tyretype: "tubeless", tyre: ["rear"] } }); },
  });
  const result = await ai.understand(sanitizeVoiceContext(CONTEXT));
  assert.deepEqual(result, { service: "flat-tire", family: "bike", brand: "Honda", model: "Shine", answers: { tyretype: "tubeless", tyre: ["rear"] } });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "fill_request" });
  assert.match(body.messages[0].content, /Ennoda Honda Shine puncture/);
  assert.match(body.messages[0].content, /tyre \(multi\): Which tyre is flat\? Options: rear = Back tyre; front = Front tyre/);
});

test("without a key, a failed call or a slow model, the app falls back to its own words", async () => {
  await assert.rejects(createVoiceUnderstanding({}).understand(sanitizeVoiceContext(CONTEXT)), (e) => e.status === 503);
  const failing = createVoiceUnderstanding({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 529, json: async () => ({}) }) });
  await assert.rejects(failing.understand(sanitizeVoiceContext(CONTEXT)), (e) => e.status === 502);
  const slow = createVoiceUnderstanding({
    apiKey: "k", timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  await assert.rejects(slow.understand(sanitizeVoiceContext(CONTEXT)), (e) => e.status === 504);
});

async function serve(options) {
  const app = express();
  app.use(express.json());
  app.use("/api/voice", createVoiceRouter({ auth: (req, _res, next) => { req.user = { userId: 41 }; next(); }, ...options }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/voice`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("GET /api/voice/status tells the app whether voice and the AI step are on", async () => {
  const on = await serve({ config: voiceConfig({}), understanding: { enabled: true, understand: async () => ({}) }, speech: { enabled: true } });
  assert.deepEqual(await (await fetch(`${on.base}/status`)).json(), { enabled: true, ai: true, voice: true });
  await on.close();
  const off = await serve({ config: voiceConfig({ VOICE_THOZHAN: "off" }), understanding: { enabled: true, understand: async () => ({}) }, speech: { enabled: true } });
  assert.deepEqual(await (await fetch(`${off.base}/status`)).json(), { enabled: false, ai: false, voice: false });
  await off.close();
});

test("POST /api/voice/understand returns the checked reading, and refuses when off, unset or malformed", async () => {
  const seen = [];
  const app = await serve({ config: voiceConfig({}), understanding: { enabled: true, understand: async (ctx) => { seen.push(ctx); return { service: "flat-tire" }; } } });
  const post = (body) => fetch(`${app.base}/understand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = await post(CONTEXT);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { result: { service: "flat-tire" } });
  assert.equal(seen[0].text, CONTEXT.text);
  assert.equal((await post({ text: "" })).status, 400);
  await app.close();

  const unset = await serve({ config: voiceConfig({}), understanding: { enabled: false, understand: async () => ({}) } });
  const res = await fetch(`${unset.base}/understand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(CONTEXT) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ai, false);
  await unset.close();

  const off = await serve({ config: voiceConfig({ VOICE_THOZHAN: "7" }), understanding: { enabled: true, understand: async () => ({}) } });
  assert.equal((await fetch(`${off.base}/understand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(CONTEXT) })).status, 403);
  await off.close();
});

test("a voice request is marked as one in its details; a form request is not", () => {
  const answers = [{ id: "tyretype", question: "Tyre type", value: "tubeless", label: "Tubeless" }];
  assert.equal(sanitizeRequestDetails({ answers, channel: "voice" }).channel, "voice");
  assert.equal(sanitizeRequestDetails({ answers }).channel, undefined);
  assert.equal(sanitizeRequestDetails({ answers, channel: "carrier-pigeon" }).channel, undefined);
});
