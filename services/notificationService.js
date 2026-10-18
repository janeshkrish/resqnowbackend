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

function firstNameOf(name) {
  return normalizeText(name).split(/\s+/)[0] || "Your technician";
}

/** "Flat tyre" for "flat_tire", "Towing" for "Towing Service" and the like. */
function customerServiceLabel(serviceType) {
  const type = normalizeText(serviceType).toLowerCase();
  if (!type) return "Your request";
  if (type.includes("tow")) return "Towing";
  if (type.includes("winch")) return "Winching";
  if (/flat|tyre|tire|puncture/.test(type)) return "Flat tyre";
  if (type.includes("ev") && type.includes("charg")) return "EV charging";
  if (type.includes("battery") || type.includes("jump")) return "Battery";
  if (type.includes("fuel")) return "Fuel delivery";
  if (type.includes("lock") || type.includes("key")) return "Lockout";
  if (/mechan|repair|engine/.test(type)) return "Mechanic";
  const words = normalizeText(serviceType).replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a customer's phone says at each step of a request, in the words of the app's
 * tracking screen (src/lib/customerTracking.ts). Null for a step that sends no push.
 */
export function customerTripCopy(status, technicianName, serviceType) {
  const first = firstNameOf(technicianName);
  const service = customerServiceLabel(serviceType);
  switch (normalizeText(status).toLowerCase()) {
    case "accepted":
      return { title: `${first} accepted your request`, body: `${service} · getting ready to leave.` };
    case "on-the-way":
    case "en-route":
    case "en_route_pickup":
      return { title: `${first} is on the way`, body: "Open the app to see the minutes and the live map." };
    case "arrived":
    case "arrived_pickup":
      return { title: `${first} is here`, body: "Meet your technician at the vehicle." };
    case "in-progress":
    case "in_progress":
    case "service_started":
      return { title: "Work in progress", body: `${first} is working on your vehicle.` };
    case "vehicle_loaded":
      return { title: "Vehicle loaded", body: "Your vehicle is secured on the tow truck." };
    case "enroute_drop":
      return { title: "Towing to the drop point", body: "Open the app to follow the tow truck." };
    case "arrived_drop":
      return { title: "Reached the drop point", body: "Final confirmation is next." };
    case "completed":
    case "service_completed":
    case "awaiting_payment":
    case "payment_pending":
      return { title: "Work done · payment is next", body: `Pay online, or give cash to ${first}.` };
    case "paid":
      return { title: "Paid · thank you", body: `How was ${first}? One tap is enough.` };
    case "cancelled":
      return { title: "Request cancelled", body: "You can send a new request any time." };
    default:
      return null;
  }
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

  /**
   * Who is coming and for what, so a customer's push can say "Arun is here" rather than
   * "Technician Arrived". Never holds a push back: on any failure it returns what it has.
   */
  async resolveCustomerTrip(requestId, data = {}, pool) {
    const trip = {
      technicianName: normalizeText(data?.technicianName || data?.technician_name),
      technicianPhone: normalizeText(data?.technicianPhone || data?.technician_phone),
      serviceType: normalizeText(data?.serviceType || data?.service_type),
    };
    if (!pool || !requestId || (trip.technicianName && trip.serviceType)) return trip;
    try {
      const [rows] = await pool.query(
        `SELECT sr.service_type, t.name AS technician_name, t.phone AS technician_phone
           FROM service_requests sr
           LEFT JOIN technicians t ON t.id = sr.technician_id
          WHERE sr.id = ?
          LIMIT 1`,
        [requestId]
      );
      const row = rows?.[0] || {};
      return {
        technicianName: trip.technicianName || normalizeText(row.technician_name),
        technicianPhone: trip.technicianPhone || normalizeText(row.technician_phone),
        serviceType: trip.serviceType || normalizeText(row.service_type),
      };
    } catch (error) {
      console.warn(`[NotificationService] Trip details unavailable for request ${requestId}:`, error?.message || error);
      return trip;
    }
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
      const status = normalizeText(data?.status || data?.job_status || "");
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
        type: "EMERGENCY_JOB",
        channelId: "job_offers",
        sound: "job_ring",
        title: JOB_ALERT_TITLE,
        body,
        jobId,
        requestId: jobId,
        customerName,
        serviceType,
        status,
        locationDistance,
        priceAmount,
        deepLinkPath: basePath,
      });

      return {
        // Keep emergency technician alerts as data-first so Android native service
        // can always build full-screen intent notifications (foreground/background/terminated).
        data: payloadData,
        android: {
          priority: "high",
          collapseKey: jobId ? `job_${jobId}` : "job_offer",
          ttl: 120000,
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

    if (userType === "technician" && event === "job:revoked") {
      const requestId = normalizeText(data?.requestId || data?.jobId || data?.id);
      const body = requestId
        ? `Job #${requestId} has already been taken by another technician.`
        : "This job has already been taken by another technician.";
      const dashboardPath = "/technician/dashboard";
      const dashboardLink = frontendBaseUrl ? `${frontendBaseUrl}${dashboardPath}` : undefined;

      return {
        // Data-first payload ensures Android can close full-screen alerts immediately.
        data: stringifyDataPayload({
          event,
          type: "JOB_REVOKED",
          title: "Job Offer Closed",
          body,
          requestId,
          jobId: requestId,
          deepLinkPath: dashboardPath,
        }),
        android: {
          priority: "high",
          collapseKey: requestId ? `job_${requestId}` : "job_offer_closed",
          ttl: 120000,
        },
        webpush: {
          headers: {
            Urgency: "high",
            TTL: "120",
          },
          notification: {
            title: "Job Offer Closed",
            body,
            icon: "/icons/icon-192x192.png",
            badge: "/icons/icon-192x192.png",
            tag: requestId ? `job-closed-${requestId}` : `job-closed-${Date.now()}`,
          },
          ...(dashboardLink ? { fcmOptions: { link: dashboardLink } } : {}),
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

    if (userType === "technician" && event === "technician:login_reminder") {
      const title = normalizeText(data?.title || "Please log in to ResQNow");
      const body = normalizeText(
        data?.message ||
          "You have been inactive for a while. Log in to keep receiving job requests."
      );
      const dashboardPath = "/technician/login";
      const dashboardLink = frontendBaseUrl ? `${frontendBaseUrl}${dashboardPath}` : undefined;

      return {
        notification: { title, body },
        data: stringifyDataPayload({
          event,
          type: "LOGIN_REMINDER",
          priority: "HIGH",
          deepLinkPath: dashboardPath,
          inactivityMinutes: data?.inactivityMinutes ?? "",
        }),
        android: {
          priority: "high",
          ttl: 1800000,
        },
        webpush: {
          headers: {
            Urgency: "high",
            TTL: "1800",
          },
          notification: {
            title,
            body,
            icon: "/icons/icon-192x192.png",
            badge: "/icons/icon-192x192.png",
            tag: `tech-login-reminder-${Date.now()}`,
            requireInteraction: true,
          },
          ...(dashboardLink ? { fcmOptions: { link: dashboardLink } } : {}),
        },
      };
    }

    if (
      userType === "technician" &&
      (event === "admin:system_announcement" ||
        event === "admin:technician_broadcast" ||
        event === "admin:emergency_message")
    ) {
      const title = normalizeText(data?.title || "Admin Announcement");
      const body = normalizeText(data?.message || "You have a new admin notification.");
      const isEmergency =
        event === "admin:emergency_message" ||
        String(data?.priority || "").trim().toUpperCase() === "HIGH";
      const dashboardPath = "/technician/dashboard";
      const dashboardLink = frontendBaseUrl ? `${frontendBaseUrl}${dashboardPath}` : undefined;

      return {
        notification: { title, body },
        data: stringifyDataPayload({
          event,
          type: "ADMIN_BROADCAST",
          priority: isEmergency ? "HIGH" : "NORMAL",
          sound: isEmergency ? "true" : "false",
          deepLinkPath: dashboardPath,
        }),
        android: {
          priority: isEmergency ? "high" : "normal",
          ttl: isEmergency ? 300000 : 1800000,
        },
        webpush: {
          headers: {
            Urgency: isEmergency ? "high" : "normal",
            TTL: isEmergency ? "300" : "1800",
          },
          notification: {
            title,
            body,
            icon: "/icons/icon-192x192.png",
            badge: "/icons/icon-192x192.png",
            tag: `admin-${isEmergency ? "emergency" : "alert"}-${Date.now()}`,
            requireInteraction: isEmergency,
            renotify: isEmergency,
            ...(isEmergency ? { vibrate: [200, 100, 200] } : {}),
          },
          ...(dashboardLink ? { fcmOptions: { link: dashboardLink } } : {}),
        },
      };
    }

    if (userType === "user" && (event === "job:status_update" || event === "payment_completed")) {
      const status = event === "payment_completed" ? "paid" : normalizeText(data?.status).toLowerCase();
      const requestId = normalizeText(data?.requestId || data?.id);
      const trip = await this.resolveCustomerTrip(requestId, data, pool);
      const copy = customerTripCopy(status, trip.technicianName, trip.serviceType);
      if (!copy) return null;
      const requestPath = requestId ? `/service-tracking/${encodeURIComponent(requestId)}` : "/";
      const requestLink = frontendBaseUrl ? `${frontendBaseUrl}${requestPath}` : undefined;

      return {
        // Data only, so the Android app updates the request's one Live Update in place
        // (TripUpdateNotifier) instead of stacking a new notification for every step.
        // Older app versions show title and body from these fields as a plain notification.
        data: stringifyDataPayload({
          event,
          type: "TRIP_UPDATE",
          status,
          requestId,
          title: copy.title,
          body: copy.body,
          technicianName: trip.technicianName,
          technicianPhone: trip.technicianPhone,
          serviceType: trip.serviceType,
          deepLinkPath: requestPath,
        }),
        android: {
          priority: "high",
          collapseKey: requestId ? `trip_${requestId}` : "trip_update",
          ttl: 3600000,
        },
        webpush: {
          notification: {
            title: copy.title,
            body: copy.body,
            icon: "/icons/icon-192x192.png",
            badge: "/icons/icon-192x192.png",
            tag: requestId ? `trip-${requestId}` : `trip-${Date.now()}`,
          },
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
      const registrationTokens = (tokens || []).map((entry) => entry.token).filter(Boolean);
      const isJobOffer = userType === "technician" && event === "job_offer";
      if (registrationTokens.length === 0) {
        if (isJobOffer) {
          console.warn(
            `[NotificationService] Technician ${userId} has no registered device; the job alert reaches only an open app.`
          );
        }
        return;
      }

      const response = await admin.messaging().sendEachForMulticast({
        ...payload,
        tokens: registrationTokens,
      });
      if (isJobOffer) {
        const failures = response.responses
          .map((item) => item?.error?.code)
          .filter(Boolean);
        console.log(
          `[NotificationService] Job alert push technician=${userId} request=${payload.data?.requestId || ""} sent=${response.successCount} failed=${response.failureCount}${failures.length ? ` errors=${failures.join(",")}` : ""}`
        );
      }

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
