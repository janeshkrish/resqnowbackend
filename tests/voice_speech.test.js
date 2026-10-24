import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createVoiceRouter } from "../routes/voice.js";
import { DEFAULT_VOICES, VoiceSpeechError, createVoiceSpeech, sanitizeSpeech, speechConfig } from "../services/voiceSpeech.js";
import { voiceConfig } from "../services/voiceUnderstanding.js";

const LINE = { text: "அய்யோ, பஞ்சரா! உங்க பைக்குக்கு பஞ்சர் நோட் பண்ணிட்டேன்.", lang: "ta-IN" };
const MP3 = Buffer.from("ID3-fake-mp3-bytes");
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test("a voice key switches the natural voice on; Sarvam first, or the one chosen", () => {
  assert.equal(speechConfig({}).provider, null);
  assert.equal(speechConfig({ SARVAM_API_KEY: "s" }).provider, "sarvam");
  assert.equal(speechConfig({ GOOGLE_TTS_API_KEY: "g" }).provider, "google");
  assert.equal(speechConfig({ SARVAM_API_KEY: "s", GOOGLE_TTS_API_KEY: "g" }).provider, "sarvam");
  assert.equal(speechConfig({ SARVAM_API_KEY: "s", GOOGLE_TTS_API_KEY: "g", VOICE_TTS_PROVIDER: "google" }).apiKey, "g");
  assert.equal(speechConfig({ SARVAM_API_KEY: "s", VOICE_TTS_PROVIDER: "off" }).provider, null);
  // Choosing a service without its key keeps the phone's voice rather than failing every line.
  assert.equal(speechConfig({ SARVAM_API_KEY: "s", VOICE_TTS_PROVIDER: "google" }).provider, null);
  assert.deepEqual(speechConfig({ SARVAM_API_KEY: "s" }).voices, DEFAULT_VOICES.sarvam);
  assert.equal(speechConfig({ GOOGLE_TTS_API_KEY: "g", VOICE_TTS_VOICE_TA: "ta-IN-Chirp3-HD-Puck" }).voices["ta-IN"], "ta-IN-Chirp3-HD-Puck");
  assert.equal(speechConfig({ SARVAM_API_KEY: "s", VOICE_TTS_PACE: "3" }).pace, 1.2);
  assert.equal(speechConfig({ SARVAM_API_KEY: "s", VOICE_TTS_PACE: "nonsense" }).pace, 1);
});

test("only a short line in Tamil or Indian English is accepted", () => {
  assert.deepEqual(sanitizeSpeech({ text: "  Endha   tyre? ", lang: "en-IN" }), { text: "Endha tyre?", lang: "en-IN" });
  assert.throws(() => sanitizeSpeech({ text: "", lang: "ta-IN" }), VoiceSpeechError);
  assert.throws(() => sanitizeSpeech({ text: "x".repeat(501), lang: "ta-IN" }), VoiceSpeechError);
  assert.throws(() => sanitizeSpeech({ text: "hello", lang: "fr-FR" }), VoiceSpeechError);
});

test("asks Sarvam's Bulbul for the line in Tamil, as MP3, with the chosen voice", async () => {
  const calls = [];
  const speech = createVoiceSpeech({
    ...speechConfig({ SARVAM_API_KEY: "sarvam-test-key" }),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return ok({ audios: [MP3.toString("base64")] }); },
  });
  assert.equal(speech.enabled, true);
  const { audio, contentType } = await speech.speak(LINE);
  assert.deepEqual(audio, MP3);
  assert.equal(contentType, "audio/mpeg");
  assert.equal(calls[0].url, "https://api.sarvam.ai/text-to-speech");
  assert.equal(calls[0].init.headers["api-subscription-key"], "sarvam-test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, LINE.text);
  assert.equal(body.language_code, "ta-IN");
  assert.equal(body.model, "bulbul:v3");
  assert.equal(body.speaker, "rohan");
  assert.equal(body.output_audio_codec, "mp3");
});

test("asks Google's Chirp 3 HD voice with the key in a header, not the address", async () => {
  const calls = [];
  const speech = createVoiceSpeech({
    ...speechConfig({ GOOGLE_TTS_API_KEY: "google-test-key" }),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return ok({ audioContent: MP3.toString("base64") }); },
  });
  const { audio } = await speech.speak({ text: "Which tyre is flat?", lang: "en-IN" });
  assert.deepEqual(audio, MP3);
  assert.equal(calls[0].url, "https://texttospeech.googleapis.com/v1/text:synthesize");
  assert.ok(!calls[0].url.includes("google-test-key"));
  assert.equal(calls[0].init.headers["x-goog-api-key"], "google-test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.voice, { languageCode: "en-IN", name: "en-IN-Chirp3-HD-Charon" });
  assert.equal(body.audioConfig.audioEncoding, "MP3");
});

test("each line is made once: repeats and lines asked for at the same time share it", async () => {
  let calls = 0;
  const speech = createVoiceSpeech({
    ...speechConfig({ SARVAM_API_KEY: "k" }),
    fetchImpl: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return ok({ audios: [MP3.toString("base64")] }); },
  });
  const [a, b] = await Promise.all([speech.speak(LINE), speech.speak(LINE)]);
  assert.deepEqual(a.audio, b.audio);
  assert.equal((await speech.speak(LINE)).cached, true);
  assert.equal(calls, 1);
  await speech.speak({ ...LINE, lang: "en-IN" });
  assert.equal(calls, 2);
});

test("the memory store drops the oldest lines when full", async () => {
  let calls = 0;
  const speech = createVoiceSpeech({
    ...speechConfig({ SARVAM_API_KEY: "k" }),
    cacheBytes: MP3.length * 2,
    fetchImpl: async () => { calls += 1; return ok({ audios: [MP3.toString("base64")] }); },
  });
  for (const text of ["one", "two", "three"]) await speech.speak({ text, lang: "ta-IN" });
  assert.equal((await speech.speak({ text: "three", lang: "ta-IN" })).cached, true);
  assert.equal((await speech.speak({ text: "one", lang: "ta-IN" })).cached, false);
  assert.equal(calls, 4);
});

test("a failed or slow voice is an error the app answers with the phone's own voice", async () => {
  const failing = createVoiceSpeech({ ...speechConfig({ SARVAM_API_KEY: "k" }), fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  await assert.rejects(failing.speak(LINE), (error) => error instanceof VoiceSpeechError && error.status === 502);
  const empty = createVoiceSpeech({ ...speechConfig({ GOOGLE_TTS_API_KEY: "k" }), fetchImpl: async () => ok({}) });
  await assert.rejects(empty.speak(LINE), VoiceSpeechError);
  const slow = createVoiceSpeech({
    ...speechConfig({ SARVAM_API_KEY: "k" }), timeoutMs: 30,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  await assert.rejects(slow.speak(LINE), (error) => error.status === 504);
  const unset = createVoiceSpeech(speechConfig({}));
  assert.equal(unset.enabled, false);
  await assert.rejects(unset.speak(LINE), (error) => error.status === 503);
});

async function serve(options) {
  const app = express();
  app.use(express.json());
  app.use("/api/voice", createVoiceRouter({ auth: (req, _res, next) => { req.user = { userId: 41 }; next(); }, understanding: { enabled: false }, ...options }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/voice`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}
const post = (base, body) => fetch(`${base}/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("POST /api/voice/speak sends the line's audio back as MP3", async () => {
  const seen = [];
  const app = await serve({ config: voiceConfig({}), speech: { enabled: true, speak: async (line) => { seen.push(line); return { audio: MP3, contentType: "audio/mpeg" }; } } });
  const res = await post(app.base, { text: "  எந்த டயர்?  ", lang: "ta-IN" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);
  assert.deepEqual(seen, [{ text: "எந்த டயர்?", lang: "ta-IN" }]);
  assert.equal((await post(app.base, { text: "hi", lang: "xx" })).status, 400);
  await app.close();
});

test("POST /api/voice/speak refuses when voice is off, or no voice key is set, or the voice fails", async () => {
  const off = await serve({ config: voiceConfig({ VOICE_THOZHAN: "off" }), speech: { enabled: true, speak: async () => ({ audio: MP3, contentType: "audio/mpeg" }) } });
  assert.equal((await post(off.base, LINE)).status, 403);
  await off.close();
  const unset = await serve({ config: voiceConfig({}), speech: createVoiceSpeech(speechConfig({})) });
  const res = await post(unset.base, LINE);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "The natural voice is not set up.", voice: false });
  await unset.close();
  const broken = await serve({ config: voiceConfig({}), speech: { enabled: true, speak: async () => { throw new VoiceSpeechError("Sarvam voice failed (500)", 502); } } });
  assert.equal((await post(broken.base, LINE)).status, 502);
  await broken.close();
});
