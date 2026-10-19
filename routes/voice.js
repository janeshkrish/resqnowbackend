import express from "express";
import rateLimit from "express-rate-limit";
import { verifyUser } from "../middleware/auth.js";
import { createVoiceUnderstanding, sanitizeVoiceContext, voiceConfig, voiceEnabledFor } from "../services/voiceUnderstanding.js";

/** ResQNow-Thozhan: whether voice requests are on for this customer, and the AI step for sentences the app can't read alone. */
export function createVoiceRouter({ config = voiceConfig(), understanding = createVoiceUnderstanding(config), auth = verifyUser } = {}) {
  const router = express.Router();

  router.get("/status", auth, (req, res) => {
    const enabled = voiceEnabledFor(config, req.user?.userId);
    res.json({ enabled, ai: enabled && understanding.enabled });
  });

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `voice:${req.user?.userId ?? "anon"}`,
    handler: (_req, res) => res.status(429).json({ error: "Too many voice requests. Try again in a minute." }),
  });

  router.post("/understand", auth, limiter, async (req, res) => {
    if (!voiceEnabledFor(config, req.user?.userId)) return res.status(403).json({ error: "Voice requests are not on for this account." });
    if (!understanding.enabled) return res.status(503).json({ error: "The AI step is not set up.", ai: false });
    let ctx;
    try {
      ctx = sanitizeVoiceContext(req.body);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    try {
      const result = await understanding.understand(ctx);
      return res.json({ result });
    } catch (error) {
      // The words themselves are never logged.
      console.warn("[voice] AI step failed:", error.message);
      return res.status(error.status || 502).json({ error: "The AI step is unavailable." });
    }
  });

  return router;
}

export default createVoiceRouter();
