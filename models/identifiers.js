import { createHash, randomUUID } from "node:crypto";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const createId = () => randomUUID();
export const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);

// Legacy integers remain readable at service boundaries during the offline cutover.
// All new persistence IDs are UUIDs; the database guard rejects numeric schemas.
export function recordId(value) {
  if (isUuid(value)) return value.toLowerCase();
  if ((typeof value === "number" || typeof value === "string") && /^[1-9]\d*$/.test(String(value))) {
    const legacy = Number(value);
    if (Number.isSafeInteger(legacy)) return legacy;
  }
  return null;
}

export const isRecordId = (value) => recordId(value) !== null;

// Stable UUIDv5 mapping lets an interrupted migration resume without a mapping table.
const MIGRATION_NAMESPACE = Buffer.from("d3738ebdf8334d20a1ca594d168bf276", "hex");
export function migratedId(table, value) {
  if (isUuid(value)) return value.toLowerCase();
  if (value == null || value === "") return null;
  const bytes = createHash("sha1").update(MIGRATION_NAMESPACE).update(`${table}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
