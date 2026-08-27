import { sendEmail } from "./emailService.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { EMAIL_TEMPLATE_EVENT_TYPES } from "./emailTemplateDefaults.js";

const TEMPLATE_TOKEN_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function applyTemplateVariables(template, data = {}) {
  return String(template || "").replace(TEMPLATE_TOKEN_REGEX, (_match, key) => {
    const value = data[key];
    return value == null ? "" : String(value);
  });
}

function resolveRecipient(data = {}) {
  return String(data.to || data.email || "").trim();
}

export async function sendEventEmail(eventType, data = {}) {
  try {
    const normalizedEventType = String(eventType || "").trim().toUpperCase();
    if (!normalizedEventType) {
      console.warn("[EventEmail] Missing eventType.");
      return { skipped: true, reason: "event_type_missing" };
    }

    const template = await EmailTemplate.findOne({ eventType: normalizedEventType });
    if (!template) {
      console.warn("[EventEmail] No template found for:", normalizedEventType);
      return { skipped: true, reason: "template_not_found", eventType: normalizedEventType };
    }

    const to = resolveRecipient(data);
    if (!to) {
      console.warn("[EventEmail] No recipient found for:", normalizedEventType);
      return { skipped: true, reason: "recipient_missing", eventType: normalizedEventType };
    }

    const subject = applyTemplateVariables(template.subject, data);
    const html = applyTemplateVariables(template.content, data);

    return await sendEmail({
      to,
      subject,
      html,
    });
  } catch (error) {
    console.error("[EventEmail] EVENT EMAIL ERROR:", {
      eventType,
      message: error?.message || String(error),
    });
    return { skipped: true, reason: "send_failed", eventType: String(eventType || "") };
  }
}

export { EMAIL_TEMPLATE_EVENT_TYPES, applyTemplateVariables };
