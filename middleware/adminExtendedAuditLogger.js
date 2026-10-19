import { adminActorId } from "../models/userIdentity.js";
import { getPool } from "../db.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { recordHttpAudit } from "../models/audit.js";

const adminExtendedRedactedKeys = new Set([
  "password",
  "token",
  "authorization",
  "otp",
  "secret",
  "signature",
]);

function adminExtendedSanitizeValue(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => adminExtendedSanitizeValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};
    const entries = Object.entries(value).slice(0, 25);

    for (const [key, nestedValue] of entries) {
      const normalizedKey = String(key || "").toLowerCase();
      result[key] = adminExtendedRedactedKeys.has(normalizedKey)
        ? "[redacted]"
        : adminExtendedSanitizeValue(nestedValue, depth + 1);
    }
    return result;
  }

  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}...[truncated]`;
  }

  return value;
}

function adminExtendedResolveAuditTargetId(req) {
  return (
    req.params?.requestId ||
    req.params?.technicianId ||
    req.params?.complaintId ||
    req.params?.id ||
    req.body?.requestId ||
    req.body?.technicianId ||
    req.body?.complaintId ||
    null
  );
}

function adminExtendedResolveAdminId(req) {
  return adminActorId(req);
}

export function adminExtendedAuditLogger(req, res, next) {
  const startedAt = Date.now();

  res.on("finish", () => {
    void (async () => {
      try {
        await ensureAdminExtendedSchema();
        const pool = await getPool();

        const actionType = String(
          req.adminExtendedActionType || `adminExtended:${req.method}:${req.baseUrl}${req.path}`
        );
        const targetId = adminExtendedResolveAuditTargetId(req);

        const metadata = {
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
          query: adminExtendedSanitizeValue(req.query),
          body: adminExtendedSanitizeValue(req.body),
          params: adminExtendedSanitizeValue(req.params),
        };

        await recordHttpAudit(pool, { adminId: adminExtendedResolveAdminId(req), actionType,
          targetId: targetId ? String(targetId) : null, metadata });
      } catch (error) {
        console.error("[adminExtendedAuditLogger] Failed to write audit log:", error?.message || error);
      }
    })();
  });

  return next();
}
