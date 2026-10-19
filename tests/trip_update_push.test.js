import assert from "node:assert/strict";
import test from "node:test";
import { customerTripCopy, notificationService } from "../services/notificationService.js";

// The Android app's TripUpdateNotifier reads these fields to update the request's Live Update.
const pool = (row) => ({
  queries: [],
  async query(sql, params) {
    this.queries.push({ sql, params });
    return [[row]];
  },
});

test("a customer's status push is a data message the Android Live Update can use", async () => {
  const db = pool({ service_type: "lockout", technician_name: "Arun Kumar", technician_phone: "+91 98765 43210" });
  const payload = await notificationService.buildPayload(3, "user", "job:status_update", { requestId: 5318, status: "arrived" }, db);
  // Data only: a notification block would let Android show a separate plain notification.
  assert.equal(payload.notification, undefined);
  assert.equal(payload.android.priority, "high");
  assert.equal(payload.android.collapseKey, "trip_5318");
  assert.deepEqual(
    { type: payload.data.type, status: payload.data.status, requestId: payload.data.requestId },
    { type: "TRIP_UPDATE", status: "arrived", requestId: "5318" }
  );
  assert.equal(payload.data.title, "Arun is here");
  assert.equal(payload.data.body, "Meet your technician at the vehicle.");
  assert.equal(payload.data.technicianName, "Arun Kumar");
  assert.equal(payload.data.technicianPhone, "+91 98765 43210");
  assert.equal(payload.data.serviceType, "lockout");
  assert.equal(payload.data.deepLinkPath, "/service-tracking/5318");
  for (const value of Object.values(payload.data)) assert.equal(typeof value, "string");
  assert.deepEqual(db.queries[0].params, ["5318"]);
});

test("the web app still shows the update as one notification per request", async () => {
  const db = pool({ service_type: "flat_tire", technician_name: "Arun", technician_phone: null });
  const payload = await notificationService.buildPayload(3, "user", "job:status_update", { requestId: "5318", status: "accepted" }, db);
  assert.equal(payload.webpush.notification.title, "Arun accepted your request");
  assert.equal(payload.webpush.notification.body, "Flat tyre · getting ready to leave.");
  assert.equal(payload.webpush.notification.tag, "trip-5318");
  assert.equal(payload.data.technicianPhone, "");
});

test("a paid request and the payment event say the same thing", async () => {
  const db = pool({ service_type: "battery", technician_name: "Arun", technician_phone: "" });
  const paid = await notificationService.buildPayload(3, "user", "job:status_update", { requestId: "5318", status: "paid" }, db);
  const payment = await notificationService.buildPayload(3, "user", "payment_completed", { requestId: "5318" }, db);
  assert.equal(paid.data.title, "Paid · thank you");
  assert.equal(payment.data.title, "Paid · thank you");
  assert.equal(payment.data.status, "paid");
  assert.equal(payment.android.collapseKey, paid.android.collapseKey);
});

test("details already in the event are used without a database lookup", async () => {
  const db = pool({});
  const payload = await notificationService.buildPayload(3, "user", "job:status_update", {
    requestId: "5318", status: "in-progress", technicianName: "Meena", serviceType: "fuel_delivery",
  }, db);
  assert.equal(payload.data.title, "Work in progress");
  assert.equal(payload.data.body, "Meena is working on your vehicle.");
  assert.equal(db.queries.length, 0);
});

test("a failed lookup never holds the push back", async () => {
  const broken = { async query() { throw new Error("connection reset"); } };
  const payload = await notificationService.buildPayload(3, "user", "job:status_update", { requestId: "5318", status: "arrived" }, broken);
  assert.equal(payload.data.title, "Your technician is here");
});

test("steps without a push stay silent, and towing steps are covered", () => {
  assert.equal(customerTripCopy("pending", "Arun", "towing"), null);
  assert.equal(customerTripCopy("assigned", "Arun", "towing"), null);
  assert.equal(customerTripCopy("something_new", "Arun", "towing"), null);
  assert.equal(customerTripCopy("en_route_pickup", "Arun", "towing").title, "Arun is on the way");
  assert.equal(customerTripCopy("vehicle_loaded", "Arun", "towing").title, "Vehicle loaded");
  assert.equal(customerTripCopy("enroute_drop", "Arun", "towing").title, "Towing to the drop point");
  assert.equal(customerTripCopy("payment_pending", "Arun", "towing").body, "Pay online, or give cash to Arun.");
  assert.equal(customerTripCopy("cancelled", "", "").title, "Request cancelled");
});
