export const ADMIN_NOTIFICATION_TYPES = Object.freeze({
  NEW_TECHNICIAN_APPLICATION: "NEW_TECHNICIAN_APPLICATION",
  TECHNICIAN_APPROVED: "TECHNICIAN_APPROVED",
  SYSTEM_ALERT: "SYSTEM_ALERT",
});

const ADMIN_NOTIFICATION_ALIASES = Object.freeze({
  [ADMIN_NOTIFICATION_TYPES.NEW_TECHNICIAN_APPLICATION]: [
    "new_technician_application",
    "technician_application",
  ],
  [ADMIN_NOTIFICATION_TYPES.TECHNICIAN_APPROVED]: [
    "technician_approved",
  ],
  [ADMIN_NOTIFICATION_TYPES.SYSTEM_ALERT]: [
    "system_alert",
    "system_announcement",
    "emergency_message",
    "technician_broadcast",
  ],
});

export const ADMIN_NOTIFICATION_TYPE_FILTER_VALUES = Object.freeze(
  Array.from(
    new Set(
      Object.values(ADMIN_NOTIFICATION_ALIASES)
        .flat()
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    )
  )
);

export function normalizeAdminNotificationType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;

  for (const [canonicalType, aliases] of Object.entries(ADMIN_NOTIFICATION_ALIASES)) {
    if (aliases.includes(normalized)) {
      return canonicalType;
    }
  }
  return null;
}
