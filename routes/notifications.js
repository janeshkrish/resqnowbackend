import express from "express";
import { verifyUser, verifyTechnician } from "../middleware/auth.js";
import { notificationService } from "../services/notificationService.js";

const router = express.Router();

// Both users and technicians can register tokens
// Since we have two different auth middlewares, we check which payload is present
const authenticateAny = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // A bit hacky, but try user auth, if not, try tech auth
  verifyUser(req, res, (err) => {
    if (!err && req.user) return next();
    
    // Clear user-specific variables before trying tech
    delete req.user;
    
    verifyTechnician(req, res, (techErr) => {
      if (!techErr && req.technicianId) return next();
      return res.status(401).json({ error: "Unauthorized either as user or technician." });
    });
  });
};

/**
 * POST /api/notifications/register-token
 */
router.post("/register-token", authenticateAny, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "FCM token is required." });
    }

    let userId = null;
    let userType = null;

    if (req.user && req.user.userId) {
      userId = req.user.userId;
      userType = "user";
    } else if (req.technicianId) {
      userId = req.technicianId;
      userType = "technician";
    } else {
      return res.status(401).json({ error: "Unable to determine user type." });
    }

    await notificationService.registerToken(userId, userType, token);
    res.json({ success: true, message: "Token registered successfully." });

  } catch (err) {
    console.error("[Notifications] Register Token Error:", err);
    res.status(500).json({ error: "Failed to register token." });
  }
});

export default router;
