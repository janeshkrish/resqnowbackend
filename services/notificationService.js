import admin from "firebase-admin";
import { getPool } from "../db.js";

class NotificationService {
    constructor() {
        this.isInitialized = false;
        this.init();
    }

    init() {
        try {
            if (!admin.apps.length) {
                // Attempt to initialize from FIREBASE_SERVICE_ACCOUNT JSON string or env vars.
                const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
                if (serviceAccountStr) {
                    const serviceAccount = JSON.parse(serviceAccountStr);
                    admin.initializeApp({
                        credential: admin.credential.cert(serviceAccount)
                    });
                    this.isInitialized = true;
                    console.log("[NotificationService] Firebase Admin initialized via service account.");
                } else {
                    console.log("[NotificationService] No FIREBASE_SERVICE_ACCOUNT variable found. Push notifications are disabled.");
                }
            } else {
                this.isInitialized = true;
            }
        } catch (err) {
            console.error("[NotificationService] Firebase init failed:", err);
        }
    }

    async registerToken(userId, userType, token) {
        if (!token) return;
        const pool = await getPool();
        // Insert or update (ignore duplicate)
        await pool.query(
            `INSERT INTO device_tokens (user_id, user_type, token) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
            [userId, userType, token]
        );
    }

    async removeToken(token) {
        if (!token) return;
        const pool = await getPool();
        await pool.query("DELETE FROM device_tokens WHERE token = ?", [token]);
    }

    /**
     * Translates internal socket events into user-friendly push payloads
     */
    getNotificationPayload(userType, event, data) {
        let title = "";
        let body = "";

        // Technician Events
        if (userType === "technician") {
            switch (event) {
                case "job:assigned":
                    title = "🔔 New Job Alert";
                    body = `Service request for ${data.serviceType || 'vehicle'}. Tap to review.`;
                    break;
                case "job:status_update":
                    if (data.status === "cancelled") {
                        title = "❌ Job Cancelled";
                        body = `Customer cancelled request #${data.requestId}.`;
                    }
                    break;
            }
        }
        // User Events
        else if (userType === "user") {
            switch (event) {
                case "job:status_update":
                    if (data.status === "accepted") {
                        title = "✅ Technician Assigned";
                        body = "A technician has accepted your request.";
                    } else if (data.status === "on-the-way" || data.status === "en-route") {
                        title = "🚗 Technician On The Way";
                        body = "Your technician is heading towards your location.";
                    } else if (data.status === "arrived") {
                        title = "📍 Technician Arrived";
                        body = "Your technician is at your location.";
                    } else if (data.status === "payment_pending") {
                        title = "💳 Payment Pending";
                        body = "Service completed. Please complete your payment.";
                    }
                    break;
            }
        }

        if (!title || !body) return null;

        return {
            notification: { title, body },
            data: {
                event,
                requestId: data.requestId || data.id || "",
                click_action: "FLUTTER_NOTIFICATION_CLICK" // Standard action for PWA clicking
            }
        };
    }

    async sendPushNotification(userId, userType, event, data) {
        if (!this.isInitialized) return;

        try {
            const payload = this.getNotificationPayload(userType, event, data);
            if (!payload) return; // Event not tracked for PUSH

            const pool = await getPool();

            // Enforce Technician Online Constraint for Job Assignments
            if (userType === 'technician' && event === 'job:assigned') {
                const [techCheck] = await pool.query(
                    "SELECT is_active FROM technicians WHERE id = ?",
                    [userId]
                );
                if (techCheck.length === 0 || techCheck[0].is_active === 0) {
                    console.log(`[NotificationService] Aborting Push: Technician ${userId} is offline.`);
                    return; // Technician is offline, silently drop push alert
                }
            }

            const [tokens] = await pool.query(
                "SELECT token FROM device_tokens WHERE user_id = ? AND user_type = ?",
                [userId, userType]
            );

            if (tokens.length === 0) return;

            const registrationTokens = tokens.map((t) => t.token);

            const message = {
                ...payload,
                tokens: registrationTokens,
            };

            const response = await admin.messaging().sendMulticast(message);

            // Cleanup invalid tokens
            if (response.failureCount > 0) {
                const failedTokens = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success &&
                        (resp.error.code === 'messaging/invalid-registration-token' ||
                            resp.error.code === 'messaging/registration-token-not-registered')) {
                        failedTokens.push(registrationTokens[idx]);
                    }
                });

                if (failedTokens.length > 0) {
                    const placeholders = failedTokens.map(() => "?").join(",");
                    await pool.query(
                        `DELETE FROM device_tokens WHERE token IN (${placeholders})`,
                        failedTokens
                    );
                }
            }
        } catch (err) {
            console.error(`[NotificationService] Error sending push to ${userType} ${userId}:`, err);
        }
    }
}

export const notificationService = new NotificationService();
