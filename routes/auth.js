import express from "express";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import * as db from "../db.js";
import { verifyUser } from "../middleware/auth.js";
import { getFrontendUrl, getGoogleCallbackUrl } from "../config/network.js";

const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables.");
}

// Always use normalized callback URL to avoid redirect_uri mismatches caused by trailing slashes.
const getRedirectUri = () => {
    return getGoogleCallbackUrl();
};

function ensureGoogleAuthConfigured(res) {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        res.status(503).json({ error: "Google OAuth is not configured." });
        return false;
    }
    if (!JWT_SECRET) {
        res.status(503).json({ error: "JWT is not configured." });
        return false;
    }
    const redirect = getRedirectUri();
    if (!redirect) {
        res.status(503).json({ error: "Google callback URI is not configured." });
        return false;
    }
    return true;
}

/**
 * GET /api/auth/google/url
 * Returns the Google Auth URL for the frontend to redirect to.
 */
router.get("/google/url", (req, res) => {
    if (!ensureGoogleAuthConfigured(res)) return;

    const redirectUri = getRedirectUri();
    console.log("Google Callback URL:", redirectUri);
    console.log("[Auth] Generating Google Auth URL with redirect:", redirectUri);

    const oAuth2Client = new OAuth2Client(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        redirectUri
    );

    // Standardize 'state' param to pass context through Google auth loop
    const platform = req.query.platform || "web";

    const authorizeUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["openid", "email", "profile"],
        include_granted_scopes: true,
        prompt: "select_account",
        state: platform // E.g "capacitor" or "web"
    });

    res.json({ url: authorizeUrl, redirectUri });
});

/**
 * GET /api/auth/google/callback
 * Handle the code returned from Google.
 */
router.get("/google/callback", async (req, res) => {
    if (!ensureGoogleAuthConfigured(res)) return;

    const { code, state } = req.query;
    if (!code) return res.status(400).send("No code provided");

    try {
        const redirectUri = getRedirectUri();
        console.log("Google Callback URL:", redirectUri);
        console.log("[Auth] Verifying code with redirect:", redirectUri);

        const oAuth2Client = new OAuth2Client(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            redirectUri
        );

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Get User Info
        const url = "https://www.googleapis.com/oauth2/v2/userinfo";
        const response = await oAuth2Client.request({ url });
        const data = response.data;

        const { id: googleId, email, name } = data;

        if (!email) return res.status(400).send("Google account has no email.");

        const pool = await db.getPool();

        // Check if user exists
        const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);

        let userId;
        let userRow;

        if (rows.length > 0) {
            userRow = rows[0];
            userId = userRow.id;
            // Update info if needed
            await pool.query("UPDATE users SET google_id = ?, full_name = ? WHERE id = ?", [googleId, name, userId]);
        } else {
            // Create new user
            const [result] = await pool.execute(
                "INSERT INTO users (full_name, email, google_id, is_verified, status) VALUES (?, ?, ?, TRUE, 'approved')",
                [name, email, googleId]
            );
            userId = result.insertId;
            userRow = { id: userId, full_name: name, email, role: "user" };
        }

        // Generate JWT
        const token = jwt.sign(
            { userId, email, role: "user" },
            JWT_SECRET,
            { expiresIn: "30d" } // Session-like
        );

        // Redirect to Frontend with Token
        // Distinguish redirect target if we are bouncing back to Capacitor Deep Link vs Web.
        const isCapacitor = state === "capacitor";

        let targetUrl;
        if (isCapacitor) {
            targetUrl = `resqnow://auth/callback?token=${token}`;
        } else {
            const frontendUrl = getFrontendUrl();
            const target = new URL("/auth/success", `${frontendUrl}/`);
            target.searchParams.set("token", token);
            targetUrl = target.toString();
        }

        return res.redirect(targetUrl);

    } catch (err) {
        console.error("[Auth] Google Callback Error:", err);
        const target = new URL("/auth/failed", `${getFrontendUrl()}/`);
        target.searchParams.set("error", "google_auth_failed");
        return res.redirect(target.toString());
    }
});

/**
 * POST /api/auth/verify
 * Check if token is valid (for frontend guard).
 */
router.get("/verify", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token" });

    const token = authHeader.split(" ")[1];
    try {
        if (!JWT_SECRET) {
            return res.status(503).json({ error: "JWT is not configured." });
        }
        const decoded = jwt.verify(token, JWT_SECRET);

        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT id, full_name, email, phone FROM users WHERE id = ?", [decoded.userId]);

        if (rows.length === 0) return res.status(401).json({ error: "User not found" });

        res.json({ user: rows[0], valid: true });
    } catch {
        res.status(401).json({ error: "Invalid token" });
    }
});

router.get("/me", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const pool = await db.getPool();
        const [rows] = await pool.query(
            "SELECT id, full_name, email, phone, birthday, gender, is_verified, subscription, google_id FROM users WHERE id = ? LIMIT 1",
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        return res.json({
            id: user.id,
            name: user.full_name,
            email: user.email,
            phone: user.phone || "",
            birthday: user.birthday || null,
            gender: user.gender || "",
            isVerified: !!user.is_verified,
            subscription: user.subscription || "free",
            googleId: user.google_id || null
        });
    } catch (err) {
        console.error("[Auth] me endpoint error:", err);
        return res.status(500).json({ error: "Failed to fetch current user." });
    }
});

router.post("/logout", (_req, res) => {
    return res.json({ success: true });
});

export default router;
