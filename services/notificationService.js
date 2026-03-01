import admin from "firebase-admin";
import { getPool } from "../db.js";

const JOB_ALERT_TITLE = "\uD83D\uDEA8 New Job Alert";

const SERVICE_EMOJI_MAP = [
  { key: "towing", emoji: "\uD83D\uDEFB" },
  { key: "flat", emoji: "\uD83D\uDEDE" },
  { key: "tyre", emoji: "\uD83D\uDEDE" },
  { key: "tire", emoji: "\uD83D\uDEDE" },
  { key: "battery", emoji: "\uD83D\uDD0B" },
  { key: "fuel", emoji: "\u26FD" },
  { key: "lockout", emoji: "\uD83D\uDD10" },
  { key: "jump", emoji: "\uD83D\uDD0B" },
];

function normalizeText(value) {
  return String(value || "").trim();
}

function stripWrappingQuotes(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function normalizeMoney(value) {
  const amount = Number(value);
  if (Number.isFinite(amount) && amount >= 0) return amount.toFixed(0);
  return normalizeText(value) || "0";
}

function normalizeDistanceLabel(value) {
  const raw = normalizeText(value).replace(/\s*away$/i, "");
  if (!raw) return "Nearby";
  return raw;
}

function resolveServiceEmoji(serviceType) {
  const normalized = normalizeText(serviceType).toLowerCase();
  if (!normalized) return "\uD83E\uDDF0";
  const matched = SERVICE_EMOJI_MAP.find((item) => normalized.includes(item.key));
  return matched?.emoji || "\uD83E\uDDF0";
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function stringifyDataPayload(data) {
  const result = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value == null) return;
    result[key] = String(value);
  });
  return result;
}

function parseServiceAccountFromEnv() {
  const rawJson = stripWrappingQuotes(
    process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    if (parsed?.private_key) {
      parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
    }
    return parsed;
  }

  const base64 = stripWrappingQuotes(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64);
  if (base64) {
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed?.private_key) {
      parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
    }
    return parsed;
  }

  const projectId = normalizeText(process.env.FIREBASE_PROJECT_ID);
  const clientEmail = normalizeText(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKeyRaw = stripWrappingQuotes(process.env.FIREBASE_PRIVATE_KEY);
  if (projectId && clientEmail && privateKeyRaw) {
    return {
      project_id: projectId,
      client_email: clientEmail,
      private_key: String(privateKeyRaw).replace(/\\n/g, "\n"),
    };
  }

  return null;
}

class NotificationService {
  constructor() {
    this.isInitialized = false;
    this.hasLoggedDisabledState = false;
    this.init();
  }

  init() {
    try {
      if (admin.apps.length > 0) {
        this.isInitialized = true;
        return;
      }

      const serviceAccount = parseServiceAccountFromEnv();
      if (!serviceAccount) {
        console.log(
          "[NotificationService] Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT(_JSON|_BASE64) or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY."
        );
        return;
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });

      this.isInitialized = true;
      console.log("[NotificationService] Firebase Admin initialized.");
    } catch (error) {
      console.error("[NotificationService] Firebase init failed:", error);
    }
  }

  async registerToken(userId, userType, token) {
    if (!token || !userId || !userType) return;
    const pool = await getPool();

    await pool.query(
      `INSERT INTO device_tokens (user_id, user_type, token)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         user_type = VALUES(user_type),
         updated_at = NOW()`,
      [userId, userType, token]
    );
  }

  async removeToken(token) {
    if (!token) return;
    const pool = await getPool();
    await pool.query("DELETE FROM device_tokens WHERE token = ?", [token]);
  }

  async resolveDistanceText(userId, userType, data, pool) {
    const provided = normalizeDistanceLabel(data?.locationDistance || data?.distance);
    if (provided && provided !== "Nearby") return provided;

    if (userType !== "technician") return provided;
    const targetLat = Number(data?.location?.lat ?? data?.location_lat);
    const targetLng = Number(data?.location?.lng ?? data?.location_lng);
    if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return provided;

    const [rows] = await pool.query(
      "SELECT latitude, longitude FROM technicians WHERE id = ? LIMIT 1",
      [userId]
    );
    const tech = rows?.[0];
    const techLat = Number(tech?.latitude);
    const techLng = Number(tech?.longitude);
    if (!Number.isFinite(techLat) || !Number.isFinite(techLng)) return provided;

    const km = haversineKm(techLat, techLng, targetLat, targetLng);
    if (!Number.isFinite(km)) return provided;
    return `${km.toFixed(1)} km`;
  }

  async buildPayload(userId, userType, event, data = {}, pool) {
    const jobId = normalizeText(data?.jobId || data?.requestId || data?.id);
    const basePath = jobId ? `/job/${encodeURIComponent(jobId)}` : "/technician/dashboard";
    const frontendBaseUrl = normalizeText(process.env.FRONTEND_PUBLIC_URL || process.env.FRONTEND_URL).replace(
      /\/+$/,
      ""
    );
    const deepLinkUrl = frontendBaseUrl ? `${frontendBaseUrl}${basePath}` : undefined;

    if (
      userType === "technician" &&
      (event === "job_offer" || event === "job:assigned")
    ) {
      const serviceType = normalizeText(data?.serviceType || data?.service_type || "Roadside Assistance");
      const customerName = normalizeText(data?.customerName || data?.contact_name || "Customer");
      const locationDistance = await this.resolveDistanceText(userId, userType, data, pool);
      const priceAmount = normalizeMoney(data?.priceAmount ?? data?.amount);
      const serviceEmoji = resolveServiceEmoji(serviceType);
      const distanceSummary =
        locationDistance.toLowerCase() === "nearby"
          ? "Nearby"
          : `${locationDistance} away`;

      const body = [
        `\uD83D\uDCCD ${serviceEmoji} ${serviceType} \u2022 ${distanceSummary}`,
        `\uD83D\uDC64 Customer: ${customerName}`,
        `\uD83D\uDCB0 \u20B9${priceAmount}`,
      ].join("\n");

      const payloadData = stringifyDataPayload({
        event,
        jobId,
        requestId: jobId,
        customerName,
        serviceType,
        locationDistance,
        priceAmount,
        deepLinkPath: basePath,
      });

      return {
        notification: {
          title: JOB_ALERT_TITLE,
          body,
        },
        data: payloadData,
        android: {
          priority: "high",
          notification: {
            channelId: "high_priority_alarms",
            sound: "emergency_alarm",
            clickAction: "FCM_PLUGIN_ACTIVITY",
            defaultSound: false,
            defaultVibrateTimings: false,
            vibrateTimingsMillis: [200, 100, 200]
          }
        },
        webpush: {
          headers: {
            Urgency: "high",
            TTL: "120",
          },
          notification: {
            title: JOB_ALERT_TITLE,
            body,
            icon: "/icons/icon-192x192.png",
            badge: "/icons/icon-192x192.png",
            tag: jobId ? `job-${jobId}` : `job-${Date.now()}`,
            requireInteraction: true,
            renotify: true,
            vibrate: [200, 100, 200],
          },
          ...(deepLinkUrl ? { fcmOptions: { link: deepLinkUrl } } : {}),
        },
      };
    }

    if (userType === "technician" && event === "job:status_update") {
      const status = normalizeText(data?.status).toLowerCase();
      if (status !== "cancelled") return null;

      const requestId = normalizeText(data?.requestId || data?.id);
      return {
        notification: {
          title: "Job Cancelled",
          body: requestId
            ? `Customer cancelled request #${requestId}.`
            : "The assigned job was cancelled by the customer.",
        },
        data: stringifyDataPayload({
          event,
          requestId,
          deepLinkPath: requestId ? `/job/${encodeURIComponent(requestId)}` : "/technician/dashboard",
        }),
      };
    }

    if (userType === "technician" && event === "technician:new_review") {
      const rating = Number(data?.rating);
      const ratingText = Number.isFinite(rating) ? `${rating.toFixed(1)} star` : "new";
      return {
        notification: {
          title: "New Rating Received",
          body: Number.isFinite(rating)
            ? `You received a ${ratingText} review.`
            : "You received a new customer rating.",
        },
        data: stringifyDataPayload({
          event,
          deepLinkPath: "/technician/reviews",
        }),
      };
    }

    if (userType === "user" && event === "job:status_update") {
      const status = normalizeText(data?.status).toLowerCase();
      let title = "";
      let body = "";

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
      } else if (status === "cancelled") {
        title = "Request Cancelled";
        body = "Your service request has been cancelled.";
      }

      if (!title || !body) return null;
      const requestId = normalizeText(data?.requestId || data?.id);
      const requestPath = requestId ? `/service-tracking/${encodeURIComponent(requestId)}` : "/";
      const requestLink = frontendBaseUrl ? `${frontendBaseUrl}${requestPath}` : undefined;

      return {
        notification: { title, body },
        data: stringifyDataPayload({
          event,
          requestId,
          deepLinkPath: requestPath,
        }),
        webpush: {
          ...(requestLink ? { fcmOptions: { link: requestLink } } : {}),
        },
      };
    }

    if (userType === "user" && event === "payment_completed") {
      const requestId = normalizeText(data?.requestId || data?.id);
      const requestPath = requestId ? `/service-tracking/${encodeURIComponent(requestId)}` : "/";
      const requestLink = frontendBaseUrl ? `${frontendBaseUrl}${requestPath}` : undefined;
      return {
        notification: {
          title: "Payment Completed",
          body: "Your payment has been successfully processed.",
        },
        data: stringifyDataPayload({
          event,
          requestId,
          deepLinkPath: requestPath,
        }),
        webpush: {
          ...(requestLink ? { fcmOptions: { link: requestLink } } : {}),
        },
      };
    }

    return null;
  }

  async sendPushNotification(userId, userType, event, data = {}) {
    if (!this.isInitialized) {
      if (!this.hasLoggedDisabledState) {
        console.warn("[NotificationService] Push delivery skipped because Firebase is not initialized.");
        this.hasLoggedDisabledState = true;
      }
      return;
    }

    try {
      const pool = await getPool();
      const payload = await this.buildPayload(userId, userType, event, data, pool);
      if (!payload) return;

      const [tokens] = await pool.query(
        "SELECT token FROM device_tokens WHERE user_id = ? AND user_type = ?",
        [userId, userType]
      );
      if (!tokens || tokens.length === 0) return;

      const registrationTokens = tokens.map((entry) => entry.token).filter(Boolean);
      if (registrationTokens.length === 0) return;

      const response = await admin.messaging().sendEachForMulticast({
        ...payload,
        tokens: registrationTokens,
      });

      if (response.failureCount > 0) {
        const invalidTokens = [];
        response.responses.forEach((item, index) => {
          const code = item?.error?.code;
          if (
            !item.success &&
            (code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered")
          ) {
            invalidTokens.push(registrationTokens[index]);
          }
        });

        if (invalidTokens.length > 0) {
          const placeholders = invalidTokens.map(() => "?").join(",");
          await pool.query(`DELETE FROM device_tokens WHERE token IN (${placeholders})`, invalidTokens);
        }
      }
    } catch (error) {
      console.error(`[NotificationService] Failed to send push (${userType} ${userId}):`, error);
    }
  }
}

export const notificationService = new NotificationService();
