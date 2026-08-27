import { canonicalizeServiceDomain } from "./serviceNormalization.js";

export function isTowingServiceType(serviceType) {
  return canonicalizeServiceDomain(String(serviceType || "").replace(/^(car|bike|ev|commercial)-/i, "")) === "towing";
}
