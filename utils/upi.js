import { roundMoney } from "./money.js";

export function buildUpiDeepLink({ upiId, name, amount } = {}) {
  const payeeAddress = String(upiId || "").trim();
  const payeeName = String(name || "").trim();
  const resolvedAmount = roundMoney(amount || 0);

  if (!payeeAddress || !payeeName || resolvedAmount <= 0) {
    return null;
  }

  const params = new URLSearchParams({
    pa: payeeAddress,
    pn: payeeName,
    am: resolvedAmount.toFixed(2),
  });

  return `upi://pay?${params.toString()}`;
}
