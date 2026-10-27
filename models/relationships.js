import { TABLES } from "./schema/index.js";

// External provider IDs (Google/Firebase/Razorpay/UPI/OSM) are not database keys.
export const EXTERNAL_IDS = new Set([
  "app_id", // Android package name, not a relational UUID.
  "google_id", "firebase_uid", "upi_id", "registration_payment_id", "registration_order_id",
  "razorpay_payment_id", "razorpay_order_id", "order_id", "sequence_id",
]);

export const COLUMN_TARGETS = Object.freeze({
  installation_id: "android_app_installations",
  user_id: "users", customer_id: "users", technician_id: "technicians",
  service_request_id: "service_requests", request_id: "service_requests", current_job_id: "service_requests",
  assigned_vehicle_id: "technician_fleet_vehicles", assigned_employee_id: "technician_team_members",
  wallet_id: "technician_wallets", wallet_transaction_id: "wallet_transactions", payment_id: "payments",
  payout_id: "payouts", withdrawal_request_id: "withdrawal_requests", complaint_id: "admin_complaints",
  service_id: "service_master", vehicle_category_id: "vehicle_category_master",
  vehicle_subcategory_id: "vehicle_subcategory_master", fleet_id: "towing_fleet_master",
  admin_id: "users", adminId: "users", assigned_admin_id: "users", created_by: "users",
  requested_by: "users", reviewed_by: "users", processed_by: "users", pricing_overridden_by: "users",
});

export const POLYMORPHIC = Object.freeze({
  android_app_installation_accounts: { account_id: "account_type" },
  device_tokens: { user_id: "user_type" },
  request_timeline: { actor_id: "actor_type" },
  request_attachments: { uploaded_by_id: "uploaded_by_type" },
  admin_actions_log: { target_id: "target_type" },
  wallet_transactions: { reference_id: "reference_type" },
});

export const ENTITY_TABLES = Object.freeze({
  user: "users", customer: "users", admin: "users", technician: "technicians",
  request: "service_requests", service_request: "service_requests", job: "service_requests",
  payment: "payments", payout: "payouts", refund: "payment_refunds", payment_refund: "payment_refunds",
  withdrawal: "withdrawal_requests", withdrawal_request: "withdrawal_requests",
  wallet: "technician_wallets", wallet_transaction: "wallet_transactions",
  complaint: "admin_complaints", admin_complaint: "admin_complaints",
  notification: "notifications", invoice: "invoices", service: "service_master",
});

export function referenceTarget(table, column, row = {}) {
  if (table === "withdrawal_requests" && column === "requested_by") return "technicians";
  // Historical refund reversals stored payment_id in reference_id.
  if (table === "wallet_transactions" && column === "reference_id" && row.reference_type === "refund") return "payments";
  if (table === "admin_audit_logs" && column === "targetId") {
    let metadata = row.metadata;
    if (typeof metadata === "string") { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
    const named = { requestId: "service_requests", technicianId: "technicians", complaintId: "admin_complaints" };
    for (const [name, target] of Object.entries(named)) if (metadata?.params?.[name] != null) return target;
    const route = String(metadata?.path || row.actionType || "").split("?")[0];
    const resources = { withdrawals: "withdrawal_requests", "withdrawal-requests": "withdrawal_requests", payouts: "payouts",
      payments: "payments", complaints: "admin_complaints", technicians: "technicians", requests: "service_requests",
      "service-requests": "service_requests", customers: "users", users: "users" };
    for (const segment of route.split("/")) if (resources[segment]) return resources[segment];
    for (const [name, target] of Object.entries(named)) if (metadata?.body?.[name] != null) return target;
  }
  if (POLYMORPHIC[table]?.[column]) return ENTITY_TABLES[String(row[POLYMORPHIC[table][column]] || "").toLowerCase()] || null;
  return COLUMN_TARGETS[column] || null;
}

export const JSON_ID_TARGETS = Object.freeze({
  ...COLUMN_TARGETS,
  userId: "users", customerId: "users", technicianId: "technicians", previousTechnicianId: "technicians",
  selectedTechnicianId: "technicians", technicianIds: "technicians", attemptedTechnicianIds: "technicians",
  requestId: "service_requests", jobId: "service_requests", offerId: "dispatch_offers", offer_id: "dispatch_offers",
  walletId: "technician_wallets", walletTransactionId: "wallet_transactions", paymentId: "payments",
  payoutId: "payouts", withdrawalRequestId: "withdrawal_requests", complaintId: "admin_complaints",
  assignedVehicleId: "technician_fleet_vehicles", assignedEmployeeId: "technician_team_members",
  serviceId: "service_master", vehicleCategoryId: "vehicle_category_master", vehicleSubcategoryId: "vehicle_subcategory_master",
  fleetId: "towing_fleet_master", adminId: "users", overridden_by: "users",
  notificationId: "notifications", invoiceId: "invoices",
});

export const MODEL_TABLES = Object.freeze(Object.keys(TABLES));

// Source schemas accepted during the v1 -> v2 deployment transfer only.
export const RETIRED_TABLES = Object.freeze([
  "otp_rate_limits", "technician_admin_notes", "admin_customer_notes", "technician_approval_audit", "admin_audit_logs",
]);
export const SOURCE_TABLES = Object.freeze([...MODEL_TABLES, ...RETIRED_TABLES]);
