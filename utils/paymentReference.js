import { createHash } from "node:crypto";

// Razorpay receipts are limited to 40 characters. Hash the complete reference
// when UUIDs make it longer, retaining its purpose and all uniqueness inputs.
export function compactPaymentReceipt(value) {
  const receipt = String(value);
  if (receipt.length <= 40) return receipt;
  const prefix = receipt.split("_")[0].replace(/[^a-zA-Z0-9]/g, "").slice(0, 7) || "order";
  return `${prefix}_${createHash("sha256").update(receipt).digest("hex").slice(0, 32)}`;
}

export function boundedIdempotencyKey(value) {
  const key = String(value || "").trim();
  return key.length <= 128 ? key : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}
