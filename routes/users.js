import { Router } from "express";
import * as db from "../db.js";
import * as mail from "../services/mailer.js";
import { socketService } from "../services/socket.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { verifyUser } from "../middleware/auth.js";

const router = Router();


const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();

function signUserToken(userId, email) {
  if (!JWT_SECRET) {
    throw new Error("JWT is not configured.");
  }
  return jwt.sign({ userId, email, type: "user" }, JWT_SECRET, { expiresIn: "7d" });
}

const DEFAULT_USER_SETTINGS = Object.freeze({
  appearance: {
    theme: "system",
    force_dark_mode: false
  },
  notifications: {
    service_updates_email: true,
    marketing_email: true,
    push_alerts: false
  },
  privacy: {
    email_visibility: "verified_only"
  }
});

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

const parseSettings = (value) => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isPlainObject(value) ? value : {};
};

const normalizeUserSettings = (existingValue, patchValue = null) => {
  const existing = parseSettings(existingValue);
  const patch = parseSettings(patchValue);

  const merged = {
    appearance: {
      ...DEFAULT_USER_SETTINGS.appearance,
      ...(isPlainObject(existing.appearance) ? existing.appearance : {}),
      ...(isPlainObject(patch.appearance) ? patch.appearance : {})
    },
    notifications: {
      ...DEFAULT_USER_SETTINGS.notifications,
      ...(isPlainObject(existing.notifications) ? existing.notifications : {}),
      ...(isPlainObject(patch.notifications) ? patch.notifications : {})
    },
    privacy: {
      ...DEFAULT_USER_SETTINGS.privacy,
      ...(isPlainObject(existing.privacy) ? existing.privacy : {}),
      ...(isPlainObject(patch.privacy) ? patch.privacy : {})
    }
  };

  if (!["light", "dark", "system"].includes(String(merged.appearance.theme || ""))) {
    merged.appearance.theme = "system";
  }
  merged.appearance.force_dark_mode = !!merged.appearance.force_dark_mode;
  merged.notifications.service_updates_email = !!merged.notifications.service_updates_email;
  merged.notifications.marketing_email = !!merged.notifications.marketing_email;
  merged.notifications.push_alerts = !!merged.notifications.push_alerts;

  return merged;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildRequestId(req) {
  const incoming = String(req.get("x-request-id") || "").trim();
  if (incoming) return incoming;
  return `otp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function maskEmail(email) {
  const value = String(email || "").trim();
  if (!value || !value.includes("@")) return "";
  const [name, domain] = value.split("@");
  if (!name || !domain) return "";
  if (name.length < 3) return `${name[0] || "*"}***@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

const OTP_TTL_MINUTES = toPositiveInt(process.env.OTP_TTL_MINUTES, 5);
const OTP_RESEND_COOLDOWN_SECONDS = toPositiveInt(process.env.OTP_RESEND_COOLDOWN_SECONDS, 45);
const OTP_DAILY_LIMIT = toPositiveInt(process.env.OTP_DAILY_LIMIT, 12);
const OTP_DEBUG_ROUTE_ENABLED = String(process.env.OTP_DEBUG_ROUTE_ENABLED || "").toLowerCase() === "true";
const OTP_DEBUG_TOKEN = String(process.env.OTP_DEBUG_TOKEN || "").trim();

async function handleSendOtp(req, res, { debug = false } = {}) {
  const requestId = buildRequestId(req);
  const startedAt = Date.now();
  const clientIp = req.ip || req.connection?.remoteAddress || "unknown";

  try {
    const { name, email, password } = req.body;
    const normalizedEmail = (email || "").trim().toLowerCase();
    const trimmedName = (name || "").trim();

    if (debug) {
      console.log("[OTP][DEBUG] Incoming request", {
        requestId,
        clientIp,
        hasName: !!trimmedName,
        hasEmail: !!normalizedEmail,
        hasPassword: !!password,
        email: maskEmail(normalizedEmail),
        headers: {
          origin: req.get("origin") || null,
          userAgent: req.get("user-agent") || null,
        },
      });
    } else {
      console.log("[OTP] Request received", {
        requestId,
        clientIp,
        email: maskEmail(normalizedEmail),
      });
    }

    if (!trimmedName || !normalizedEmail || !password) {
      return res.status(400).json({ error: "Name, email and password are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: "Invalid email format." });
    }

    const existingUser = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);
    if (existingUser.length > 0) {
      return res.status(409).json({ error: "This email is already registered. Please log in." });
    }

    const pool = await db.getPool();

    const [recentRows] = await pool.query(
      "SELECT created_at FROM otp_requests WHERE email = ? ORDER BY created_at DESC LIMIT 1",
      [normalizedEmail]
    );
    if (recentRows.length > 0) {
      const lastCreatedAtMs = new Date(recentRows[0].created_at).getTime();
      if (!Number.isNaN(lastCreatedAtMs)) {
        const secondsSinceLastOtp = Math.floor((Date.now() - lastCreatedAtMs) / 1000);
        if (secondsSinceLastOtp < OTP_RESEND_COOLDOWN_SECONDS) {
          const waitSeconds = OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLastOtp;
          return res.status(429).json({
            success: false,
            error: `Please wait ${waitSeconds} seconds before requesting another OTP.`,
          });
        }
      }
    }

    const [dailyCountRows] = await pool.query(
      "SELECT COUNT(*) AS total FROM otp_requests WHERE email = ? AND created_at >= (NOW() - INTERVAL 1 DAY)",
      [normalizedEmail]
    );
    const dailyCount = Number(dailyCountRows[0]?.total || 0);
    if (dailyCount >= OTP_DAILY_LIMIT) {
      return res.status(429).json({
        success: false,
        error: "OTP request limit reached for today. Please try again tomorrow.",
      });
    }

    const mailerCheck = await mail.verifyMailerConnectionDetailed({ requestId });
    if (!mailerCheck.ok) {
      console.error("[OTP] Mailer verification failed", {
        requestId,
        clientIp,
        email: maskEmail(normalizedEmail),
        reason: mailerCheck.reason,
        snapshot: mailerCheck.snapshot,
        error: mailerCheck.error || null,
      });
      return res.status(500).json({
        success: false,
        error: "Unable to send OTP email right now. Please try again shortly.",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const [insertResult] = await pool.execute(
      "INSERT INTO otp_requests (email, otp_hash, expires_at) VALUES (?, ?, ?)",
      [normalizedEmail, otpHash, expiresAt]
    );
    const otpRequestId = insertResult.insertId;

    try {
      await mail.sendMail({
        to: normalizedEmail,
        subject: "Your OTP for ResQNow",
        html: `Hello ${trimmedName},<br><br>Your OTP for verification is: <b>${otp}</b><br><br>It expires in ${OTP_TTL_MINUTES} minutes.<br><br>Regards,<br>ResQNow Team`,
      });
    } catch (sendError) {
      const smtpError = mail.getSmtpErrorDetails(sendError);
      console.error("[OTP] SMTP send failed", {
        requestId,
        clientIp,
        email: maskEmail(normalizedEmail),
        otpRequestId,
        smtpError,
      });
      try {
        await pool.execute("DELETE FROM otp_requests WHERE id = ? LIMIT 1", [otpRequestId]);
      } catch (cleanupError) {
        console.error("[OTP] Failed to cleanup OTP row after SMTP failure", {
          requestId,
          otpRequestId,
          cleanupError: cleanupError?.stack || cleanupError?.message || cleanupError,
        });
      }
      return res.status(500).json({
        success: false,
        error: "Unable to deliver OTP email at the moment. Please try again.",
      });
    }

    const durationMs = Date.now() - startedAt;
    console.log("[OTP] Sent successfully", {
      requestId,
      clientIp,
      email: maskEmail(normalizedEmail),
      durationMs,
    });

    const responsePayload = {
      success: true,
      message: "OTP sent to your email.",
    };

    if (debug) {
      responsePayload.debug = {
        requestId,
        durationMs,
        mailer: mailerCheck.snapshot,
      };
    }

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error("[OTP] send-otp route failed", {
      requestId,
      clientIp,
      error: error?.stack || error?.message || error,
    });
    const responsePayload = {
      success: false,
      error: "Internal server error while processing OTP request.",
    };
    if (debug) {
      responsePayload.debug = {
        requestId,
        message: error?.message || String(error),
      };
    }
    return res.status(500).json(responsePayload);
  }
}

// 1. Send OTP (Step 1 of Registration)
router.post("/send-otp", async (req, res) => {
  return handleSendOtp(req, res, { debug: false });
});

// Temporary production debug endpoint for OTP mail flow.
router.post("/send-otp-debug", async (req, res) => {
  if (!OTP_DEBUG_ROUTE_ENABLED) {
    return res.status(404).json({ error: "Not found." });
  }
  if (OTP_DEBUG_TOKEN && req.get("x-debug-token") !== OTP_DEBUG_TOKEN) {
    return res.status(403).json({ error: "Forbidden." });
  }
  return handleSendOtp(req, res, { debug: true });
});

// 2. Verify OTP and Create User (Step 2 of Registration)
router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp, name, password } = req.body;
    const normalizedEmail = (email || "").trim().toLowerCase();
    const clientIp = req.ip || req.connection.remoteAddress;

    console.log(`[AUTH OTP-VERIFY] Attempt from ${clientIp} for ${normalizedEmail}`);

    if (!normalizedEmail || !otp || !name || !password) {
      console.warn(`[AUTH OTP-VERIFY] Missing fields from ${clientIp}`);
      return res.status(400).json({ error: "Missing required fields." });
    }

    const pool = await db.getPool();

    // Verify OTP
    const [otps] = await pool.query(
      "SELECT * FROM otp_requests WHERE email = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
      [normalizedEmail]
    );

    if (otps.length === 0) {
      console.warn(`[AUTH OTP-VERIFY] Invalid or expired OTP from ${clientIp} for ${normalizedEmail}`);
      return res.status(400).json({ error: "Invalid or expired OTP." });
    }

    const validOtp = await bcrypt.compare(otp, otps[0].otp_hash);
    if (!validOtp) {
      console.warn(`[AUTH OTP-VERIFY] Wrong OTP from ${clientIp} for ${normalizedEmail}`);
      return res.status(400).json({ error: "Invalid OTP." });
    }

    // Double check user existence
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);
    if (existing.length > 0) {
      console.warn(`[AUTH OTP-VERIFY] User already exists from ${clientIp} for ${normalizedEmail}`);
      return res.status(409).json({ error: "User already registered." });
    }

    // Create User
    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      "INSERT INTO users (full_name, email, password_hash, role, is_verified, status) VALUES (?, ?, ?, 'user', 1, 'approved')",
      [name, normalizedEmail, passwordHash]
    );

    const userId = result.insertId;
    const token = signUserToken(userId, normalizedEmail);

    // Cleanup OTPs
    await pool.execute("DELETE FROM otp_requests WHERE email = ?", [normalizedEmail]);

    console.log(`[AUTH OTP-VERIFY] ✅ Success - User created for ${normalizedEmail} from ${clientIp}`);

    res.status(201).json({
      token,
      user: {
        id: userId,
        name: name,
        email: normalizedEmail,
        isVerified: true
      }
    });

  } catch (err) {
    console.error("[Verify OTP Error]", err);
    res.status(500).json({ error: "Verification failed." });
  }
});

// 3. Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = (email || "").trim().toLowerCase();
    const clientIp = req.ip || req.connection.remoteAddress;

    console.log(`[AUTH LOGIN] Attempt from ${clientIp} for ${normalizedEmail}`);

    if (!normalizedEmail || !password) {
      console.warn(`[AUTH LOGIN] Missing credentials from ${clientIp}`);
      return res.status(400).json({ error: "Email and password are required." });
    }

    const [user] = await db.query("SELECT * FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);

    if (!user) {
      console.warn(`[AUTH LOGIN] User not found: ${normalizedEmail} from ${clientIp}`);
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // Check Verify
    if (!user.is_verified) {
      console.warn(`[AUTH LOGIN] User not verified: ${normalizedEmail} from ${clientIp}`);
      return res.status(403).json({ error: "Account not verified." });
    }

    if (!user.password_hash) {
      console.warn(`[AUTH LOGIN] User has no password (Google auth only): ${normalizedEmail} from ${clientIp}`);
      return res.status(401).json({ error: "Please login with Google." });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.warn(`[AUTH LOGIN] Invalid password for ${normalizedEmail} from ${clientIp}`);
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = signUserToken(user.id, user.email);
    console.log(`[AUTH LOGIN] ✅ Success for ${normalizedEmail} from ${clientIp}`);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        isVerified: true
      },
    });

  } catch (err) {
    console.error("[User Login Error]", err);
    return res.status(500).json({ error: "Login failed." });
  }
});


// 4. Update Profile
router.put('/:id', verifyUser, async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, phone, birthday, gender } = req.body;

    // Security check: Ensure token user matches param user (or is admin - omitted for now)
    if (String(req.user.userId || req.user.id) !== String(userId)) {
      return res.status(403).json({ error: "Forbidden: Cannot update other users." });
    }

    const updates = [];
    const values = [];

    if (name) {
      updates.push("full_name = ?");
      values.push(name);
    }
    if (phone !== undefined) {
      updates.push("phone = ?");
      values.push(phone);
    }
    if (birthday !== undefined) {
      updates.push("birthday = ?");
      values.push(birthday);
    }
    if (gender !== undefined) {
      updates.push("gender = ?");
      values.push(gender);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update." });
    }

    values.push(userId);

    const sql = `UPDATE users SET ${updates.join(", ")} WHERE id = ?`;

    // console.log("Executing Update:", sql, values); // Debug

    const pool = await db.getPool();
    await pool.execute(sql, values);

    // Fetch updated user to return
    const [rows] = await pool.query("SELECT id, full_name, email, phone, birthday, gender, is_verified, subscription, google_id FROM users WHERE id = ?", [userId]);
    const updatedUser = rows[0];

    res.json({
      message: "Profile updated successfully.",
      user: {
        id: updatedUser.id,
        name: updatedUser.full_name,
        email: updatedUser.email,
        phone: updatedUser.phone,
        birthday: updatedUser.birthday,
        gender: updatedUser.gender,
        isVerified: !!updatedUser.is_verified,
        subscription: updatedUser.subscription,
        googleId: updatedUser.google_id
      }
    });

  } catch (err) {
    console.error("[Update Profile Error]", err);
    res.status(500).json({ error: "Failed to update profile." });
  }
});

router.get('/me/settings', verifyUser, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const pool = await db.getPool();
    const [rows] = await pool.query("SELECT settings FROM users WHERE id = ? LIMIT 1", [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    return res.json(normalizeUserSettings(rows[0]?.settings));
  } catch (err) {
    console.error("[Get User Settings Error]", err);
    return res.status(500).json({ error: "Failed to fetch settings." });
  }
});

router.patch('/me/settings', verifyUser, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: "Invalid settings payload." });
    }

    const pool = await db.getPool();
    const [rows] = await pool.query("SELECT settings FROM users WHERE id = ? LIMIT 1", [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const settings = normalizeUserSettings(rows[0]?.settings, req.body);
    await pool.execute("UPDATE users SET settings = ? WHERE id = ?", [JSON.stringify(settings), userId]);

    socketService.notifyUser(userId, "user:settings_update", settings);

    return res.json({
      success: true,
      settings
    });
  } catch (err) {
    console.error("[Update User Settings Error]", err);
    return res.status(500).json({ error: "Failed to update settings." });
  }
});

router.post('/reviews', verifyUser, async (req, res) => {
  try {
    const authUserId = req.user.userId;
    const { technician_id, rating, comment, request_id } = req.body;

    if (!technician_id || !rating) {
      return res.status(400).json({ error: "Missing required fields for review." });
    }
    if (Number(rating) < 1 || Number(rating) > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5." });
    }

    const pool = await db.getPool();
    if (request_id) {
      const [requestRows] = await pool.query(
        "SELECT id, user_id, technician_id, status FROM service_requests WHERE id = ? LIMIT 1",
        [request_id]
      );
      if (requestRows.length === 0) {
        return res.status(404).json({ error: "Service request not found." });
      }
      const request = requestRows[0];
      if (String(request.user_id) !== String(authUserId)) {
        return res.status(403).json({ error: "You can only review your own request." });
      }
      if (String(request.technician_id) !== String(technician_id)) {
        return res.status(400).json({ error: "Technician mismatch for this request." });
      }
      if (!['completed', 'paid'].includes(String(request.status || '').toLowerCase())) {
        return res.status(400).json({ error: "Review allowed only after completion/payment." });
      }
    }

    const [existing] = await pool.query(
      "SELECT id FROM reviews WHERE user_id = ? AND technician_id = ? AND service_request_id = ? LIMIT 1",
      [authUserId, technician_id, request_id || null]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Review already submitted for this request." });
    }

    const [userRows] = await pool.query("SELECT full_name FROM users WHERE id = ? LIMIT 1", [authUserId]);
    const reviewerName = userRows[0]?.full_name || "Customer";

    const [insertResult] = await pool.execute(
      "INSERT INTO reviews (user_id, technician_id, rating, comment, service_request_id) VALUES (?, ?, ?, ?, ?)",
      [authUserId, technician_id, Number(rating), comment || '', request_id || null]
    );

    // Update technician average rating
    const [rows] = await pool.query("SELECT AVG(rating) as avg_rating FROM reviews WHERE technician_id = ?", [technician_id]);
    const avg = rows[0]?.avg_rating || 0;

    await pool.execute("UPDATE technicians SET rating = ? WHERE id = ?", [avg.toFixed(1), technician_id]);

    // Notify technician dynamically
    const newReview = {
      id: insertResult.insertId,
      user_id: authUserId,
      technician_id,
      rating: Number(rating),
      comment,
      created_at: new Date(),
      reviewer_name: reviewerName
    };
    socketService.notifyTechnician(technician_id, 'technician:new_review', newReview);

    res.json({ success: true, message: "Review submitted successfully" });

  } catch (err) {
    console.error("Submit review error:", err);
    res.status(500).json({ error: "Failed to submit review", details: err.sqlMessage || err.message });
  }
});

export default router;

