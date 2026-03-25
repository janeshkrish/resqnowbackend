import { Router } from "express";
import { calculateFinalPrice } from "../services/pricing.service.js";
import { getPlatformPricingConfig } from "../services/platformPricing.js";
import { fetchTechnicianPricingDefinition } from "../services/technicianPricingStore.js";

const router = Router();

const normalizeOptionalDistance = (value) => {
  if (value == null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  return value;
};

router.post("/calculate", async (req, res) => {
  try {
    const technicianId = req.body?.technician_id ?? req.body?.technicianId;
    const serviceType = req.body?.service_type;
    const vehicleType = req.body?.vehicle_type;
    const timeOfDay = req.body?.time_of_day;
    const distanceKm = normalizeOptionalDistance(req.body?.distance_km);

    if (technicianId == null) {
      return res.status(400).json({ error: "technician_id is required." });
    }
    if (!serviceType) {
      return res.status(400).json({ error: "service_type is required." });
    }
    if (!vehicleType) {
      return res.status(400).json({ error: "vehicle_type is required." });
    }
    if (!timeOfDay) {
      return res.status(400).json({ error: "time_of_day is required." });
    }

    const [pricingConfig, pricingDefinition] = await Promise.all([
      getPlatformPricingConfig(),
      fetchTechnicianPricingDefinition({
        technicianId,
        serviceType,
        vehicleType,
      }),
    ]);

    if (!pricingDefinition?.technician_pricing) {
      return res.status(404).json({ error: "Technician pricing not found for the requested service." });
    }

    const result = calculateFinalPrice(
      {
        service_type: pricingDefinition.service_type,
        vehicle_type: pricingDefinition.vehicle_type,
        technician_pricing: pricingDefinition.technician_pricing,
        distance_km: distanceKm,
        time_of_day: timeOfDay,
      },
      {
        platform_fee_percent: pricingConfig.platform_fee_percent,
        payment_fee_percent: pricingConfig.payment_fee_percent,
        customer_price_rounding_increment: pricingConfig.customer_price_rounding_increment,
      }
    );

    return res.json(result);
  } catch (err) {
    const message = String(err?.message || "Failed to calculate pricing.");
    if (
      message.includes("required") ||
      message.includes("invalid") ||
      message.includes("unsupported") ||
      message.includes("cannot be negative") ||
      message.includes("must be")
    ) {
      return res.status(400).json({ error: message });
    }

    console.error("[Pricing calculate]", err);
    return res.status(500).json({ error: "Failed to calculate pricing." });
  }
});

export default router;
