import express from "express";
import { chatbotService } from "../services/ChatbotService.js";

const router = express.Router();

router.post("/message", async (req, res) => {
    try {
        const { sessionId, message } = req.body;

        if (!sessionId || !message) {
            return res.status(400).json({ error: "sessionId and message are required" });
        }

        const response = await chatbotService.processMessage(sessionId, message);

        // Simulate thinking delay for realism
        setTimeout(() => {
            res.json(response);
        }, 600);

    } catch (error) {
        console.error("Chatbot API Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
