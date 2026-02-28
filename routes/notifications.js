import express from "express";
import jwt from "jsonwebtoken";
import { notificationService } from "../services/notificationService.js";

const router = express.Router();

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return secret;
}

function authenticateAny(req, res, next) {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, getJwtSecret());
    const role = String(payload?.role || payload?.type || "user").trim().toLowerCase();

    if (role === "technician") {
      const userId = payload?.id || payload?.technicianId;
      if (!userId) return res.status(401).json({ error: "Invalid technician token payload." });
      req.deviceUser = { userType: "technician", userId: String(userId) };
      return next();
    }

    if (role === "user" || role === "admin" || role === "") {
      const userId = payload?.userId || payload?.id;
      if (!userId) return res.status(401).json({ error: "Invalid user token payload." });
      req.deviceUser = { userType: "user", userId: String(userId) };
      return next();
    }

    return res.status(403).json({ error: "Unsupported token role." });
  } catch (error) {
    if (error?.message === "JWT_SECRET is not configured.") {
      return res.status(500).json({ error: "Server auth is not configured." });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
}

router.post("/register-token", authenticateAny, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "FCM token is required." });
    }

    await notificationService.registerToken(req.deviceUser.userId, req.deviceUser.userType, token);
    return res.json({ success: true, message: "Token registered successfully." });
  } catch (error) {
    console.error("[Notifications] register-token failed:", error);
    return res.status(500).json({ error: "Failed to register token." });
  }
});

router.post("/unregister-token", authenticateAny, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "FCM token is required." });
    }

    await notificationService.removeToken(token);
    return res.json({ success: true, message: "Token removed successfully." });
  } catch (error) {
    console.error("[Notifications] unregister-token failed:", error);
    return res.status(500).json({ error: "Failed to remove token." });
  }
});

export default router;
