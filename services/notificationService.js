import admin from "firebase-admin";
import { getPool } from "../db.js";

class NotificationService {
    constructor() {
        this.isInitialized = false;
        this.hasLoggedDisabledState = false;
        this.init();
    }

    init() {
        try {
            if (!admin.apps.length) {
                // Attempt to initialize from FIREBASE_SERVICE_ACCOUNT JSON string.
                const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
                if (serviceAccountStr) {
                    const serviceAccount = JSON.parse(serviceAccountStr);
                    // Render/Vercel often escape \n in env vars to \\n.
                    if (serviceAccount.private_key) {
                        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                    }
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

    getNotificationPayload(userType, event, data = {}) {
        let title = "";
        let body = "";
        const status = String(data?.status || "").toLowerCase();
        const requestId = data?.requestId || data?.id || "";

        if (userType === "technician") {
            switch (event) {
                case "job:assigned":
                    title = "New Service Request";
                    body = `Service request for ${data.serviceType || "vehicle"}.`;
                    break;
                case "job:status_update":
                    if (status === "cancelled") {
                        title = "Job Cancelled";
                        body = `Customer cancelled request #${requestId}.`;
                    }
                    break;
                case "technician:new_review": {
                    const rating = Number(data?.rating || 0);
                    title = "New Rating Received";
                    body = Number.isFinite(rating)
                        ? `You received a ${rating.toFixed(1)} star review.`
                        : "You received a new customer rating.";
                    break;
                }
                default:
                    break;
            }
        } else if (userType === "user") {
            switch (event) {
                case "job:status_update":
                    if (status === "accepted") {
                        title = "Service Accepted";
                        body = "A technician has accepted your service request.";
                    } else if (status === "on-the-way" || status === "en-route") {
                        title = "Technician On The Way";
                        body = "Your technician is heading towards your location.";
                    } else if (status === "arrived") {
                        title = "Technician Arrived";
                        body = "Your technician is at your location.";
                    } else if (status === "in-progress") {
                        title = "Service Started";
                        body = "Your technician has started working on your request.";
                    } else if (status === "completed" || status === "payment_pending") {
                        title = "Service Completed";
                        body = "Service is complete. Please finish payment to close the request.";
                    } else if (status === "paid") {
                        title = "Payment Completed";
                        body = "Your payment has been successfully processed.";
                    }
                    break;
                case "payment_completed":
                    title = "Payment Completed";
                    body = "Your payment has been successfully processed.";
                    break;
                default:
                    break;
            }
        }

        if (!title || !body) return null;

        return {
            notification: { title, body },
            data: {
                event,
                requestId: requestId ? String(requestId) : "",
                click_action: "FLUTTER_NOTIFICATION_CLICK"
            }
        };
    }

    async sendPushNotification(userId, userType, event, data) {
        if (!this.isInitialized) {
            if (!this.hasLoggedDisabledState) {
                console.warn("[NotificationService] Push delivery skipped because Firebase is not initialized.");
                this.hasLoggedDisabledState = true;
            }
            return;
        }

        try {
            const payload = this.getNotificationPayload(userType, event, data);
            if (!payload) return;

            const pool = await getPool();

            // Enforce technician-online constraint for assignment pushes.
            if (userType === "technician" && event === "job:assigned") {
                const [techCheck] = await pool.query(
                    "SELECT is_active FROM technicians WHERE id = ?",
                    [userId]
                );
                if (techCheck.length === 0 || techCheck[0].is_active === 0) {
                    console.log(`[NotificationService] Push skipped: Technician ${userId} is offline.`);
                    return;
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

            // Cleanup invalid tokens.
            if (response.failureCount > 0) {
                const failedTokens = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success && (
                        resp.error?.code === "messaging/invalid-registration-token" ||
                        resp.error?.code === "messaging/registration-token-not-registered"
                    )) {
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
