// ResQNow-Thozhan's AI step. The app understands most sentences on the phone with its own word
// lists; only the ones it can't fully read come here. A small Claude model turns the words into
// the request form's own fields, and every value it returns is checked against the form's ids and
// options before it goes back. Nothing the customer says is stored or logged.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_TEXT = 400;
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 16;
const ID = /^[a-z0-9_-]{1,40}$/i;

export class VoiceAiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * VOICE_THOZHAN: "all" (default), "off", or a comma-separated list of customer ids for a gradual
 * launch. ANTHROPIC_API_KEY switches the AI step on; without it the app still works on its own words.
 */
export function voiceConfig(env = process.env) {
  const mode = String(env.VOICE_THOZHAN ?? "all").trim().toLowerCase();
  const allow = mode === "off" ? null : mode === "" || mode === "all" ? "all" : new Set(mode.split(",").map((id) => id.trim()).filter(Boolean));
  return {
    allow,
    apiKey: String(env.ANTHROPIC_API_KEY || "").trim(),
    model: String(env.VOICE_AI_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: Number(env.VOICE_AI_TIMEOUT_MS) || 3500,
  };
}

export function voiceEnabledFor(config, userId) {
  if (!config.allow) return false;
  if (config.allow === "all") return true;
  return config.allow.has(String(userId));
}

const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const ids = (list, max) => (Array.isArray(list) ? list : []).map((v) => text(typeof v === "object" ? v?.id : v, 40)).filter((v) => ID.test(v)).slice(0, max);

/** The app's request, trimmed and checked: the words, and the form's services, vehicle types and questions to choose from. */
export function sanitizeVoiceContext(body) {
  const raw = body && typeof body === "object" ? body : {};
  const words = text(raw.text, MAX_TEXT);
  if (!words) throw new VoiceAiError("text is required", 400);
  const services = ids(raw.services, 20);
  const families = ids(raw.families, 8);
  if (!services.length || !families.length) throw new VoiceAiError("services and families are required", 400);
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, MAX_QUESTIONS).map((q) => ({
    id: text(q?.id, 40),
    label: text(q?.label, 120),
    multi: q?.multi === true,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, MAX_OPTIONS)
      .map((o) => ({ v: text(o?.v, 40), label: text(o?.label, 80) }))
      .filter((o) => ID.test(o.v)),
  })).filter((q) => ID.test(q.id) && q.options.length);
  const service = services.includes(text(raw.service, 40)) ? text(raw.service, 40) : null;
  const family = families.includes(text(raw.family, 20)) ? text(raw.family, 20) : null;
  return { text: words, lang: ["en", "tg", "ta"].includes(raw.lang) ? raw.lang : null, services, families, questions, service, family, asking: text(raw.asking, 40) || null };
}

const SYSTEM = [
  "You read what a stranded driver in Tamil Nadu says to a roadside-assistance app and fill in its service request form.",
  "They speak Tamil, Tanglish (Tamil in English letters) or English, often mixed. 'vandi' and 'vaaganam' mean a vehicle without saying which kind.",
  "Fill only what their words clearly say. Leave a field out when it is not said; never guess.",
  "Use only the service ids, vehicle types, question ids and option values given in the message.",
  "brand and model are the vehicle's maker and model as said (for example Honda and Shine, or Tata and Ace).",
  "answers maps a question id to one option value, or to a list of values for a question marked multi.",
  "landmark is a nearby place they mention to help find them; drop is where they want a towed vehicle taken.",
].join(" ");

const TOOL = {
  name: "fill_request",
  description: "Record what the customer said, using only the ids and option values listed in the message.",
  input_schema: {
    type: "object",
    properties: {
      service: { type: "string" },
      family: { type: "string" },
      brand: { type: "string" },
      model: { type: "string" },
      answers: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
      landmark: { type: "string" },
      drop: { type: "string" },
    },
    additionalProperties: false,
  },
};

function userMessage(ctx) {
  const lines = [
    `Customer said: "${ctx.text}"`,
    ctx.asking ? `The app had just asked about: ${ctx.asking}` : "",
    `Service ids: ${ctx.services.join(", ")}${ctx.service ? ` (already known: ${ctx.service})` : ""}`,
    `Vehicle types: ${ctx.families.join(", ")}${ctx.family ? ` (already known: ${ctx.family})` : ""}`,
  ];
  if (ctx.questions.length) {
    lines.push("Questions:");
    for (const q of ctx.questions) lines.push(`- ${q.id}${q.multi ? " (multi)" : ""}: ${q.label} Options: ${q.options.map((o) => `${o.v} = ${o.label}`).join("; ")}`);
  }
  return lines.filter(Boolean).join("\n");
}

/** Keeps only values the form allows. */
export function cleanResult(input, ctx) {
  const raw = input && typeof input === "object" ? input : {};
  const out = {};
  if (ctx.services.includes(raw.service)) out.service = raw.service;
  if (ctx.families.includes(raw.family)) out.family = raw.family;
  for (const key of ["brand", "model"]) { const v = text(raw[key], 60); if (v) out[key] = v; }
  for (const key of ["landmark", "drop"]) { const v = text(raw[key], 160); if (v) out[key] = v; }
  const answers = {};
  if (raw.answers && typeof raw.answers === "object") {
    for (const q of ctx.questions) {
      const allowed = new Set(q.options.map((o) => o.v));
      const value = raw.answers[q.id];
      if (q.multi && Array.isArray(value)) { const values = value.map(String).filter((v) => allowed.has(v)); if (values.length) answers[q.id] = values; }
      else if (!q.multi && typeof value === "string" && allowed.has(value)) answers[q.id] = value;
    }
  }
  if (Object.keys(answers).length) out.answers = answers;
  return out;
}

export function createVoiceUnderstanding({ apiKey, model = DEFAULT_MODEL, timeoutMs = 3500, fetchImpl = globalThis.fetch } = {}) {
  return {
    enabled: Boolean(apiKey),
    async understand(ctx) {
      if (!apiKey) throw new VoiceAiError("The AI step is not set up", 503);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(API_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model,
            max_tokens: 400,
            system: SYSTEM,
            tools: [TOOL],
            tool_choice: { type: "tool", name: TOOL.name },
            messages: [{ role: "user", content: userMessage(ctx) }],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new VoiceAiError(`AI request failed (${response.status})`, 502);
        const data = await response.json();
        const block = (Array.isArray(data?.content) ? data.content : []).find((b) => b?.type === "tool_use" && b?.name === TOOL.name);
        return cleanResult(block?.input, ctx);
      } catch (error) {
        if (error?.name === "AbortError") throw new VoiceAiError("AI timed out", 504);
        throw error instanceof VoiceAiError ? error : new VoiceAiError("AI request failed", 502);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
