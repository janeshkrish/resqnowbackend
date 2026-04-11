import EmailTemplate from "../models/EmailTemplate.js";

export async function getTemplates(_req, res) {
  try {
    const templates = await EmailTemplate.find();
    return res.json(templates);
  } catch (error) {
    console.error("[EmailTemplates] fetch failed:", error);
    return res.status(500).json({ error: "Failed to fetch email templates." });
  }
}

export async function updateTemplate(req, res) {
  try {
    const eventType = String(req.params?.eventType || "").trim().toUpperCase();
    const subject = String(req.body?.subject || "").trim();
    const content = String(req.body?.content || "").trim();

    if (!eventType) {
      return res.status(400).json({ error: "eventType is required." });
    }
    if (!subject || !content) {
      return res.status(400).json({ error: "subject and content are required." });
    }

    const template = await EmailTemplate.findOneAndUpdate(
      { eventType },
      { subject, content },
      { upsert: true, new: true }
    );

    return res.json(template);
  } catch (error) {
    console.error("[EmailTemplates] update failed:", error);
    return res.status(500).json({ error: "Failed to update email template." });
  }
}
