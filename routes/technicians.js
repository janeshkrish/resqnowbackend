
import { Router } from "express";
import { socketService } from "../services/socket.js";
import bcrypt from "bcryptjs";
import * as db from "../db.js";
import * as mail from "../services/mailer.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import { verifyTechnician, verifyAdmin, signTechnicianToken } from "../middleware/auth.js";
import {
  canonicalizeServiceDomain,
  canonicalizeVehicleFamily,
  normalizeSpecialties,
  normalizeVehicleTypes,
  normalizeServiceCosts,
} from "../services/serviceNormalization.js";
import { normalizeTechnicianPricingEntries } from "../models/technicianPricing.js";
import {
  indexTechnicianPricingRows,
  resolveTechnicianDisplayPrice,
} from "../services/technicianPriceDisplay.js";
import { estimateTechnicianPayoutAsync } from "../services/pricingEstimator.js";
import { getPlatformPricingConfig } from "../services/platformPricing.js";
import { ADMIN_NOTIFICATION_TYPES } from "../services/adminNotificationTypes.js";
import { replaceTechnicianPricingRows, replaceTechnicianFleetVehicles } from "../services/technicianPricingStore.js";
import {
  getTechnicianWalletSummary,
  getTechnicianWalletTransactionHistory,
} from "../services/marketplaceWalletService.js";
import {
  createWithdrawalRequest,
  getTechnicianWithdrawalRequests,
} from "../services/marketplaceWithdrawalService.js";
import { buildServiceRequestPaymentDetails } from "../services/serviceRequestPaymentService.js";
import { isTowingServiceType } from "../services/towingServiceType.js";
import {
  markTechnicianHeartbeat,
  markTechnicianLogin,
  markTechnicianLogout,
} from "../services/technicianActivityService.js";
import { sendEventEmail } from "../utils/eventEmail.js";
import * as technicianPricingController from "../controllers/technicianPricingController.js";


const router = Router();
const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || "");
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || "");
const hasRazorpayConfig = Boolean(
  RAZORPAY_KEY_ID &&
  RAZORPAY_KEY_SECRET &&
  !RAZORPAY_KEY_ID.includes("placeholder") &&
  !RAZORPAY_KEY_SECRET.includes("placeholder")
);
const razorpay = hasRazorpayConfig
  ? new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  })
  : null;

const ensureRazorpayConfigured = (res) => {
  if (hasRazorpayConfig) return true;
  res.status(503).json({
    error: "Payment gateway is not configured. Please contact support."
  });
  return false;
};

const DEFAULT_TECHNICIAN_SETTINGS = Object.freeze({
  appearance: {
    theme: "system"
  },
  notifications: {
    email_notifications: true,
    push_notifications: true
  },
  navigation: {
    mobile_bottom_nav_enabled: true,
    auto_hide_bottom_nav: true
  }
});

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

const parseObject = (value) => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isPlainObject(value) ? value : {};
};

const KNOWN_DOCUMENT_KEYS = ["garage_front", "profile_photo", "tools_photo", "facilities_photo"];

function normalizeUploadResourcePath(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";

  if (raw.startsWith("/api/upload/files/")) {
    return raw;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const pathname = String(parsed.pathname || "").trim();
      if (pathname.startsWith("/api/upload/files/")) {
        return pathname;
      }
      return raw;
    } catch {
      return raw;
    }
  }

  if (/^api\/upload\/files\//i.test(raw)) {
    return `/${raw.replace(/^\/+/, "")}`;
  }

  return raw;
}

function sanitizeTechnicianDocuments(rawDocuments) {
  const parsed = parseObject(rawDocuments);
  const cleaned = {};
  for (const key of KNOWN_DOCUMENT_KEYS) {
    cleaned[key] = normalizeUploadResourcePath(parsed[key]);
  }
  return cleaned;
}

const normalizeTechnicianSettings = (existingValue, patchValue = null) => {
  const existing = parseObject(existingValue);
  const patch = parseObject(patchValue);

  const settings = {
    appearance: {
      ...DEFAULT_TECHNICIAN_SETTINGS.appearance,
      ...(isPlainObject(existing.appearance) ? existing.appearance : {}),
      ...(isPlainObject(patch.appearance) ? patch.appearance : {})
    },
    notifications: {
      ...DEFAULT_TECHNICIAN_SETTINGS.notifications,
      ...(isPlainObject(existing.notifications) ? existing.notifications : {}),
      ...(isPlainObject(patch.notifications) ? patch.notifications : {})
    },
    navigation: {
      ...DEFAULT_TECHNICIAN_SETTINGS.navigation,
      ...(isPlainObject(existing.navigation) ? existing.navigation : {}),
      ...(isPlainObject(patch.navigation) ? patch.navigation : {})
    }
  };

  if (!["light", "dark", "system"].includes(String(settings.appearance.theme || ""))) {
    settings.appearance.theme = "system";
  }
  settings.notifications.email_notifications = !!settings.notifications.email_notifications;
  settings.notifications.push_notifications = !!settings.notifications.push_notifications;
  settings.navigation.mobile_bottom_nav_enabled = settings.navigation.mobile_bottom_nav_enabled !== false;
  settings.navigation.auto_hide_bottom_nav = settings.navigation.auto_hide_bottom_nav !== false;
  return settings;
};

function rowToTechnician(row) {
  const status = (row.status || "pending").toLowerCase();
  const verification_status = status === "approved" ? "verified" : status === "rejected" ? "rejected" : "pending";

  let specialties = [];
  let pricing = {};
  let working_hours = {};
  let service_costs = {};
  let payment_details = {};
  let app_readiness = {};
  let vehicle_types = {};
  let documents = {};
  let settings = {};

  try { if (row.specialties) specialties = typeof row.specialties === "string" ? JSON.parse(row.specialties) : row.specialties; } catch { }
  try { if (row.pricing) pricing = typeof row.pricing === "string" ? JSON.parse(row.pricing) : row.pricing; } catch { }
  try { if (row.working_hours) working_hours = typeof row.working_hours === "string" ? JSON.parse(row.working_hours) : row.working_hours; } catch { }
  try { if (row.service_costs) service_costs = typeof row.service_costs === "string" ? JSON.parse(row.service_costs) : row.service_costs; } catch { }
  try { if (row.payment_details) payment_details = typeof row.payment_details === "string" ? JSON.parse(row.payment_details) : row.payment_details; } catch { }
  try { if (row.app_readiness) app_readiness = typeof row.app_readiness === "string" ? JSON.parse(row.app_readiness) : row.app_readiness; } catch { }
  try { if (row.vehicle_types) vehicle_types = typeof row.vehicle_types === "string" ? JSON.parse(row.vehicle_types) : row.vehicle_types; } catch { }
  try { if (row.documents) documents = typeof row.documents === "string" ? JSON.parse(row.documents) : row.documents; } catch { }
  try { if (row.settings) settings = typeof row.settings === "string" ? JSON.parse(row.settings) : row.settings; } catch { }
  const normalizedDocuments = sanitizeTechnicianDocuments(documents);
  const operationalRole =
    canonicalizeServiceDomain(row.service_type || specialties?.[0] || "technician") || "technician";

  return {
    id: String(row.id),
    role: operationalRole,
    account_role: "technician",
    operational_role: operationalRole,
    name: row.name,
    email: row.email,
    phone: row.phone || "",
    upi_id: row.upi_id || payment_details?.upi_id || "",
    upi_name: row.upi_name || payment_details?.upi_name || row.proprietor_name || row.name || "",
    proprietor_name: row.proprietor_name || "",
    alternate_phone: row.alternate_phone || "",
    whatsapp_number: row.whatsapp_number || "",
    address: row.address || "",
    region: row.region || "",
    district: row.district || "",
    state: row.state || "",
    locality: row.locality || "",
    google_maps_link: row.google_maps_link || "",
    aadhaar_number: row.aadhaar_number || "",
    pan_number: row.pan_number || "",
    business_type: row.business_type || "",
    gst_number: row.gst_number || "",
    trade_license_number: row.trade_license_number || "",
    service_type: row.service_type || "General",
    serviceAreaRange: row.service_area_range ?? 0,
    experience: row.experience ?? 0,
    specialties: Array.isArray(specialties) ? specialties : [],
    pricing: pricing && typeof pricing === "object" ? pricing : {},
    working_hours,
    service_costs,
    payment_details,
    app_readiness,
    vehicle_types,
    verification_status,
    settings: normalizeTechnicianSettings(settings),
    resume_url: normalizeUploadResourcePath(row.resume_url || ""),
    documents: normalizedDocuments,
    rating: parseFloat(row.rating || 5.0),
    jobs_completed: parseInt(row.jobs_completed || 0),
    total_earnings: parseFloat(row.total_earnings || 0.00),
    latitude: row.latitude ? parseFloat(row.latitude) : null,
    longitude: row.longitude ? parseFloat(row.longitude) : null,
    is_active: !!row.is_active,
    is_available: !!row.is_available,
    is_logged_in: !!row.is_logged_in,
    last_login_at: row.last_login_at || null,
    last_logout_at: row.last_logout_at || null,
    last_seen_at: row.last_seen_at || null
  };
}

const toPositiveMoney = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const toMoneyOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const roundMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

const hasTowingRouteData = (row) =>
  isTowingServiceType(row?.service_type) ||
  row?.drop_address != null ||
  row?.route_distance_km != null;

const toNullableObject = (value) => {
  const parsed = parseObject(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
};

const buildTechnicianRouteFields = (row = {}) => {
  const dropLatitude = toOptionalNumber(row.drop_latitude ?? row.dropLatitude);
  const dropLongitude = toOptionalNumber(row.drop_longitude ?? row.dropLongitude);
  const dropAddress = toOptionalString(row.drop_address ?? row.dropAddress);
  const routeDistanceKm = toOptionalNumber(row.route_distance_km ?? row.routeDistanceKm);
  const estimatedDuration = toOptionalNumber(row.estimated_duration ?? row.estimatedDuration);
  const pricingBreakdown = toNullableObject(row.pricing_breakdown_json ?? row.pricingBreakdown);
  const routeMetadata = toNullableObject(row.route_metadata_json ?? row.routeMetadata);
  const technicianEstimatedEarning = toPositiveMoney(
    row.technician_estimated_earning ?? row.technicianEstimatedEarning ?? row.estimatedEarnings
  );

  return {
    drop_address: dropAddress,
    dropAddress,
    drop_latitude: dropLatitude,
    drop_longitude: dropLongitude,
    dropLocation: dropAddress || dropLatitude != null || dropLongitude != null
      ? {
          lat: dropLatitude,
          lng: dropLongitude,
          address: dropAddress || "",
        }
      : null,
    route_distance_km: routeDistanceKm,
    routeDistanceKm,
    estimated_duration: estimatedDuration,
    estimatedDuration,
    routeMetadata,
    routeGeometry: routeMetadata?.geometry || null,
    routePolyline: Array.isArray(routeMetadata?.polyline) ? routeMetadata.polyline : null,
    pricingBreakdown,
    pricing_breakdown: pricingBreakdown,
    vehicleCategory: pricingBreakdown?.vehicle_category || row.vehicle_category || null,
    estimated_price: toOptionalNumber(row.estimated_price),
    final_price: toOptionalNumber(row.final_price),
    technician_estimated_earning: technicianEstimatedEarning,
    technicianEstimatedEarning,
    estimatedEarnings: technicianEstimatedEarning,
  };
};

async function fetchTechnicianFinancialSnapshot(pool, technicianId) {
  const wallet = await getTechnicianWalletSummary(pool, technicianId);
  const [paymentDueRows] = await pool.query(
    `
    SELECT IFNULL(SUM(COALESCE(p.platform_fee, 0)), 0) AS total
    FROM payments p
    JOIN service_requests sr ON sr.id = p.service_request_id
    WHERE sr.technician_id = ?
      AND LOWER(COALESCE(p.payment_method, '')) = 'cash'
      AND LOWER(COALESCE(p.status, '')) = 'completed'
      AND COALESCE(p.is_settled, FALSE) = FALSE
    `,
    [technicianId]
  );
  const [legacyDueRows] = await pool.query(
    `
    SELECT IFNULL(SUM(COALESCE(amount, 0)), 0) AS total
    FROM technician_dues
    WHERE technician_id = ?
      AND LOWER(COALESCE(status, '')) = 'pending'
    `,
    [technicianId]
  );
  const computedPendingDues = roundMoney(paymentDueRows?.[0]?.total || 0);
  const legacyPendingDues = roundMoney(legacyDueRows?.[0]?.total || 0);
  const pendingDues = computedPendingDues > 0 ? computedPendingDues : legacyPendingDues;

  return {
    total_earnings: roundMoney(wallet.total_earned || 0),
    withdrawable_balance: roundMoney(wallet.withdrawable_balance || 0),
    total_paid_out: roundMoney(wallet.total_paid_out || 0),
    on_hold_balance: roundMoney(wallet.on_hold_balance || 0),
    pending_dues: pendingDues,
    currency: wallet.currency || "INR",
  };
}

const TECHNICIAN_FLEET_STATUSES = new Set(["available", "busy", "offline"]);
const TECHNICIAN_TEAM_MEMBER_ROLES = new Set(["driver", "helper"]);
const TECHNICIAN_TEAM_MEMBER_STATUSES = new Set(["active", "offline"]);

function normalizeTechnicianFleetVehicleType(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTechnicianFleetStatus(value, fallback = "available") {
  const normalized = String(value || "").trim().toLowerCase();
  return TECHNICIAN_FLEET_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeTechnicianTeamRole(value, fallback = "driver") {
  const normalized = String(value || "").trim().toLowerCase();
  return TECHNICIAN_TEAM_MEMBER_ROLES.has(normalized) ? normalized : fallback;
}

function normalizeTechnicianTeamStatus(value, fallback = "active") {
  const normalized = String(value || "").trim().toLowerCase();
  return TECHNICIAN_TEAM_MEMBER_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeOptionalText(value, maxLength = 255) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeRequiredText(value, maxLength = 255) {
  const normalized = normalizeOptionalText(value, maxLength);
  return normalized || "";
}

function normalizeOptionalNumericIdentifier(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function technicianHasTowingAccess(row) {
  const categories = [row?.service_type, ...parseTechnicianSpecialties(row?.specialties)];
  return categories.some((category) => canonicalizeServiceDomain(category) === "towing");
}

async function requireTowingTechnicianAccess(req, res) {
  const rows = await db.query(
    "SELECT id, service_type, specialties FROM technicians WHERE id = ? LIMIT 1",
    [req.technicianId]
  );
  const technicianRow = rows?.[0] || null;

  if (!technicianRow) {
    res.status(404).json({ error: "Technician not found." });
    return null;
  }

  if (!technicianHasTowingAccess(technicianRow)) {
    res.status(403).json({
      error: "Fleet and team management is available only for towing technicians.",
    });
    return null;
  }

  return technicianRow;
}

function mapTechnicianFleetVehicle(row) {
  return {
    id: String(row.id),
    vehicle_id: String(row.id),
    technician_id: String(row.technician_id),
    vehicle_type: row.vehicle_type,
    vehicle_number: row.vehicle_number,
    capacity: row.capacity || null,
    status: normalizeTechnicianFleetStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapTechnicianTeamMember(row) {
  const assignedVehicleId = row.assigned_vehicle_id != null ? String(row.assigned_vehicle_id) : null;
  const assignedVehicle =
    assignedVehicleId && row.assigned_vehicle_number
      ? {
          id: assignedVehicleId,
          vehicle_id: assignedVehicleId,
          vehicle_number: row.assigned_vehicle_number,
          vehicle_type: row.assigned_vehicle_type,
        }
      : null;

  return {
    id: String(row.id),
    employee_id: String(row.id),
    technician_id: String(row.technician_id),
    name: row.name,
    phone: row.phone,
    role: normalizeTechnicianTeamRole(row.role),
    status: normalizeTechnicianTeamStatus(row.status),
    assigned_vehicle_id: assignedVehicleId,
    assigned_vehicle: assignedVehicle,
    assigned_vehicle_label: assignedVehicle
      ? `${assignedVehicle.vehicle_number} (${assignedVehicle.vehicle_type})`
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function assertAssignedVehicleBelongsToTechnician(pool, technicianId, vehicleId) {
  if (vehicleId == null) return null;

  const [rows] = await pool.query(
    `SELECT id, technician_id, vehicle_type, vehicle_number, capacity, status, created_at, updated_at
     FROM technician_fleet_vehicles
     WHERE id = ? AND technician_id = ?
     LIMIT 1`,
    [vehicleId, technicianId]
  );

  return rows?.[0] || null;
}

const TECHNICIAN_CATEGORY_ALIASES = new Map([
  ["towing", "towing"],
  ["tow", "towing"],
  ["towing assistance", "towing"],
  ["towing services", "towing"],
  ["battery", "battery_jumpstart"],
  ["battery jumpstart", "battery_jumpstart"],
  ["battery jump start", "battery_jumpstart"],
  ["battery_jumpstart", "battery_jumpstart"],
  ["fuel", "fuel_delivery"],
  ["fuel delivery", "fuel_delivery"],
  ["fuel_delivery", "fuel_delivery"],
  ["lockout", "lockout_assistance"],
  ["lockout assistance", "lockout_assistance"],
  ["lockout_assistance", "lockout_assistance"],
  ["tire change", "tire_change"],
  ["tyre change", "tire_change"],
  ["tire_change", "tire_change"],
  ["tyre_change", "tire_change"],
  ["flat tire", "tire_change"],
  ["flat tyre", "tire_change"],
  ["flat-tire", "tire_change"],
  ["flat_tire", "tire_change"],
  ["puncture", "tire_change"],
  ["puncture repair", "tire_change"],
  ["tyre puncture repair", "tire_change"],
  ["tyre / puncture repair", "tire_change"],
]);

function normalizeTechnicianFilterToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function resolveTechnicianCategory(value) {
  const normalized = normalizeTechnicianFilterToken(value);
  if (!normalized) return "";
  return TECHNICIAN_CATEGORY_ALIASES.get(normalized) || normalized.replace(/\s+/g, "_");
}

function parseTechnicianCategoryList(rawValue) {
  const input = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue || "");
  return Array.from(
    new Set(
      input
        .split(",")
        .map((item) => resolveTechnicianCategory(item))
        .filter(Boolean)
    )
  );
}

function parseTechnicianSpecialties(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }

  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [trimmed];
    } catch {
      return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }

  return [];
}

function resolveBroadcastTechnicianCategories(row) {
  const values = [row?.service_type, ...parseTechnicianSpecialties(row?.specialties)];
  return Array.from(new Set(values.map((value) => resolveTechnicianCategory(value)).filter(Boolean)));
}

function resolveBroadcastTechnicianStatus(row) {
  const approvalStatus = String(row?.status || "").trim().toLowerCase();
  const isActive = Boolean(row?.is_active);
  const isAvailable = Boolean(row?.is_available);

  if (approvalStatus !== "approved") {
    return approvalStatus || "offline";
  }
  if (isActive && isAvailable) {
    return "online";
  }
  if (isActive && !isAvailable) {
    return "busy";
  }
  return "offline";
}

async function resolveTechnicianJobAmount(jobRow, technicianProfile, _pricingConfig = null) {
  if (hasTowingRouteData(jobRow)) {
    const stored = toPositiveMoney(
      jobRow?.technician_estimated_earning ??
      jobRow?.technicianEstimatedEarning ??
      jobRow?.estimatedEarnings ??
      jobRow?.amount ??
      jobRow?.service_charge
    );
    if (stored != null) return stored;
  }

  const techAmount = await estimateTechnicianPayoutAsync(
    { service_type: jobRow?.service_type, vehicle_type: jobRow?.vehicle_type },
    technicianProfile || null,
    { technicianId: technicianProfile?.id ?? jobRow?.technician_id ?? null }
  );
  if (techAmount != null) return techAmount;

  return null;
}

const ACTIVE_TECHNICIAN_JOB_STATUSES = Object.freeze([
  "assigned",
  "technician_assigned",
  "accepted",
  "en_route_pickup",
  "arrived_pickup",
  "vehicle_loaded",
  "enroute_drop",
  "arrived_drop",
  "service_completed",
  "service_started",
  "en-route",
  "en_route",
  "on-the-way",
  "on_the_way",
  "arrived",
  "in_progress",
  "in-progress",
  "processing",
  "awaiting_payment",
  "payment_pending",
]);

const normalizeIdentifier = (value) => String(value ?? "").trim();

const toOptionalString = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
};

const toOptionalNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toOptionalPhone = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const compact = raw.replace(/[^\d+]/g, "");
  return compact || null;
};

function buildActiveJobResponse(jobRow, resolvedAmount, paymentRow = null) {
  if (!jobRow) return null;

  const id = String(jobRow.id ?? "");
  const serviceType = toOptionalString(jobRow.service_type);
  const vehicleType = toOptionalString(jobRow.vehicle_type);
  const vehicleModel = toOptionalString(jobRow.vehicle_model);
  const vehicleDetails = [vehicleType, vehicleModel].filter(Boolean).join(" ").trim() || null;
  const customerName = toOptionalString(jobRow.contact_name) || toOptionalString(jobRow.user_name);
  const phoneNumber = toOptionalPhone(jobRow.contact_phone) || toOptionalPhone(jobRow.user_phone);
  const pickupLatitude = toOptionalNumber(jobRow.customer_location_lat ?? jobRow.location_lat);
  const pickupLongitude = toOptionalNumber(jobRow.customer_location_lng ?? jobRow.location_lng);
  const destinationLatitude = toOptionalNumber(jobRow.drop_latitude ?? jobRow.destination_lat ?? jobRow.destinationLatitude);
  const destinationLongitude = toOptionalNumber(jobRow.drop_longitude ?? jobRow.destination_lng ?? jobRow.destinationLongitude);
  const address = toOptionalString(jobRow.address);
  const status = toOptionalString(jobRow.status);
  const description = toOptionalString(jobRow.description);
  const routeFields = buildTechnicianRouteFields(jobRow);
  const paymentDetails = buildServiceRequestPaymentDetails({
    requestRow: jobRow,
    paymentRow,
    baseAmount: resolvedAmount,
  });
  const amount = toPositiveMoney(paymentDetails.baseAmount);

  return {
    id,
    requestId: id,
    customerName,
    serviceType,
    vehicleDetails,
    phoneNumber,
    pickupLatitude,
    pickupLongitude,
    destinationLatitude,
    destinationLongitude,
    destinationAddress: routeFields.dropAddress,
    jobStatus: status,
    amount,
    ...paymentDetails,
    ...routeFields,
    address,
    description,
    status,
    contact_name: customerName,
    contact_phone: phoneNumber,
    service_type: serviceType,
    vehicle_type: vehicleType,
    vehicle_model: vehicleModel,
    location_lat: pickupLatitude,
    location_lng: pickupLongitude,
    location: {
      lat: pickupLatitude,
      lng: pickupLongitude,
      address,
    },
    destination: routeFields.dropLocation,
    user: {
      name: customerName,
      phone: phoneNumber,
    },
    service: {
      type: serviceType,
      description,
    },
    vehicle: {
      type: vehicleType,
      model: vehicleModel,
      details: vehicleDetails,
    },
  };
}

async function fetchActiveTechnicianJob(technicianId) {
  const normalizedTechnicianId = normalizeIdentifier(technicianId);
  if (!normalizedTechnicianId) return null;

  const pool = await db.getPool();
  const statusPlaceholders = ACTIVE_TECHNICIAN_JOB_STATUSES.map(() => "?").join(", ");
  const [rows] = await pool.query(
    `SELECT sr.*, u.full_name AS user_name, u.phone AS user_phone
     FROM service_requests sr
     LEFT JOIN users u ON sr.user_id = u.id
     WHERE sr.technician_id = ?
       AND LOWER(COALESCE(sr.status, '')) IN (${statusPlaceholders})
     ORDER BY sr.updated_at DESC, sr.created_at DESC
     LIMIT 1`,
    [normalizedTechnicianId, ...ACTIVE_TECHNICIAN_JOB_STATUSES]
  );

  if (!Array.isArray(rows) || rows.length === 0) return null;

  const job = rows[0];
  const [techRows] = await pool.query(
    "SELECT pricing, service_costs FROM technicians WHERE id = ? LIMIT 1",
    [normalizedTechnicianId]
  );
  const [paymentRows] = await pool.query(
    `SELECT payment_method, amount, base_amount, platform_fee, payment_fee, is_settled, status, currency
     FROM payments
     WHERE service_request_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [job.id]
  );
  const pricingConfig = await getPlatformPricingConfig();
  const resolvedAmount = await resolveTechnicianJobAmount(job, techRows?.[0] || null, pricingConfig);
  return buildActiveJobResponse(job, resolvedAmount, paymentRows[0] || null);
}

router.get("/", verifyAdmin, async (req, res) => {
  try {
    const categories = parseTechnicianCategoryList(req.query.category ?? req.query.categories);
    const region = String(req.query.region || "").trim().toLowerCase();
    const status = String(req.query.status || "").trim().toLowerCase();

    const whereClauses = [];
    const params = [];

    if (region) {
      whereClauses.push("LOWER(COALESCE(region, '')) = ?");
      params.push(region);
    }

    if (status === "online") {
      whereClauses.push("LOWER(COALESCE(status, '')) = 'approved'");
      whereClauses.push("COALESCE(is_active, 0) = 1");
      whereClauses.push("COALESCE(is_available, 0) = 1");
    } else if (status === "busy") {
      whereClauses.push("LOWER(COALESCE(status, '')) = 'approved'");
      whereClauses.push("COALESCE(is_active, 0) = 1");
      whereClauses.push("COALESCE(is_available, 0) = 0");
    } else if (status === "offline") {
      whereClauses.push("(LOWER(COALESCE(status, '')) <> 'approved' OR COALESCE(is_active, 0) = 0)");
    } else if (status) {
      whereClauses.push("LOWER(COALESCE(status, '')) = ?");
      params.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const pool = await db.getPool();
    const [rows] = await pool.query(
      `SELECT
         id,
         name,
         service_type,
         specialties,
         region,
         status,
         is_active,
         is_available,
         created_at
       FROM technicians
       ${whereSql}
       ORDER BY created_at DESC, id DESC`,
      params
    );

    const filteredRows =
      categories.length > 0
        ? rows.filter((row) => {
            const rowCategories = resolveBroadcastTechnicianCategories(row);
            return categories.some((category) => rowCategories.includes(category));
          })
        : rows;

    return res.json(
      filteredRows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        category: resolveBroadcastTechnicianCategories(row)[0] || "",
        categories: resolveBroadcastTechnicianCategories(row),
        region: String(row.region || "").trim(),
        status: resolveBroadcastTechnicianStatus(row),
      }))
    );
  } catch (err) {
    console.error("[Technicians root list]", err);
    return res.status(500).json({ error: "Failed to fetch technicians" });
  }
});

// Get technician's service requests
router.get("/requests", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const [techRows] = await pool.query(
      "SELECT pricing, service_costs FROM technicians WHERE id = ? LIMIT 1",
      [technicianId]
    );
    const technicianProfile = techRows?.[0] || null;
    const pricingConfig = await getPlatformPricingConfig();

    // Fetch requests assigned to this technician, include user contact details for dashboard
    const rows = await db.query(
      `SELECT sr.*, u.full_name as user_full_name, u.phone as user_phone
       FROM service_requests sr
       LEFT JOIN users u ON sr.user_id = u.id
       WHERE sr.technician_id = ?
       ORDER BY sr.created_at DESC`,
      [technicianId]
    );

    // Map to cleaner shape for frontend
    const mapped = await Promise.all(rows.map(async (r) => {
      const resolvedAmount = await resolveTechnicianJobAmount(r, technicianProfile, pricingConfig);
      return {
        id: String(r.id),
        service_type: r.service_type,
        vehicle_type: r.vehicle_type,
        vehicle_model: r.vehicle_model,
        address: r.address,
        status: r.status,
        payment_status: r.payment_status,
        amount: resolvedAmount,
        created_at: r.created_at,
        updated_at: r.updated_at,
        started_at: r.started_at,
        completed_at: r.completed_at,
        accepted_time: r.accepted_time,
        sla_deadline: r.sla_deadline,
        eta_minutes: r.eta_minutes,
        cancellation_reason: r.cancellation_reason,
        cancelled_at: r.cancelled_at,
        user_id: r.user_id,
        contact_name: r.contact_name || r.user_full_name || 'Not Available',
        contact_phone: r.contact_phone || r.user_phone || null,
        description: r.description,
        location_lat: r.location_lat,
        location_lng: r.location_lng,
        ...buildTechnicianRouteFields(r)
      };
    }));

    return res.json(mapped);
  } catch (err) {
    console.error("[Technician requests]", err);
    return res.status(500).json({ error: "Failed to fetch service requests." });
  }
});

router.post("/register", async (req, res) => {
  try {
    const {
      name, email, password, phone,
      proprietor_name, alternate_phone, whatsapp_number,
      address, region, district, state, locality, google_maps_link,
      aadhaar_number, pan_number, business_type, gst_number, trade_license_number,
      working_hours, service_costs, payment_details, app_readiness, vehicle_types,
      serviceAreaRange, experience, specialties, pricing, resume_url, documents
    } = req.body;

    const normalizedEmail = (email || "").trim().toLowerCase();
    const trimmedName = (name || "").trim();

    if (!trimmedName || !normalizedEmail || !password) {
      return res.status(400).json({ error: "Name, email and password are required." });
    }

    // Check password strength
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const normalizedSpecialties = normalizeSpecialties(specialties);
    const normalizedVehicleTypes = normalizeVehicleTypes(vehicle_types);
    const normalizedServiceCosts = normalizeServiceCosts(service_costs);
    const service_type = normalizedSpecialties[0] || "other";
    const location = (locality || address || "").trim() || "â€”";
    const normalizedDocuments = sanitizeTechnicianDocuments(documents);
    const normalizedResumeUrl = normalizeUploadResourcePath(resume_url);
    const upiId = String(payment_details?.upi_id || req.body?.upi_id || "").trim();
    const upiName = String(payment_details?.upi_name || req.body?.upi_name || proprietor_name || trimmedName).trim();

    const specialtiesJson = JSON.stringify(normalizedSpecialties);
    const pricingJson = JSON.stringify(pricing && typeof pricing === "object" ? pricing : {});
    const documentsJson = JSON.stringify(normalizedDocuments);
    const workingHoursJson = JSON.stringify(working_hours || {});
    const serviceCostsJson = JSON.stringify(normalizedServiceCosts || {});
    const paymentDetailsJson = JSON.stringify(payment_details || {});
    const appReadinessJson = JSON.stringify(app_readiness || {});
    const vehicleTypesJson = JSON.stringify(normalizedVehicleTypes || {});

    const pool = await db.getPool();

    // Check existing email
    const [existing] = await pool.query("SELECT id FROM technicians WHERE email = ?", [normalizedEmail]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "This email is already registered." });
    }

    const result = await pool.execute(
      `INSERT INTO technicians (
        name, email, phone, upi_id, upi_name,
        proprietor_name, alternate_phone, whatsapp_number,
        service_type, location, status, is_active, is_available, password_hash,
        address, region, district, state, locality, google_maps_link,
        aadhaar_number, pan_number, business_type, gst_number, trade_license_number,
        service_area_range, experience,
        specialties, pricing, working_hours, service_costs, payment_details, app_readiness, vehicle_types,
        resume_url, documents, latitude, longitude
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trimmedName,
        normalizedEmail,
        (phone || "").trim(),
        upiId || null,
        upiName || null,
        (proprietor_name || "").trim(),
        (alternate_phone || "").trim(),
        (whatsapp_number || "").trim(),
        service_type,
        location,
        "pending",
        false,
        false,
        password_hash,
        (address || "").trim(),
        (region || "").trim(),
        (district || "").trim(),
        (state || "").trim(),
        (locality || "").trim(),
        (google_maps_link || "").trim(),
        (aadhaar_number || "").trim(),
        (pan_number || "").trim(),
        (business_type || "").trim(),
        (gst_number || "").trim(),
        (trade_license_number || "").trim(),
        Number(serviceAreaRange) || 10,
        Number(experience) || 0,
        specialtiesJson,
        pricingJson,
        workingHoursJson,
        serviceCostsJson,
        paymentDetailsJson,
        appReadinessJson,
        vehicleTypesJson,
        normalizedResumeUrl,
        documentsJson,
        req.body.latitude || null,
        req.body.longitude || null
      ]
    );

    const insertedId = result[0].insertId;

    try {
      if (req.body.pricing_config || req.body.service_costs) {
        const payloadToSync = req.body.pricing_config || req.body.service_costs;
        const normalizedEntries = normalizeTechnicianPricingEntries(payloadToSync);
        await replaceTechnicianPricingRows(pool, insertedId, normalizedEntries);
        await replaceTechnicianFleetVehicles(pool, insertedId, payloadToSync);
      }
    } catch (pricingError) {
      console.error("[Register] Failed to sync technician pricing", pricingError);
    }

    // Notification Logic
    const title = "New Technician Application";
    const message = `${trimmedName} submitted an application.`;

    try {
      await pool.execute(
        "INSERT INTO notifications (type, title, message) VALUES (?, ?, ?)",
        [ADMIN_NOTIFICATION_TYPES.NEW_TECHNICIAN_APPLICATION, title, message]
      );

      // Use SocketService to broadcast to admins (if they are listening on a channel)
      socketService.broadcast("admin:notification", { title, message, created_at: new Date() });
    } catch { }

    await sendEventEmail("TECHNICIAN_APPLICATION_SUBMITTED", {
      name: trimmedName,
      email: normalizedEmail,
      applicantEmail: normalizedEmail,
    });

    const adminNotificationEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (adminNotificationEmail) {
      await sendEventEmail("ADMIN_NEW_TECHNICIAN_APPLICATION", {
        email: adminNotificationEmail,
        name: trimmedName,
        applicantEmail: normalizedEmail,
      });
    }

    const id = result[0].insertId;
    const token = signTechnicianToken(id, normalizedEmail);

    return res.status(201).json({
      message: "Registration started. Please complete the registration payment.",
      id: String(id),
      token
    });

  } catch (err) {
    console.error("Registration error:", err);
    return res.status(500).json({ error: "Registration failed." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = (email || "").trim().toLowerCase();
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    const rows = await db.query("SELECT * FROM technicians WHERE email = ? LIMIT 1", [normalizedEmail]);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: "User not found." });
    }
    const valid = await bcrypt.compare(password, row.password_hash || "");
    if (!valid) {
      return res.status(401).json({ error: "Incorrect password. Please try again." });
    }
    const status = String(row.status || "").trim().toLowerCase() || "pending";
    const approvalFlagRaw = row.isApproved ?? row.is_approved;
    const approvalFlag = typeof approvalFlagRaw === "string"
      ? approvalFlagRaw.trim().toLowerCase()
      : approvalFlagRaw;
    const isApprovedByFlag =
      approvalFlag === true ||
      approvalFlag === 1 ||
      approvalFlag === "1" ||
      approvalFlag === "true" ||
      approvalFlag === "approved";
    const isApproved = status === "approved" || isApprovedByFlag;

    if (status === "rejected") {
      return res.status(403).json({
        status: "rejected",
        error: "Your application was not approved. Please contact support for more information.",
      });
    }
    if (!isApproved) {
      return res.status(403).json({
        status: "pending_approval",
        error: "Your account is pending admin approval.",
      });
    }
    try {
      await markTechnicianLogin({
        technicianId: row.id,
        source: req.body?.source || req.get("x-client-platform") || "web",
        metadata: {
          ip: req.ip || null,
          userAgent: req.get("user-agent") || null,
        },
      });
    } catch (trackingError) {
      console.error("[Technician login tracking] failed:", trackingError?.message || trackingError);
    }

    const technician = rowToTechnician({
      ...row,
      is_logged_in: true,
      last_login_at: new Date(),
      last_seen_at: new Date(),
      login_reminder_sent_at: null,
    });
    const token = signTechnicianToken(row.id, row.email);
    return res.json({ token, technician });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Login failed." });
  }
});

router.post("/logout", verifyTechnician, async (req, res) => {
  try {
    await markTechnicianLogout({
      technicianId: req.technicianId,
      reason: req.body?.reason || "logout",
      source: req.body?.source || req.get("x-client-platform") || "web",
    });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Technician logout tracking] failed:", err);
    return res.status(500).json({ error: err.message || "Failed to log out." });
  }
});

router.post("/activity/heartbeat", verifyTechnician, async (req, res) => {
  try {
    await markTechnicianHeartbeat({
      technicianId: req.technicianId,
      source: req.body?.source || req.get("x-client-platform") || "web",
      metadata: req.body?.metadata || null,
      createSessionIfMissing: true,
    });
    return res.json({ success: true, seenAt: new Date().toISOString() });
  } catch (err) {
    console.error("[Technician heartbeat tracking] failed:", err);
    return res.status(500).json({ error: err.message || "Failed to update heartbeat." });
  }
});


router.get("/me", verifyTechnician, async (req, res) => {
  try {
    void markTechnicianHeartbeat({
      technicianId: req.technicianId,
      source: req.get("x-client-platform") || "web",
      createSessionIfMissing: false,
    }).catch((trackingError) => {
      console.error("[Technician /me heartbeat] failed:", trackingError?.message || trackingError);
    });

    const rows = await db.query("SELECT * FROM technicians WHERE id = ? LIMIT 1", [req.technicianId]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Technician not found." });
    return res.json(rowToTechnician(row));
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch profile." });
  }
});

router.get("/me/settings", verifyTechnician, async (req, res) => {
  try {
    const rows = await db.query("SELECT settings FROM technicians WHERE id = ? LIMIT 1", [req.technicianId]);
    if (!rows[0]) {
      return res.status(404).json({ error: "Technician not found." });
    }
    return res.json(normalizeTechnicianSettings(rows[0].settings));
  } catch (err) {
    console.error("Technician settings fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch technician settings." });
  }
});

router.patch("/me/settings", verifyTechnician, async (req, res) => {
  try {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: "Invalid settings payload." });
    }

    const pool = await db.getPool();
    const [rows] = await pool.query("SELECT settings FROM technicians WHERE id = ? LIMIT 1", [req.technicianId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const settings = normalizeTechnicianSettings(rows[0]?.settings, req.body);
    await pool.execute("UPDATE technicians SET settings = ? WHERE id = ?", [JSON.stringify(settings), req.technicianId]);
    socketService.notifyTechnician(req.technicianId, "technician:settings_update", settings);

    return res.json({ success: true, settings });
  } catch (err) {
    console.error("Technician settings update error:", err);
    return res.status(500).json({ error: "Failed to update technician settings." });
  }
});

router.patch("/me/profile", verifyTechnician, async (req, res) => {
  try {
    const {
      name, phone, address,
      specialties, service_area_range,
      vehicle_types, experience,
      profile_photo,
      documents
    } = req.body;

    const pool = await db.getPool();
    const [existingRows] = await pool.query(
      "SELECT * FROM technicians WHERE id = ? LIMIT 1",
      [req.technicianId]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const existingRow = existingRows[0];
    const existingDocuments = sanitizeTechnicianDocuments(existingRow.documents);
    const incomingDocuments = parseObject(documents);
    const nextDocuments = { ...existingDocuments };

    for (const key of KNOWN_DOCUMENT_KEYS) {
      if (incomingDocuments[key] !== undefined) {
        nextDocuments[key] = normalizeUploadResourcePath(incomingDocuments[key]);
      }
    }
    if (profile_photo !== undefined) {
      nextDocuments.profile_photo = normalizeUploadResourcePath(profile_photo);
    }

    // Prepare JSON fields
    const specialtiesJson = specialties ? JSON.stringify(specialties) : undefined;
    const vehicleTypesJson = vehicle_types ? JSON.stringify(vehicle_types) : undefined;

    // Construct dynamic update query
    let fields = [];
    let values = [];

    if (name) { fields.push("name = ?"); values.push(name.trim()); }
    if (phone) { fields.push("phone = ?"); values.push(phone.trim()); }
    if (address) { fields.push("address = ?"); values.push(address.trim()); }
    if (specialtiesJson) { fields.push("specialties = ?"); values.push(specialtiesJson); }
    if (vehicleTypesJson) { fields.push("vehicle_types = ?"); values.push(vehicleTypesJson); }
    if (service_area_range !== undefined) { fields.push("service_area_range = ?"); values.push(Number(service_area_range)); }
    if (experience !== undefined) { fields.push("experience = ?"); values.push(Number(experience)); }
    if (documents !== undefined || profile_photo !== undefined) {
      fields.push("documents = ?");
      values.push(JSON.stringify(nextDocuments));
    }

    if (fields.length === 0) {
      return res.json({ message: "No changes to update" });
    }

    values.push(req.technicianId);

    await pool.execute(
      `UPDATE technicians SET ${fields.join(", ")} WHERE id = ?`,
      values
    );

    const [updatedRows] = await pool.query(
      "SELECT * FROM technicians WHERE id = ? LIMIT 1",
      [req.technicianId]
    );

    return res.json({
      success: true,
      message: "Profile updated successfully",
      technician: updatedRows[0] ? rowToTechnician(updatedRows[0]) : null,
    });
  } catch (err) {
    console.error("Profile update error:", err);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

router.get("/vehicles", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const pool = await db.getPool();
    const [rows] = await pool.query(
      `SELECT id, technician_id, vehicle_type, vehicle_number, capacity, status, created_at, updated_at
       FROM technician_fleet_vehicles
       WHERE technician_id = ?
       ORDER BY updated_at DESC, id DESC`,
      [technicianRow.id]
    );

    return res.json((rows || []).map(mapTechnicianFleetVehicle));
  } catch (err) {
    console.error("[Technician vehicles list] failed:", err);
    return res.status(500).json({ error: "Failed to fetch fleet vehicles." });
  }
});

router.post("/vehicles", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const vehicleType = normalizeTechnicianFleetVehicleType(
      req.body?.vehicle_type ?? req.body?.vehicleType
    );
    const vehicleNumber = normalizeRequiredText(
      req.body?.vehicle_number ?? req.body?.vehicleNumber,
      64
    ).toUpperCase();
    const capacity = normalizeOptionalText(req.body?.capacity, 64);
    const status = normalizeTechnicianFleetStatus(req.body?.status, "available");

    if (!vehicleType || !vehicleNumber) {
      return res.status(400).json({
        error: "vehicle_type and vehicle_number are required.",
      });
    }

    const pool = await db.getPool();
    const [result] = await pool.execute(
      `INSERT INTO technician_fleet_vehicles
        (technician_id, vehicle_type, vehicle_number, capacity, status)
       VALUES (?, ?, ?, ?, ?)`,
      [technicianRow.id, vehicleType, vehicleNumber, capacity, status]
    );

    const [rows] = await pool.query(
      `SELECT id, technician_id, vehicle_type, vehicle_number, capacity, status, created_at, updated_at
       FROM technician_fleet_vehicles
       WHERE id = ? AND technician_id = ?
       LIMIT 1`,
      [result.insertId, technicianRow.id]
    );

    return res.status(201).json(mapTechnicianFleetVehicle(rows[0]));
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: "This vehicle number is already registered in your fleet.",
      });
    }
    console.error("[Technician vehicles create] failed:", err);
    return res.status(500).json({ error: "Failed to add fleet vehicle." });
  }
});

router.patch("/vehicles/:id", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const vehicleId = normalizeOptionalNumericIdentifier(req.params.id);
    if (!vehicleId) {
      return res.status(400).json({ error: "Valid vehicle id is required." });
    }

    const pool = await db.getPool();
    const [existingRows] = await pool.query(
      `SELECT id, technician_id, vehicle_type, vehicle_number, capacity, status, created_at, updated_at
       FROM technician_fleet_vehicles
       WHERE id = ? AND technician_id = ?
       LIMIT 1`,
      [vehicleId, technicianRow.id]
    );

    if (!existingRows?.length) {
      return res.status(404).json({ error: "Fleet vehicle not found." });
    }

    const existing = existingRows[0];
    const nextVehicleType =
      req.body?.vehicle_type != null || req.body?.vehicleType != null
        ? normalizeTechnicianFleetVehicleType(req.body?.vehicle_type ?? req.body?.vehicleType)
        : existing.vehicle_type;
    const nextVehicleNumber =
      req.body?.vehicle_number != null || req.body?.vehicleNumber != null
        ? normalizeRequiredText(req.body?.vehicle_number ?? req.body?.vehicleNumber, 64).toUpperCase()
        : existing.vehicle_number;
    const nextCapacity =
      req.body?.capacity !== undefined
        ? normalizeOptionalText(req.body?.capacity, 64)
        : existing.capacity;
    const nextStatus =
      req.body?.status !== undefined
        ? normalizeTechnicianFleetStatus(req.body?.status, existing.status)
        : normalizeTechnicianFleetStatus(existing.status);

    if (!nextVehicleType || !nextVehicleNumber) {
      return res.status(400).json({
        error: "vehicle_type and vehicle_number are required.",
      });
    }

    await pool.execute(
      `UPDATE technician_fleet_vehicles
       SET vehicle_type = ?, vehicle_number = ?, capacity = ?, status = ?
       WHERE id = ? AND technician_id = ?`,
      [
        nextVehicleType,
        nextVehicleNumber,
        nextCapacity,
        nextStatus,
        vehicleId,
        technicianRow.id,
      ]
    );

    const [rows] = await pool.query(
      `SELECT id, technician_id, vehicle_type, vehicle_number, capacity, status, created_at, updated_at
       FROM technician_fleet_vehicles
       WHERE id = ? AND technician_id = ?
       LIMIT 1`,
      [vehicleId, technicianRow.id]
    );

    return res.json(mapTechnicianFleetVehicle(rows[0]));
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: "This vehicle number is already registered in your fleet.",
      });
    }
    console.error("[Technician vehicles update] failed:", err);
    return res.status(500).json({ error: "Failed to update fleet vehicle." });
  }
});

router.delete("/vehicles/:id", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const vehicleId = normalizeOptionalNumericIdentifier(req.params.id);
    if (!vehicleId) {
      return res.status(400).json({ error: "Valid vehicle id is required." });
    }

    const pool = await db.getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      await conn.execute(
        `UPDATE technician_team_members
         SET assigned_vehicle_id = NULL
         WHERE technician_id = ? AND assigned_vehicle_id = ?`,
        [technicianRow.id, vehicleId]
      );

      const [result] = await conn.execute(
        `DELETE FROM technician_fleet_vehicles
         WHERE id = ? AND technician_id = ?`,
        [vehicleId, technicianRow.id]
      );

      if (!result?.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: "Fleet vehicle not found." });
      }

      await conn.commit();
      return res.json({ success: true, id: String(vehicleId) });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("[Technician vehicles delete] failed:", err);
    return res.status(500).json({ error: "Failed to delete fleet vehicle." });
  }
});

router.get("/employees", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const pool = await db.getPool();
    const [rows] = await pool.query(
      `SELECT
         tm.id,
         tm.technician_id,
         tm.name,
         tm.phone,
         tm.role,
         tm.assigned_vehicle_id,
         tm.status,
         tm.created_at,
         tm.updated_at,
         fv.vehicle_number AS assigned_vehicle_number,
         fv.vehicle_type AS assigned_vehicle_type
       FROM technician_team_members tm
       LEFT JOIN technician_fleet_vehicles fv
         ON fv.id = tm.assigned_vehicle_id
        AND fv.technician_id = tm.technician_id
       WHERE tm.technician_id = ?
       ORDER BY tm.updated_at DESC, tm.id DESC`,
      [technicianRow.id]
    );

    return res.json((rows || []).map(mapTechnicianTeamMember));
  } catch (err) {
    console.error("[Technician employees list] failed:", err);
    return res.status(500).json({ error: "Failed to fetch team members." });
  }
});

router.post("/employees", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const name = normalizeRequiredText(req.body?.name, 255);
    const phone = normalizeRequiredText(req.body?.phone, 50);
    const role = normalizeTechnicianTeamRole(req.body?.role, "driver");
    const assignedVehicleId = normalizeOptionalNumericIdentifier(
      req.body?.assigned_vehicle ?? req.body?.assigned_vehicle_id
    );
    const status = normalizeTechnicianTeamStatus(req.body?.status, "active");

    if (!name || !phone) {
      return res.status(400).json({ error: "name and phone are required." });
    }

    const pool = await db.getPool();
    if (assignedVehicleId != null) {
      const assignedVehicle = await assertAssignedVehicleBelongsToTechnician(
        pool,
        technicianRow.id,
        assignedVehicleId
      );
      if (!assignedVehicle) {
        return res.status(400).json({
          error: "assigned_vehicle must belong to your fleet.",
        });
      }
    }

    const [result] = await pool.execute(
      `INSERT INTO technician_team_members
        (technician_id, name, phone, role, assigned_vehicle_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [technicianRow.id, name, phone, role, assignedVehicleId, status]
    );

    const [rows] = await pool.query(
      `SELECT
         tm.id,
         tm.technician_id,
         tm.name,
         tm.phone,
         tm.role,
         tm.assigned_vehicle_id,
         tm.status,
         tm.created_at,
         tm.updated_at,
         fv.vehicle_number AS assigned_vehicle_number,
         fv.vehicle_type AS assigned_vehicle_type
       FROM technician_team_members tm
       LEFT JOIN technician_fleet_vehicles fv
         ON fv.id = tm.assigned_vehicle_id
        AND fv.technician_id = tm.technician_id
       WHERE tm.id = ? AND tm.technician_id = ?
       LIMIT 1`,
      [result.insertId, technicianRow.id]
    );

    return res.status(201).json(mapTechnicianTeamMember(rows[0]));
  } catch (err) {
    console.error("[Technician employees create] failed:", err);
    return res.status(500).json({ error: "Failed to add team member." });
  }
});

router.patch("/employees/:id", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const employeeId = normalizeOptionalNumericIdentifier(req.params.id);
    if (!employeeId) {
      return res.status(400).json({ error: "Valid employee id is required." });
    }

    const pool = await db.getPool();
    const [existingRows] = await pool.query(
      `SELECT id, technician_id, name, phone, role, assigned_vehicle_id, status
       FROM technician_team_members
       WHERE id = ? AND technician_id = ?
       LIMIT 1`,
      [employeeId, technicianRow.id]
    );

    if (!existingRows?.length) {
      return res.status(404).json({ error: "Team member not found." });
    }

    const existing = existingRows[0];
    const nextName =
      req.body?.name !== undefined
        ? normalizeRequiredText(req.body?.name, 255)
        : existing.name;
    const nextPhone =
      req.body?.phone !== undefined
        ? normalizeRequiredText(req.body?.phone, 50)
        : existing.phone;
    const nextRole =
      req.body?.role !== undefined
        ? normalizeTechnicianTeamRole(req.body?.role, existing.role)
        : normalizeTechnicianTeamRole(existing.role);
    const nextAssignedVehicleId =
      req.body?.assigned_vehicle !== undefined || req.body?.assigned_vehicle_id !== undefined
        ? normalizeOptionalNumericIdentifier(
            req.body?.assigned_vehicle ?? req.body?.assigned_vehicle_id
          )
        : existing.assigned_vehicle_id;
    const nextStatus =
      req.body?.status !== undefined
        ? normalizeTechnicianTeamStatus(req.body?.status, existing.status)
        : normalizeTechnicianTeamStatus(existing.status);

    if (!nextName || !nextPhone) {
      return res.status(400).json({ error: "name and phone are required." });
    }

    if (nextAssignedVehicleId != null) {
      const assignedVehicle = await assertAssignedVehicleBelongsToTechnician(
        pool,
        technicianRow.id,
        nextAssignedVehicleId
      );
      if (!assignedVehicle) {
        return res.status(400).json({
          error: "assigned_vehicle must belong to your fleet.",
        });
      }
    }

    await pool.execute(
      `UPDATE technician_team_members
       SET name = ?, phone = ?, role = ?, assigned_vehicle_id = ?, status = ?
       WHERE id = ? AND technician_id = ?`,
      [
        nextName,
        nextPhone,
        nextRole,
        nextAssignedVehicleId,
        nextStatus,
        employeeId,
        technicianRow.id,
      ]
    );

    const [rows] = await pool.query(
      `SELECT
         tm.id,
         tm.technician_id,
         tm.name,
         tm.phone,
         tm.role,
         tm.assigned_vehicle_id,
         tm.status,
         tm.created_at,
         tm.updated_at,
         fv.vehicle_number AS assigned_vehicle_number,
         fv.vehicle_type AS assigned_vehicle_type
       FROM technician_team_members tm
       LEFT JOIN technician_fleet_vehicles fv
         ON fv.id = tm.assigned_vehicle_id
        AND fv.technician_id = tm.technician_id
       WHERE tm.id = ? AND tm.technician_id = ?
       LIMIT 1`,
      [employeeId, technicianRow.id]
    );

    return res.json(mapTechnicianTeamMember(rows[0]));
  } catch (err) {
    console.error("[Technician employees update] failed:", err);
    return res.status(500).json({ error: "Failed to update team member." });
  }
});

router.delete("/employees/:id", verifyTechnician, async (req, res) => {
  try {
    const technicianRow = await requireTowingTechnicianAccess(req, res);
    if (!technicianRow) return;

    const employeeId = normalizeOptionalNumericIdentifier(req.params.id);
    if (!employeeId) {
      return res.status(400).json({ error: "Valid employee id is required." });
    }

    const pool = await db.getPool();
    const [result] = await pool.execute(
      `DELETE FROM technician_team_members
       WHERE id = ? AND technician_id = ?`,
      [employeeId, technicianRow.id]
    );

    if (!result?.affectedRows) {
      return res.status(404).json({ error: "Team member not found." });
    }

    return res.json({ success: true, id: String(employeeId) });
  } catch (err) {
    console.error("[Technician employees delete] failed:", err);
    return res.status(500).json({ error: "Failed to delete team member." });
  }
});

router.patch("/me/status", verifyTechnician, async (req, res) => {
  try {
    const active = typeof req.body?.active === "boolean"
      ? req.body.active
      : typeof req.body?.is_active === "boolean"
        ? req.body.is_active
        : undefined;
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Active status must be a boolean." });
    }

    const pool = await db.getPool();
    await pool.execute(
      `UPDATE technicians
       SET is_active = ?,
           is_available = CASE
             WHEN ? = TRUE AND current_job_id IS NULL THEN TRUE
             ELSE FALSE
           END
       WHERE id = ?`,
      [active, active, req.technicianId]
    );

    // We could use socketService to handle this event if we were receiving it from client socket,
    // but here we are doing it via REST, so we can emit it to the system.
    // However, clients (technician UI) might emit 'technician:online' directly to socket too.
    // Doing it here ensures backend state is consistent for other queries.

    // Explicitly notify that this technician's status changed
    socketService.broadcast("technician:status_update", {
      technicianId: req.technicianId,
      active
    });

    void markTechnicianHeartbeat({
      technicianId: req.technicianId,
      source: req.get("x-client-platform") || "web",
      metadata: { active },
      createSessionIfMissing: false,
    }).catch((trackingError) => {
      console.error("[Technician status heartbeat] failed:", trackingError?.message || trackingError);
    });

    return res.json({ success: true, active });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to update status." });
  }
});

router.patch("/me/location", verifyTechnician, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const parsedLat = Number(latitude);
    const parsedLng = Number(longitude);

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      return res.status(400).json({ error: "Latitude and longitude are required." });
    }

    const pool = await db.getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE technicians
         SET latitude = ?,
             longitude = ?,
             current_lat = ?,
             current_lng = ?,
             last_location_update = NOW()
         WHERE id = ?`,
        [parsedLat, parsedLng, parsedLat, parsedLng, req.technicianId]
      );

      const [rows] = await conn.query(
        "SELECT current_job_id FROM technicians WHERE id = ? LIMIT 1",
        [req.technicianId]
      );
      let currentJobId = rows?.[0]?.current_job_id ? Number(rows[0].current_job_id) : null;
      if (!Number.isInteger(currentJobId)) {
        const [activeRows] = await conn.query(
          `SELECT id
           FROM service_requests
           WHERE technician_id = ?
            AND LOWER(COALESCE(status, '')) IN (
               'assigned',
               'accepted',
               'en_route_pickup',
               'arrived_pickup',
               'vehicle_loaded',
               'enroute_drop',
               'arrived_drop',
               'service_completed',
               'processing',
               'service_started',
               'en-route',
               'on-the-way',
               'arrived',
               'in_progress',
               'in-progress',
               'awaiting_payment',
               'payment_pending'
             )
           ORDER BY updated_at DESC
           LIMIT 1`,
          [req.technicianId]
        );
        currentJobId = activeRows?.[0]?.id ? Number(activeRows[0].id) : null;
      }

      await conn.execute(
        `INSERT INTO technician_location_history (technician_id, service_request_id, latitude, longitude)
         VALUES (?, ?, ?, ?)`,
        [req.technicianId, Number.isInteger(currentJobId) ? currentJobId : null, parsedLat, parsedLng]
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    // Broadcast location update
    socketService.broadcast("technician:location_update", {
      technicianId: req.technicianId,
      lat: parsedLat,
      lng: parsedLng
    });

    void markTechnicianHeartbeat({
      technicianId: req.technicianId,
      source: req.get("x-client-platform") || "web",
      metadata: {
        latitude: parsedLat,
        longitude: parsedLng,
      },
      createSessionIfMissing: false,
    }).catch((trackingError) => {
      console.error("[Technician me/location heartbeat] failed:", trackingError?.message || trackingError);
    });


    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to update location." });
  }
});

router.get("/me/active-job", verifyTechnician, async (req, res) => {
  try {
    const activeJob = await fetchActiveTechnicianJob(req.technicianId);
    return res.json(activeJob);
  } catch (err) {
    console.error("[Technician] me/active-job error:", err);
    return res.status(500).json({ error: "Failed to fetch active job." });
  }
});

router.get("/active-job/:techId", verifyTechnician, async (req, res) => {
  try {
    const requestedTechId = normalizeIdentifier(req.params.techId);
    const authenticatedTechId = normalizeIdentifier(req.technicianId);

    if (!requestedTechId) {
      return res.status(400).json({ error: "Valid technician id is required." });
    }
    if (authenticatedTechId && authenticatedTechId !== requestedTechId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const activeJob = await fetchActiveTechnicianJob(requestedTechId);
    return res.json(activeJob);
  } catch (err) {
    console.error("[Technician] active-job/:techId error:", err);
    return res.status(500).json({ error: "Failed to fetch active job." });
  }
});

// New endpoint to match spec: GET /api/technician/current-job
router.get('/current-job', verifyTechnician, async (req, res) => {
  try {
    const activeJob = await fetchActiveTechnicianJob(req.technicianId);
    return res.json(activeJob);
  } catch (err) {
    console.error('[Technician] current-job error:', err);
    return res.status(500).json({ error: 'Failed to fetch current job.' });
  }
});

/**
 * GET /api/technicians/jobs/history
 * Fetch job history
 */
router.get('/jobs/history', verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const [techRows] = await pool.query(
      "SELECT pricing, service_costs FROM technicians WHERE id = ? LIMIT 1",
      [technicianId]
    );
    const technicianProfile = techRows?.[0] || null;
    const pricingConfig = await getPlatformPricingConfig();

    const [rows] = await pool.query(
      "SELECT * FROM service_requests WHERE technician_id = ? ORDER BY created_at DESC",
      [technicianId]
    );

    const enrichedRows = await Promise.all(
      rows.map(async (row) => {
        const resolvedAmount = await resolveTechnicianJobAmount(row, technicianProfile, pricingConfig);
        return {
          ...row,
          amount: resolvedAmount,
          ...buildTechnicianRouteFields(row)
        };
      })
    );

    res.json(enrichedRows);
  } catch (err) {
    console.error("Fetch job history error:", err);
    res.status(500).json({ error: "Failed to fetch job history" });
  }
});

/**
 * GET /api/technicians/me/dues
 * Get total pending platform fees
 */
router.get('/me/dues', verifyTechnician, async (req, res) => {
  try {
    const pool = await db.getPool();
    const snapshot = await fetchTechnicianFinancialSnapshot(pool, req.technicianId);
    res.json({ total: snapshot.pending_dues });
  } catch (err) {
    console.error("Fetch dues error:", err);
    res.status(500).json({ error: "Failed to fetch dues" });
  }
});

/**
 * POST /api/technicians/me/pay-dues/order
 * Create order to clear all pending dues
 */
router.post('/me/pay-dues/order', verifyTechnician, async (req, res) => {
  try {
    if (!ensureRazorpayConfigured(res)) return;
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const pricingConfig = await getPlatformPricingConfig();
    const snapshot = await fetchTechnicianFinancialSnapshot(pool, technicianId);
    const total = snapshot.pending_dues;

    if (total <= 0) return res.status(400).json({ error: "No pending dues" });

    const options = {
      amount: Math.round(total * 100),
      currency: pricingConfig.currency || "INR",
      receipt: `dues_${technicianId}_${Date.now()}`
    };
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    console.error("Pay dues order error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

/**
 * POST /api/technicians/me/pay-dues/verify
 * Verify payment and clear dues
 */
router.post('/me/pay-dues/verify', verifyTechnician, async (req, res) => {
  try {
    if (!ensureRazorpayConfigured(res)) return;
    const technicianId = req.technicianId;
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const pool = await db.getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Mark all pending platform dues as settled in payments ledger.
      await conn.execute(
        `
        UPDATE payments p
        JOIN service_requests sr ON p.service_request_id = sr.id
        SET p.is_settled = TRUE
        WHERE sr.technician_id = ? AND p.status = 'completed' AND p.is_settled = FALSE
        `,
        [technicianId]
      );

      // Keep legacy dues table in sync when rows exist.
      await conn.execute(
        "UPDATE technician_dues SET status = 'paid' WHERE technician_id = ? AND status = 'pending'",
        [technicianId]
      );

      await conn.commit();
      const snapshot = await fetchTechnicianFinancialSnapshot(pool, technicianId);
      socketService.notifyTechnician(technicianId, "technician:financials_update", snapshot);
      res.json({ success: true, financials: snapshot });
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("Pay dues verify error:", err);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});


// Haversine Formula for distance in km
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c; // Distance in km
  return d;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * GET /api/technicians/nearby
 * Returns approved technicians within service range, sorted by score.
 */
router.get("/nearby", async (req, res) => {
  try {
    const { lat, lng, service_type } = req.query;
    const vehicle_type = (req.query.vehicle_type || req.query.vehicleType || "").toLowerCase();
    const clientIp = req.ip || req.connection.remoteAddress;

    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;
    const serviceType = canonicalizeServiceDomain((service_type || "").toLowerCase().replace(/^(car|bike|ev|commercial)-/i, ""));
    const requestedVehicleType = canonicalizeVehicleFamily(vehicle_type);
    const pricingConfig = await getPlatformPricingConfig();
    const currency = pricingConfig.currency || "INR";

    console.log(`[API NEARBY] Request from ${clientIp} - lat=${userLat}, lng=${userLng}, service=${serviceType}, vehicle=${vehicle_type}`);

    // Fetch all approved and active technicians
    const rows = await db.query("SELECT * FROM technicians WHERE status = 'approved' AND is_active = TRUE");
    const technicianIds = rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const normalizedPricingRows = technicianIds.length > 0
      ? await db.query(
          `SELECT
             technician_id,
             service_domain,
             vehicle_type,
             visit_charge,
             service_charge,
             extra_km_charge,
             labour_min,
             labour_max,
             delivery_charge,
             price_2w_min,
             price_2w_max,
             price_4w_min,
             price_4w_max,
             base_price,
             free_km,
             per_km_price,
             night_charge,
             night_type,
             metadata
           FROM technician_services
           WHERE technician_id IN (${technicianIds.map(() => "?").join(", ")})`,
          technicianIds
        )
      : [];
    const pricingRowsByTechnician = indexTechnicianPricingRows(normalizedPricingRows);

    const technicians = rows
      .map(row => {
        const tech = rowToTechnician(row);

        const tLat = row.latitude ? parseFloat(row.latitude) : null;
        const tLng = row.longitude ? parseFloat(row.longitude) : null;

        let distance = 0;
        let isWithinRange = true; // Default to true if location unknown (user or tech)

        if (userLat && userLng && tLat && tLng) {
          distance = getDistanceFromLatLonInKm(userLat, userLng, tLat, tLng);
          // Filter by service range
          if (distance > (row.service_area_range || 20)) {
            isWithinRange = false;
          }
        }

        // If technician has no location, we put them at valid distance 0 to show them (fallback)

        return {
          ...tech,
          distance: parseFloat(distance.toFixed(2)),
          isWithinRange,
        };
      })
      .filter(t => t.isWithinRange)
      .map(t => {
        const storedRows = pricingRowsByTechnician.get(Number(t.id)) || [];
        const candidateRows = storedRows.length > 0
          ? storedRows
          : normalizeTechnicianPricingEntries(t.service_costs);
        const resolvedPrice = resolveTechnicianDisplayPrice(candidateRows, {
          serviceType,
          vehicleType: requestedVehicleType,
        });

        return {
          ...t,
          price: resolvedPrice?.price ?? null,
          base_price: resolvedPrice?.price ?? null,
          price_breakdown: resolvedPrice?.breakdown ?? null,
          currency,
        };
      });

    // Apply Service Type Filter
    const filtered = technicians.filter(t => {
      // If no service type requested, show all
      if (requestedVehicleType && t.vehicle_types && typeof t.vehicle_types === "object") {
        const supported = Object.entries(t.vehicle_types)
          .filter(([, enabled]) => !!enabled)
          .map(([k]) => canonicalizeVehicleFamily(k));
        if (supported.length > 0 && !supported.includes(requestedVehicleType)) {
          return false;
        }
      }

      if (!serviceType || serviceType === "all") return true;

      const type = canonicalizeServiceDomain(t.service_type || "");
      // Check specialty list
      const specs = (t.specialties || []).map(s => canonicalizeServiceDomain(String(s)));

      // Fuzzy match: if any specialty includes the requested type OR requested type includes specialty
      // Also match against main service_type
      return specs.some(s => s.includes(serviceType) || serviceType.includes(s)) || type.includes(serviceType);
    });

    // AI Recommendation Logic (Ranking)
    const ranked = filtered.map(t => {
      // Prioritize rating, closer distance, and completed jobs
      // If distance is 0 (unknown), give slight penalty compared to very close known? 
      // Actually, 0 distance is good score.
      const score = (t.rating * 20)
        - (t.distance * 2)
        + (t.jobs_completed * 0.5);

      return { ...t, score };
    });

    // Sort by Score DESC
    ranked.sort((a, b) => b.score - a.score);

    // AI Recommended tag for top 2
    const results = ranked.map((t, index) => ({
      ...t,
      aiRecommended: index < 2
    }));

    res.json(results);
  } catch (err) {
    console.error("Nearby error:", err);
    res.status(500).json({ error: "Failed to fetch nearby technicians." });
  }
});

router.get("/public-list", async (req, res) => {
  try {
    // Public endpoint for map: only approved and active technicians
    const rows = await db.query(
      "SELECT id, name, service_type, location, latitude, longitude, service_area_range, experience, specialties, pricing, rating FROM technicians WHERE status = 'approved' AND is_active = TRUE"
    );
    return res.json(rows.map(rowToTechnician));
  } catch (err) {
    console.error("Public list error:", err);
    return res.status(500).json({ error: err.message || "Failed to fetch technicians." });
  }
});

router.get("/pending", verifyAdmin, async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM technicians WHERE status = 'pending' ORDER BY created_at DESC");
    return res.json(rows.map(rowToTechnician));
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch applications." });
  }
});

router.get("/list", verifyAdmin, async (req, res) => {
  try {
    const status = (req.query.status || "").toLowerCase();
    let rows;
    if (status === "pending" || status === "approved" || status === "rejected") {
      rows = await db.query("SELECT * FROM technicians WHERE status = ? ORDER BY created_at DESC", [status]);
    } else {
      rows = await db.query("SELECT * FROM technicians ORDER BY created_at DESC");
    }
    return res.json(rows.map(rowToTechnician));
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch technicians." });
  }
});



// Update technician availability status
router.patch("/status", verifyTechnician, async (req, res) => {
  try {
    const active = typeof req.body?.is_active === "boolean"
      ? req.body.is_active
      : typeof req.body?.active === "boolean"
        ? req.body.active
        : undefined;
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Active status must be a boolean." });
    }
    const pool = await db.getPool();
    await pool.execute(
      `UPDATE technicians
       SET is_active = ?,
           is_available = CASE
             WHEN ? = TRUE AND current_job_id IS NULL THEN TRUE
             ELSE FALSE
           END
       WHERE id = ?`,
      [active ? 1 : 0, active ? 1 : 0, req.technicianId]
    );
    void markTechnicianHeartbeat({
      technicianId: req.technicianId,
      source: req.get("x-client-platform") || "web",
      metadata: { active },
      createSessionIfMissing: false,
    }).catch((trackingError) => {
      console.error("[Technician status heartbeat] failed:", trackingError?.message || trackingError);
    });
    res.json({ success: true, is_active: active, is_available: active });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// Update technician location
router.patch("/location", verifyTechnician, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const parsedLat = Number(latitude);
    const parsedLng = Number(longitude);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      return res.status(400).json({ error: "latitude and longitude must be valid numbers." });
    }
    const pool = await db.getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE technicians
         SET latitude = ?,
             longitude = ?,
             current_lat = ?,
             current_lng = ?,
             last_location_update = NOW()
         WHERE id = ?`,
        [parsedLat, parsedLng, parsedLat, parsedLng, req.technicianId]
      );

      const [rows] = await conn.query(
        "SELECT current_job_id FROM technicians WHERE id = ? LIMIT 1",
        [req.technicianId]
      );
      let currentJobId = rows?.[0]?.current_job_id ? Number(rows[0].current_job_id) : null;
      if (!Number.isInteger(currentJobId)) {
        const [activeRows] = await conn.query(
          `SELECT id
           FROM service_requests
           WHERE technician_id = ?
            AND LOWER(COALESCE(status, '')) IN (
               'assigned',
               'accepted',
               'en_route_pickup',
               'arrived_pickup',
               'vehicle_loaded',
               'enroute_drop',
               'arrived_drop',
               'service_completed',
               'processing',
               'service_started',
               'en-route',
               'on-the-way',
               'arrived',
               'in_progress',
               'in-progress',
               'awaiting_payment',
               'payment_pending'
             )
           ORDER BY updated_at DESC
           LIMIT 1`,
          [req.technicianId]
        );
        currentJobId = activeRows?.[0]?.id ? Number(activeRows[0].id) : null;
      }
      await conn.execute(
        `INSERT INTO technician_location_history (technician_id, service_request_id, latitude, longitude)
         VALUES (?, ?, ?, ?)`,
        [req.technicianId, Number.isInteger(currentJobId) ? currentJobId : null, parsedLat, parsedLng]
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    void markTechnicianHeartbeat({
      technicianId: req.technicianId,
      source: req.get("x-client-platform") || "web",
      metadata: {
        latitude: parsedLat,
        longitude: parsedLng,
      },
      createSessionIfMissing: false,
    }).catch((trackingError) => {
      console.error("[Technician location heartbeat] failed:", trackingError?.message || trackingError);
    });

    // Optionally trigger socket event here if not already handled by client socket
    res.json({ success: true });
  } catch (err) {
    console.error("Update location error:", err);
    res.status(500).json({ error: "Failed to update location" });
  }
});

// Get dashboard stats
router.get("/dashboard-stats", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const wallet = await getTechnicianWalletSummary(pool, technicianId);

    // Get completed jobs count
    const [countRows] = await pool.execute(
      "SELECT COUNT(*) as count FROM service_requests WHERE technician_id = ? AND status IN ('completed', 'paid')",
      [technicianId]
    );

    const [earningsRows] = await pool.execute(
      `
      SELECT COALESCE(SUM(wt.amount), 0) as today
      FROM wallet_transactions wt
      WHERE wt.technician_id = ?
        AND wt.entry_type = 'payment_credit'
        AND DATE(wt.created_at) = CURDATE()
      `,
      [technicianId]
    );

    res.json({
      totalEarnings: roundMoney(wallet.total_earned || 0),
      withdrawableBalance: roundMoney(wallet.withdrawable_balance || 0),
      totalPaidOut: roundMoney(wallet.total_paid_out || 0),
      completedJobs: countRows[0].count || 0,
      todayEarnings: roundMoney(earningsRows[0]?.today || 0),
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Legacy raw endpoint (kept for backward compatibility/debug)
router.get("/me/active-job-legacy", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();

    // Find job where status is assigned, accepted, processing, en-route, or in-progress
    // Exclude completed or cancelled matches
    // Also include 'awaiting_payment/payment_pending' to keep payment-gated lifecycle visible.
    const [rows] = await pool.query(
      `SELECT * FROM service_requests 
       WHERE technician_id = ?
      AND status IN('assigned', 'accepted', 'en_route_pickup', 'arrived_pickup', 'vehicle_loaded', 'enroute_drop', 'arrived_drop', 'service_completed', 'processing', 'en-route', 'in_progress', 'in-progress', 'awaiting_payment', 'payment_pending')
       ORDER BY created_at DESC LIMIT 1`,
      [technicianId]
    );

    if (rows.length === 0) {
      return res.json(null);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Fetch active job error:", err);
    res.status(500).json({ error: "Failed to fetch active job" });
  }
});

// Get earnings history for the last 7 days
router.get("/earnings-history", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();

    const [rows] = await pool.execute(
      `SELECT DATE(wt.created_at) as date, SUM(wt.amount) as amount
       FROM wallet_transactions wt
       WHERE wt.technician_id = ?
         AND wt.entry_type = 'payment_credit'
         AND wt.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(wt.created_at)
       ORDER BY DATE(wt.created_at) ASC`,
      [technicianId]
    );

    // Fill in missing dates with 0
    const history = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const match = rows.find((r) => {
        if (r.date instanceof Date) {
          return r.date.toISOString().split('T')[0] === dateStr;
        }
        return String(r.date || "").split('T')[0] === dateStr;
      });
      history.push({
        date: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' }),
        amount: match ? roundMoney(match.amount || 0) : 0
      });
    }

    res.json(history);
  } catch (err) {
    console.error("Earnings history error:", err);
    res.status(500).json({ error: "Failed to fetch earnings history" });
  }
});

router.get("/me/payout-transactions", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 20;
    const rows = await getTechnicianWalletTransactionHistory(pool, technicianId, limit);
    const transactions = rows
      .filter((row) => row.entry_type === "payment_credit" || row.entry_type === "payout_debit")
      .map((row) => ({
        payment_id: row.payment_id || null,
        payout_id: row.payout_id || null,
        service_request_id: row.service_request_id,
        payment_method: row.entry_type === "payment_credit" ? "razorpay" : "manual_payout",
        payment_status: row.payment_status || row.payout_status || row.entry_type,
        request_status: row.entry_type === "payment_credit" ? "earned" : "paid_out",
        service_type: row.service_type,
        vehicle_type: row.vehicle_type,
        vehicle_model: row.vehicle_model,
        address: row.address,
        technician_amount: roundMoney(row.amount || 0),
        platform_fee: 0,
        is_settled: row.entry_type === "payout_debit",
        entry_type: row.entry_type,
        balance_after: roundMoney(row.balance_after || 0),
        created_at: row.created_at,
      }));

    res.json(transactions);
  } catch (err) {
    console.error("Fetch payout transactions error:", err);
    res.status(500).json({ error: "Failed to fetch payout transactions" });
  }
});

router.post("/create", verifyAdmin, async (req, res) => {
  try {
    const {
      name, email, password, phone,
      proprietor_name, alternate_phone, whatsapp_number,
      address, region, district, state, locality, google_maps_link,
      aadhaar_number, pan_number, business_type, gst_number, trade_license_number,
      working_hours, service_costs, payment_details, app_readiness, vehicle_types,
      serviceAreaRange, experience, specialties, pricing, status,
      resume_url, documents
    } = req.body;

    const normalizedEmail = (email || "").trim().toLowerCase();
    const trimmedName = (name || "").trim();

    if (!trimmedName || !normalizedEmail) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: "Password is required and must be at least 8 characters." });
    }
    const password_hash = await bcrypt.hash(String(password), 10);
    const normalizedSpecialties = normalizeSpecialties(specialties);
    const normalizedVehicleTypes = normalizeVehicleTypes(vehicle_types);
    const normalizedServiceCosts = normalizeServiceCosts(service_costs);
    const service_type = normalizedSpecialties[0] || "other";
    const location = (locality || address || "").trim() || "—";
    const normalizedDocuments = sanitizeTechnicianDocuments(documents);
    const normalizedResumeUrl = normalizeUploadResourcePath(resume_url);
    const upiId = String(payment_details?.upi_id || req.body?.upi_id || "").trim();
    const upiName = String(payment_details?.upi_name || req.body?.upi_name || proprietor_name || trimmedName).trim();
    const requestedStatus = String(status || "").toLowerCase();
    const appStatus = requestedStatus === "approved" ? "approved" : "pending";

    const specialtiesJson = JSON.stringify(normalizedSpecialties);
    const pricingJson = JSON.stringify(pricing && typeof pricing === "object" ? pricing : {});
    const documentsJson = JSON.stringify(normalizedDocuments);
    const workingHoursJson = JSON.stringify(working_hours || {});
    const serviceCostsJson = JSON.stringify(normalizedServiceCosts || {});
    const paymentDetailsJson = JSON.stringify(payment_details || {});
    const appReadinessJson = JSON.stringify(app_readiness || {});
    const vehicleTypesJson = JSON.stringify(normalizedVehicleTypes || {});

    const pool = await db.getPool();
    const result = await pool.execute(
      `INSERT INTO technicians(
        name, email, phone, upi_id, upi_name,
        proprietor_name, alternate_phone, whatsapp_number,
        service_type, location, status, password_hash,
        address, region, district, state, locality, google_maps_link,
        aadhaar_number, pan_number, business_type, gst_number, trade_license_number,
        service_area_range, experience,
        specialties, pricing, working_hours, service_costs, payment_details, app_readiness, vehicle_types,
        resume_url, documents
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trimmedName,
        normalizedEmail,
        (phone || "").trim(),
        upiId || null,
        upiName || null,
        (proprietor_name || "").trim(),
        (alternate_phone || "").trim(),
        (whatsapp_number || "").trim(),
        service_type,
        location,
        appStatus,
        password_hash,
        (address || "").trim(),
        (region || "").trim(),
        (district || "").trim(),
        (state || "").trim(),
        (locality || "").trim(),
        (google_maps_link || "").trim(),
        (aadhaar_number || "").trim(),
        (pan_number || "").trim(),
        (business_type || "").trim(),
        (gst_number || "").trim(),
        (trade_license_number || "").trim(),
        Number(serviceAreaRange) || 10,
        Number(experience) || 0,
        specialtiesJson,
        pricingJson,
        workingHoursJson,
        serviceCostsJson,
        paymentDetailsJson,
        appReadinessJson,
        vehicleTypesJson,
        normalizedResumeUrl,
        documentsJson,
      ]
    );
    const id = result[0].insertId;
    await sendEventEmail("TECHNICIAN_REGISTER", {
      name: trimmedName,
      email: normalizedEmail,
    });
    return res.status(201).json({ id: String(id), message: "Technician added successfully." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY" || err.message?.includes("Duplicate")) {
      return res.status(409).json({ error: "This email is already registered." });
    }
    return res.status(500).json({ error: err.message || "Failed to add technician." });
  }
});

router.get("/me/reviews", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const [rows] = await pool.query(
      `SELECT r.*, u.full_name as reviewer_name 
       FROM reviews r 
       JOIN users u ON r.user_id = u.id 
       WHERE r.technician_id = ?
      ORDER BY r.created_at DESC`,
      [technicianId]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Fetch reviews error:", err);
    return res.status(500).json({ error: "Failed to fetch reviews." });
  }
});

router.get("/me/notifications", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const [rows] = await pool.query(
      `
      SELECT
        CONCAT('offer-', d.id) AS id,
        'job_offer' AS type,
        'New job request' AS title,
        CONCAT(
          'Service: ',
          COALESCE(sr.service_type, 'Roadside assistance'),
          CASE
            WHEN COALESCE(sr.address, '') = '' THEN ''
            ELSE CONCAT(' at ', sr.address)
          END
        ) AS message,
        FALSE AS is_read,
        COALESCE(d.sent_at, sr.updated_at, sr.created_at) AS created_at
      FROM dispatch_offers d
      JOIN service_requests sr ON sr.id = d.service_request_id
      WHERE d.technician_id = ?
        AND LOWER(COALESCE(d.status, '')) = 'pending'
        AND LOWER(COALESCE(sr.status, '')) IN ('pending', 'assigned', 'technician_assigned')
      ORDER BY COALESCE(d.sent_at, sr.updated_at, sr.created_at) DESC
      LIMIT 20
      `,
      [technicianId]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Fetch notifications error:", err);
    return res.status(500).json({ error: "Failed to fetch notifications." });
  }
});

/**
 * GET /api/technicians/me/financials
 * Get earnings and pending dues
 */
router.get("/me/financials", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const snapshot = await fetchTechnicianFinancialSnapshot(pool, technicianId);
    res.json(snapshot);
  } catch (err) {
    console.error("Fetch financials error:", err);
    res.status(500).json({ error: "Failed to fetch financials" });
  }
});

router.get("/me/wallet", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const snapshot = await fetchTechnicianFinancialSnapshot(pool, technicianId);
    const withdrawals = await getTechnicianWithdrawalRequests({
      technicianId,
      page: 1,
      limit: 10,
    });

    return res.json({
      ...snapshot,
      pending_withdrawals: roundMoney(snapshot.on_hold_balance || 0),
      recent_withdrawals: withdrawals.data,
    });
  } catch (err) {
    console.error("Fetch wallet summary error:", err);
    return res.status(500).json({ error: "Failed to fetch wallet summary." });
  }
});

router.get("/me/withdrawals", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || "20"), 10) || 20, 1), 100);
    const result = await getTechnicianWithdrawalRequests({
      technicianId,
      page,
      limit,
    });
    return res.json(result);
  } catch (err) {
    console.error("Fetch withdrawals error:", err);
    return res.status(500).json({ error: "Failed to fetch withdrawals." });
  }
});

router.post("/me/withdrawals", verifyTechnician, async (req, res) => {
  try {
    const technicianId = req.technicianId;
    const amount =
      req.body?.amount == null || req.body?.amount === ""
        ? null
        : Number(req.body.amount);
    if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
      return res.status(400).json({ error: "Invalid withdrawal amount." });
    }

    const result = await createWithdrawalRequest({
      technicianId,
      amount,
      note: String(req.body?.note || "").trim(),
      requestedBy: String(technicianId),
      idempotencyKey: String(req.body?.idempotencyKey || req.headers["x-idempotency-key"] || "").trim(),
    });

    req.io?.emit?.("admin:payout_update", {
      withdrawalRequestId: result.request?.id || null,
      technicianId,
      amount: result.request?.amount || 0,
      status: result.request?.status || "pending",
      at: new Date().toISOString(),
    });
    req.io?.emit?.("technician:financials_update", {
      technicianId,
      at: new Date().toISOString(),
    });

    return res.status(result.alreadyCreated ? 200 : 201).json(result);
  } catch (err) {
    console.error("Create withdrawal request error:", err);
    const message = String(err?.message || "Failed to create withdrawal request.");
    if (
      message.includes("UPI ID") ||
      message.includes("beneficiary name") ||
      message.includes("exceeds withdrawable balance") ||
      message.includes("greater than zero")
    ) {
      return res.status(409).json({ error: message });
    }
    if (message.includes("not found")) {
      return res.status(404).json({ error: message });
    }
    return res.status(500).json({ error: "Failed to create withdrawal request." });
  }
});

/**
 * POST /api/technicians/me/pay-dues
 * Pay pending platform fees
 */
router.post("/me/pay-dues", verifyTechnician, async (req, res) => {
  try {
    if (!ensureRazorpayConfigured(res)) return;
    const technicianId = req.technicianId;
    const pool = await db.getPool();
    const pricingConfig = await getPlatformPricingConfig();
    const snapshot = await fetchTechnicianFinancialSnapshot(pool, technicianId);
    const amount = snapshot.pending_dues;
    if (amount <= 0) return res.status(400).json({ error: "No pending dues" });

    const options = {
      amount: Math.round(amount * 100),
      currency: pricingConfig.currency || "INR",
      receipt: `tech_dues_${technicianId}_${Date.now()}`,
      payment_capture: 1
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    console.error("Create dues order error:", err);
    res.status(500).json({ error: "Failed to create payment order" });
  }
});

/**
 * POST /api/technicians/me/verify-dues
 * Verify and settle dues
 */
router.post("/me/verify-dues", verifyTechnician, async (req, res) => {
  try {
    if (!ensureRazorpayConfigured(res)) return;
    const technicianId = req.technicianId;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    const pool = await db.getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute(`
        UPDATE payments p
        JOIN service_requests sr ON p.service_request_id = sr.id
        SET p.is_settled = TRUE
        WHERE sr.technician_id = ? AND p.status = 'completed' AND p.is_settled = FALSE
        `, [technicianId]);

      // Keep legacy dues rows consistent if present.
      await conn.execute(
        "UPDATE technician_dues SET status = 'paid' WHERE technician_id = ? AND status = 'pending'",
        [technicianId]
      );

      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    const snapshot = await fetchTechnicianFinancialSnapshot(pool, technicianId);
    socketService.notifyTechnician(technicianId, "technician:financials_update", snapshot);
    res.json({ success: true, financials: snapshot });
  } catch (err) {
    console.error("Verify dues error:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});


// --- Technician Service Pricing ---
router.get("/pricing-template", technicianPricingController.getPricingTemplate);
router.get("/service-pricing", verifyTechnician, technicianPricingController.getTechnicianServicePricing);
router.post("/service-pricing", verifyTechnician, technicianPricingController.saveTechnicianPricing);
router.get("/:technicianId/service-pricing", verifyAdmin, technicianPricingController.getTechnicianServicePricing);

// ============================================
// WILDCARD ROUTES (Must be last)
// ============================================

const mapTechnicianServicePricingRows = (rows = []) =>
  (rows || []).map((row) => ({
    id: row.id,
    service_domain: row.service_domain || "",
    service_name: row.service_domain || "",
    vehicle_type: row.vehicle_type || "",
    vehicle_type_pricing: row.vehicle_type || "",
    visit_charge: toMoneyOrNull(row.visit_charge),
    service_charge: toMoneyOrNull(row.service_charge),
    extra_km_charge: toMoneyOrNull(row.extra_km_charge),
    labour_min: toMoneyOrNull(row.labour_min),
    labour_max: toMoneyOrNull(row.labour_max),
    delivery_charge: toMoneyOrNull(row.delivery_charge),
    price_2w_min: toMoneyOrNull(row.price_2w_min),
    price_2w_max: toMoneyOrNull(row.price_2w_max),
    price_4w_min: toMoneyOrNull(row.price_4w_min),
    price_4w_max: toMoneyOrNull(row.price_4w_max),
    base_price: toMoneyOrNull(row.base_price),
    free_km: toMoneyOrNull(row.free_km),
    per_km_price: toMoneyOrNull(row.per_km_price),
    night_charge: toMoneyOrNull(row.night_charge),
    night_type: row.night_type || null,
    metadata: parseObject(row.metadata),
  }));

router.get("/:id", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const pool = await db.getPool();
    const [rows] = await pool.query("SELECT * FROM technicians WHERE id = ? LIMIT 1", [id]);
    const row = rows?.[0];
    if (!row) return res.status(404).json({ error: "Technician not found." });

    const [serviceRows] = await pool.query(
      `SELECT
         id,
         service_domain,
         vehicle_type,
         visit_charge,
         service_charge,
         extra_km_charge,
         labour_min,
         labour_max,
         delivery_charge,
         price_2w_min,
         price_2w_max,
         price_4w_min,
         price_4w_max,
         base_price,
         free_km,
         per_km_price,
         night_charge,
         night_type,
         metadata
       FROM technician_services
       WHERE technician_id = ?
       ORDER BY service_domain ASC, vehicle_type ASC, updated_at DESC, id DESC`,
      [id]
    );

    const technician = rowToTechnician(row);
    const hasProfileServiceCosts =
      (Array.isArray(technician.service_costs) && technician.service_costs.length > 0) ||
      (
        technician.service_costs &&
        typeof technician.service_costs === "object" &&
        !Array.isArray(technician.service_costs) &&
        Object.keys(technician.service_costs).length > 0
      );
    if (!hasProfileServiceCosts && Array.isArray(serviceRows) && serviceRows.length > 0) {
      const pricingRows = mapTechnicianServicePricingRows(serviceRows);
      technician.service_costs = pricingRows;
      technician.services_pricing = pricingRows;
    }

    return res.json(technician);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch technician." });
  }
});

router.patch("/:id/approve", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || "").trim();
    const pool = await db.getPool();
    const [existing] = await pool.query("SELECT id, name, email, status FROM technicians WHERE id = ? LIMIT 1", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }
    const previousStatus = String(existing[0].status || "pending");

    await pool.execute(
      "UPDATE technicians SET status = 'approved', is_active = TRUE, is_available = TRUE, current_job_id = NULL WHERE id = ?",
      [id]
    );
    await pool.execute(
      `INSERT INTO technician_approval_audit
      (technician_id, action, previous_status, new_status, reason, admin_email)
      VALUES (?, 'approved', ?, 'approved', ?, ?)`,
      [id, previousStatus, reason || "Approved by admin", req.adminEmail || "unknown-admin"]
    );
    await pool.execute(
      `INSERT INTO notifications (type, title, message, is_read)
       VALUES (?, ?, ?, 0)`,
      [
        ADMIN_NOTIFICATION_TYPES.TECHNICIAN_APPROVED,
        "Technician Approved",
        `${existing[0]?.name || "Technician"} has been approved.`,
      ]
    );
    const techRows = await db.query("SELECT name, email FROM technicians WHERE id = ?", [id]);
    const tech = techRows[0];
    if (tech?.email) {
      await sendEventEmail("TECHNICIAN_APPLICATION_APPROVED", {
        name: tech.name || "there",
        email: tech.email,
        status: "approved",
      });
    }
    socketService.broadcast("admin:technician_audit_update", {
      technicianId: id,
      action: "approved",
      adminEmail: req.adminEmail || "unknown-admin",
      reason: reason || "Approved by admin",
      createdAt: new Date().toISOString()
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to approve." });
  }
});

router.patch("/:id/reject", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || "").trim();
    const pool = await db.getPool();
    const [existing] = await pool.query("SELECT id, name, email, status FROM technicians WHERE id = ? LIMIT 1", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }
    const previousStatus = String(existing[0].status || "pending");
    await pool.execute(
      "UPDATE technicians SET status = 'rejected', is_active = FALSE, is_available = FALSE, current_job_id = NULL WHERE id = ?",
      [id]
    );
    await pool.execute(
      `INSERT INTO technician_approval_audit
      (technician_id, action, previous_status, new_status, reason, admin_email)
      VALUES (?, 'rejected', ?, 'rejected', ?, ?)`,
      [id, previousStatus, reason || "Rejected by admin", req.adminEmail || "unknown-admin"]
    );
    socketService.broadcast("admin:technician_audit_update", {
      technicianId: id,
      action: "rejected",
      adminEmail: req.adminEmail || "unknown-admin",
      reason: reason || "Rejected by admin",
      createdAt: new Date().toISOString()
    });
    if (existing[0]?.email) {
      await sendEventEmail("TECHNICIAN_APPLICATION_REJECTED", {
        name: existing[0].name || "there",
        email: existing[0].email,
        status: "rejected",
      });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to reject." });
  }
});

router.get("/:id/approval-audit", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await db.query(
      `SELECT id, technician_id, action, previous_status, new_status, reason, admin_email, created_at
       FROM technician_approval_audit
       WHERE technician_id = ?
       ORDER BY created_at DESC`,
      [id]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch approval audit trail." });
  }
});
export default router;
