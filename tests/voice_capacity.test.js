import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceSpeech, speechConfig } from "../services/voiceSpeech.js";
import { createVoiceUnderstanding, sanitizeVoiceContext } from "../services/voiceUnderstanding.js";

test("a burst of distinct voice replies falls back while cached or identical lines stay available", async () => {
  let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const speech = createVoiceSpeech({
    ...speechConfig({ SARVAM_API_KEY: "test" }), maxConcurrent: 1,
    fetchImpl: async () => { calls++; await held; return { ok: true, json: async () => ({ audios: ["SUQz"] }) }; },
  });
  const first = { text: "a", lang: "ta-IN" };
  const all = [speech.speak(first), speech.speak(first), speech.speak({ ...first, text: "b" })];
  release();
  const results = await Promise.allSettled(all);
  assert.equal(calls, 1);
  assert.deepEqual(results.map(item => item.status), ["fulfilled", "fulfilled", "rejected"]);
  assert.equal(results[2].reason.status, 503);
  assert.equal((await speech.speak(first)).cached, true);
  await speech.speak({ ...first, text: "c" });
});

test("interpretation capacity recovers after provider failure and rejects excess work promptly", async () => {
  let fail;
  const held = new Promise((_resolve, reject) => { fail = reject; });
  let calls = 0;
  const ai = createVoiceUnderstanding({ apiKey: "test", maxConcurrent: 1, fetchImpl: async () => {
    if (++calls === 1) return held;
    return { ok: true, json: async () => ({ content: [] }) };
  } });
  const ctx = sanitizeVoiceContext({ text: "help", services: ["sos"], families: ["car"] });
  const first = ai.understand(ctx);
  const excess = ai.understand(ctx);
  fail(Error("provider down"));
  const results = await Promise.allSettled([first, excess]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.status, 503);
  assert.deepEqual(await ai.understand(ctx), {});
});

test("a 2000-request provider burst stays bounded and accepts fresh work after overload", async () => {
  let active = 0, peak = 0;
  const ai = createVoiceUnderstanding({ apiKey: "test", maxConcurrent: 16, fetchImpl: async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    return { ok: true, json: async () => ({ content: [] }) };
  } });
  const ctx = sanitizeVoiceContext({ text: "help", services: ["sos"], families: ["car"] });
  const results = await Promise.allSettled(Array.from({ length: 2000 }, () => ai.understand(ctx)));
  assert.equal(peak, 16);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 16);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.status === 503).length, 1984);
  assert.deepEqual(await ai.understand(ctx), {});
});
