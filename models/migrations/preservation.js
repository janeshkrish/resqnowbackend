// Existing modules retain their own business keys. References into the current
// application are converted to its UUIDs; references within these modules keep
// their original key types. No module or record is omitted from the destination.
export const LEGACY_KEYS = Object.freeze({
  batch_payouts: ["batch_id", "payout_id"], daily_settlements: ["settlement_id"], finance_audit_logs: ["log_id"],
  fraud_flags: ["flag_id"], garage_booking_events: ["id"], garage_booking_parts: ["id"], garage_bookings: ["id"],
  garage_customer_vehicles: ["id"], garage_service_categories: ["id"], garage_service_history: ["id"], garage_services: ["id"],
  gateway_transactions: ["gateway_txn_id"], job_candidates: ["id"], ledger_accounts: ["account_id"], ledger_entries: ["entry_id"],
  payment_reconciliation: ["id"], payment_reconciliation_audit_logs: ["id"], payment_reconciliation_locks: ["lock_name"],
  payment_reconciliation_runs: ["id"], payout_batches: ["batch_id"], reconciliation_errors: ["error_id"], service_history: ["id"],
  supergarage_bookings: ["id"], supergarage_services: ["id"], supergarage_user_vehicles: ["id"],
  technician_availability: ["technician_id"], technician_skills: ["id"], vehicle_reminders: ["id"], vehicles: ["id"],
});
export const LEGACY_REFERENCES = Object.freeze({
  batch_payouts: { batch_id: "payout_batches", payout_id: "payouts" },
  fraud_flags: { job_id: "service_requests", technician_id: "technicians" },
  garage_booking_events: { booking_id: "garage_bookings", actor_id: null },
  garage_booking_parts: { booking_id: "garage_bookings" },
  garage_bookings: { user_id: "users", vehicle_id: "vehicles", service_id: "garage_services", technician_id: "technicians" },
  garage_customer_vehicles: { user_id: "users" },
  garage_service_history: { booking_id: "garage_bookings", vehicle_id: "vehicles", technician_id: "technicians" },
  gateway_transactions: { gateway_txn_id: null, order_id: null, payment_id: null },
  job_candidates: { request_id: "service_requests", technician_id: "technicians" },
  ledger_entries: { account_id: "ledger_accounts", transaction_id: null, reference_id: null },
  payment_reconciliation: { run_id: "payment_reconciliation_runs", payment_id: "payments" },
  payment_reconciliation_audit_logs: { run_id: "payment_reconciliation_runs", payment_id: "payments" },
  payment_reconciliation_locks: { owner_id: null },
  reconciliation_errors: { gateway_txn_id: "gateway_transactions", ledger_txn_id: null },
  service_history: { booking_id: "garage_bookings", vehicle_id: "vehicles", technician_id: "technicians", service_id: "garage_services" },
  supergarage_bookings: { customer_id: "users", vehicle_id: "supergarage_user_vehicles", garage_id: null, technician_id: "technicians" },
  supergarage_user_vehicles: { user_id: "users" }, technician_availability: { technician_id: "technicians" },
  technician_skills: { technician_id: "technicians" }, vehicle_reminders: { user_id: "users", vehicle_id: "vehicles" }, vehicles: { user_id: "users" },
});
export function legacyReference(table, column, fallback) {
  const references = LEGACY_REFERENCES[table] || {};
  return Object.hasOwn(references, column) ? references[column] : fallback;
}
export function migrationRowKey(table, row, preservedTables = []) {
  const keys = preservedTables.includes(table) ? LEGACY_KEYS[table] : ["id"];
  return keys.length === 1 ? String(row[keys[0]]) : JSON.stringify(keys.map(key => row[key]));
}
