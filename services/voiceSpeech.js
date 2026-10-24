// ResQNow-Thozhan's voice. Phones read Tamil with flat, robotic voices, so the app asks a speech
// service for a natural, human-sounding one instead: Sarvam's Bulbul (made for Indian languages)
// or Google's Chirp 3 HD. Only what Thozhan says is sent, never what the customer says. Most lines
// are the same for every customer ("எந்த டயர்?"), so each one is made once and kept in memory.

const SARVAM_URL = "https://api.sarvam.ai/text-to-speech";
const GOOGLE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const MAX_TEXT = 500;
const LANGS = new Set(["ta-IN", "en-IN"]);

/** The voices used when none is set: one man's voice ("Thozhan" is a male friend) for Tamil and English alike. */
export const DEFAULT_VOICES = {
  sarvam: { "ta-IN": "rohan", "en-IN": "rohan" },
  google: { "ta-IN": "ta-IN-Chirp3-HD-Charon", "en-IN": "en-IN-Chirp3-HD-Charon" },
};

export class VoiceSpeechError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const clean = (value) => String(value ?? "").trim();

/**
 * SARVAM_API_KEY or GOOGLE_TTS_API_KEY switches the natural voice on (Sarvam first when both are
 * set, or choose with VOICE_TTS_PROVIDER=sarvam|google; "off" keeps the phone's own voice).
 * VOICE_TTS_VOICE_TA / VOICE_TTS_VOICE_EN pick other voices, VOICE_TTS_PACE the speed (0.8 to 1.2).
 */
export function speechConfig(env = process.env) {
  const keys = { sarvam: clean(env.SARVAM_API_KEY), google: clean(env.GOOGLE_TTS_API_KEY) };
  const choice = clean(env.VOICE_TTS_PROVIDER).toLowerCase();
  let provider = null;
  if (choice === "sarvam" || choice === "google") provider = keys[choice] ? choice : null;
  else if (choice !== "off") provider = keys.sarvam ? "sarvam" : keys.google ? "google" : null;
  const pace = Number(env.VOICE_TTS_PACE);
  return {
    provider,
    apiKey: provider ? keys[provider] : "",
    voices: provider ? {
      "ta-IN": clean(env.VOICE_TTS_VOICE_TA) || DEFAULT_VOICES[provider]["ta-IN"],
      "en-IN": clean(env.VOICE_TTS_VOICE_EN) || DEFAULT_VOICES[provider]["en-IN"],
    } : {},
    pace: Number.isFinite(pace) && pace > 0 ? Math.min(1.2, Math.max(0.8, pace)) : 1,
    timeoutMs: Number(env.VOICE_TTS_TIMEOUT_MS) || 6000,
  };
}

/** A line to say: the words, and Tamil or Indian English. */
export function sanitizeSpeech(body) {
  const raw = body && typeof body === "object" ? body : {};
  const text = String(raw.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new VoiceSpeechError("text is required", 400);
  if (text.length > MAX_TEXT) throw new VoiceSpeechError(`text is longer than ${MAX_TEXT} characters`, 400);
  const lang = clean(raw.lang);
  if (!LANGS.has(lang)) throw new VoiceSpeechError("lang must be ta-IN or en-IN", 400);
  return { text, lang };
}

async function askSarvam({ text, lang, voice, pace, apiKey, fetchImpl, signal }) {
  const response = await fetchImpl(SARVAM_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "api-subscription-key": apiKey },
    body: JSON.stringify({
      text,
      language_code: lang,
      model: "bulbul:v3",
      speaker: voice,
      pace,
      // A little warmth for a friend's voice; the default (0.6) is read-the-news steady.
      temperature: 0.7,
      speech_sample_rate: 24000,
      output_audio_codec: "mp3",
    }),
    signal,
  });
  if (!response.ok) throw new VoiceSpeechError(`Sarvam voice failed (${response.status})`, 502);
  const data = await response.json();
  const audio = Array.isArray(data?.audios) ? data.audios[0] : null;
  if (!audio) throw new VoiceSpeechError("Sarvam voice returned no audio", 502);
  return Buffer.from(audio, "base64");
}

async function askGoogle({ text, lang, voice, pace, apiKey, fetchImpl, signal }) {
  const response = await fetchImpl(GOOGLE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lang, name: voice },
      audioConfig: { audioEncoding: "MP3", speakingRate: pace },
    }),
    signal,
  });
  if (!response.ok) throw new VoiceSpeechError(`Google voice failed (${response.status})`, 502);
  const data = await response.json();
  if (!data?.audioContent) throw new VoiceSpeechError("Google voice returned no audio", 502);
  return Buffer.from(data.audioContent, "base64");
}

/**
 * Makes a line's audio (MP3). Lines already made are served from memory, oldest dropped first
 * once the store passes `cacheBytes`; a line asked for twice at once is made once.
 */
export function createVoiceSpeech({ provider, apiKey, voices = {}, pace = 1, timeoutMs = 6000, fetchImpl = globalThis.fetch, cacheBytes = 40 * 1024 * 1024 } = {}) {
  const made = new Map();
  const making = new Map();
  let stored = 0;

  const remember = (key, audio) => {
    made.set(key, audio);
    stored += audio.length;
    for (const [oldKey, oldAudio] of made) {
      if (stored <= cacheBytes) break;
      made.delete(oldKey);
      stored -= oldAudio.length;
    }
  };

  async function make(text, lang) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const ask = provider === "sarvam" ? askSarvam : askGoogle;
      const audio = await ask({ text, lang, voice: voices[lang], pace, apiKey, fetchImpl, signal: controller.signal });
      if (!audio.length) throw new VoiceSpeechError("The voice returned no audio", 502);
      return audio;
    } catch (error) {
      if (error?.name === "AbortError") throw new VoiceSpeechError("The voice timed out", 504);
      throw error instanceof VoiceSpeechError ? error : new VoiceSpeechError("The voice is unavailable", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled: Boolean(provider && apiKey),
    provider,
    async speak({ text, lang }) {
      if (!provider || !apiKey) throw new VoiceSpeechError("The natural voice is not set up", 503);
      const key = `${lang}|${voices[lang]}|${pace}|${text}`;
      const ready = made.get(key);
      if (ready) {
        // Seen again: move it to the back of the queue so busy lines stay.
        made.delete(key);
        made.set(key, ready);
        return { audio: ready, contentType: "audio/mpeg", cached: true };
      }
      if (!making.has(key)) {
        making.set(key, make(text, lang).then((audio) => { remember(key, audio); return audio; }).finally(() => making.delete(key)));
      }
      return { audio: await making.get(key), contentType: "audio/mpeg", cached: false };
    },
  };
}
