// The structured part of a service request: the customer's answers to the service's
// questions, plus landmark, number plate, urgency and attachments. Everything here is
// customer input, so it is trimmed, capped and never trusted for pricing on its own.

const MAX_ANSWERS = 20;
const MAX_TEXT = 120;
const MAX_LONG_TEXT = 500;
const MAX_ATTACHMENTS = 4;
const ATTACHMENT_URL = /^\/api\/upload\/files\/[A-Za-z0-9._-]+$/;
const ID = /^[a-z0-9_-]{1,40}$/i;

const text = (value, max = MAX_TEXT) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function parse(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function sanitizeAnswer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id, 40);
  if (!ID.test(id)) return null;
  const values = (Array.isArray(raw.value) ? raw.value : [raw.value]).map((v) => text(v, 40)).filter(Boolean).slice(0, 8);
  const label = text(raw.label);
  if (!values.length || !label) return null;
  return {
    id,
    question: text(raw.question),
    value: Array.isArray(raw.value) ? values : values[0],
    label,
  };
}

/** Clean details sent with a new request; null when there is nothing worth keeping. */
export function sanitizeRequestDetails(input) {
  const raw = parse(input);
  if (!raw || typeof raw !== "object") return null;
  const seen = new Set();
  const answers = (Array.isArray(raw.answers) ? raw.answers : [])
    .slice(0, MAX_ANSWERS)
    .map(sanitizeAnswer)
    .filter((answer) => answer && !seen.has(answer.id) && seen.add(answer.id));
  const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
    .filter((a) => a && typeof a === "object" && ["photo", "voice"].includes(a.type) && ATTACHMENT_URL.test(String(a.url || "")))
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({ type: a.type, url: String(a.url) }));
  const details = {
    answers,
    landmark: text(raw.landmark),
    plate: text(raw.plate, 20).toUpperCase(),
    note: text(raw.note, MAX_LONG_TEXT),
    urgent: raw.urgent === true || answers.some((a) => (a.id === "inside" || a.id === "hurt") && a.value === "yes"),
    attachments,
  };
  const hasContent = details.answers.length || details.landmark || details.plate || details.note || details.attachments.length || details.urgent;
  return hasContent ? details : null;
}

/** Read stored details back (JSON column, string or object); always an object with the known keys. */
export function readRequestDetails(value) {
  const cleaned = sanitizeRequestDetails(value);
  return cleaned || { answers: [], landmark: "", plate: "", note: "", urgent: false, attachments: [] };
}

export function answerValue(details, id) {
  const answer = details?.answers?.find((a) => a.id === id);
  return answer ? answer.value : null;
}

/** Short chips for technician screens: the label of every answer, in the order asked. */
export function summarizeRequestDetails(details) {
  return (details?.answers || []).map((a) => a.label);
}

/** One readable line per answer, for the plain-text description technicians and admins already see. */
export function describeRequestDetails(details) {
  if (!details) return "";
  const lines = details.answers.map((a) => (a.question ? `${a.question}: ${a.label}` : a.label));
  if (details.landmark) lines.push(`Landmark: ${details.landmark}`);
  if (details.plate) lines.push(`Number plate: ${details.plate}`);
  if (details.note) lines.push(`Note: ${details.note}`);
  return lines.join("\n");
}
