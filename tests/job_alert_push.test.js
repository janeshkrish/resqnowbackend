import assert from "node:assert/strict";
import test from "node:test";
import { notificationService } from "../services/notificationService.js";

// The Android app's MyFirebaseMessagingService and the web app's useFCM read these fields.
const offer = {
  requestId: "6101",
  serviceType: "flat-tyre",
  customerName: "Asha",
  locationDistance: "2.4 km",
  priceAmount: 350,
};

test("a job offer push is a high-priority data message the Android alarm can build", async () => {
  const payload = await notificationService.buildPayload(7, "technician", "job_offer", offer, null);
  // Data only: a notification block would let Android show a plain notification instead.
  assert.equal(payload.notification, undefined);
  assert.equal(payload.android.priority, "high");
  assert.equal(payload.android.collapseKey, "job_6101");
  assert.equal(payload.data.type, "EMERGENCY_JOB");
  assert.equal(payload.data.event, "job_offer");
  assert.equal(payload.data.requestId, "6101");
  assert.equal(payload.data.jobId, "6101");
  assert.equal(payload.data.channelId, "high_priority_alarms");
  assert.equal(payload.data.deepLinkPath, "/job/6101");
  assert.match(payload.data.body, /flat-tyre • 2\.4 km away/);
  assert.match(payload.data.body, /₹350/);
  for (const value of Object.values(payload.data)) assert.equal(typeof value, "string");
});

test("a job offer push shows on the lock screen of the web app too", async () => {
  const payload = await notificationService.buildPayload(7, "technician", "job_offer", offer, null);
  assert.equal(payload.webpush.headers.Urgency, "high");
  assert.equal(payload.webpush.notification.requireInteraction, true);
  assert.equal(payload.webpush.notification.tag, "job-6101");
});

test("a taken job's push closes the alert on the phone", async () => {
  const payload = await notificationService.buildPayload(7, "technician", "job:revoked", { requestId: "6101" }, null);
  assert.equal(payload.data.type, "JOB_REVOKED");
  assert.equal(payload.data.requestId, "6101");
  assert.equal(payload.android.priority, "high");
});
