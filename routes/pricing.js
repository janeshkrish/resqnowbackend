import { Router } from "express";
import rateLimit from "express-rate-limit";
import { calculateFinalPrice } from "../services/pricing.service.js";
import { getPlatformPricingConfig } from "../services/platformPricing.js";
import { fetchTechnicianPricingDefinition } from "../services/technicianPricingStore.js";
import { verifyUser } from "../middleware/auth.js";
import { buildTowingQuote, normalizeTowingQuoteError } from "../services/towingQuoteService.js";

const router = Router();

const towingEstimateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many towing estimate requests. Please try again shortly." },
});

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

router.post("/towing-estimate", verifyUser, towingEstimateLimiter, async (req, res) => {
  try {
    const quote = await buildTowingQuote({
      ...req.body,
      paymentMode: req.body?.paymentMode || req.body?.payment_mode || "upi",
    });

    return res.json({
      success: true,
      quote,
      distanceKm: quote.distance_km,
      estimatedDuration: quote.estimated_duration,
      routeMetadata: quote.route_metadata,
      pricingBreakdown: quote.pricing_breakdown,
      finalEstimatedPrice: quote.final_estimated_price,
    });
  } catch (err) {
    if (err?.statusCode && err.statusCode < 500) {
      const normalized = normalizeTowingQuoteError(err);
      return res.status(normalized.statusCode).json(normalized.payload);
    }

    console.error("[Pricing towing-estimate]", err);
    const normalized = normalizeTowingQuoteError(err);
    return res.status(normalized.statusCode).json(normalized.payload);
  }
});

export default router;
