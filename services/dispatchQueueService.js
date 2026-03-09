import IORedis from "ioredis";
import { Queue, QueueEvents, Worker } from "bullmq";
import { getPool } from "../db.js";
import { jobDispatchService } from "./jobDispatchService.js";
import { socketService } from "./socket.js";

export const DISPATCH_QUEUE_NAME = "job-dispatch-queue";
const NEW_JOB_EVENT = "new-job";
const DISPATCH_TIMEOUT_EVENT = "dispatch-timeout";

const DISPATCH_WORKER_CONCURRENCY = Math.max(1, Number(process.env.DISPATCH_WORKER_CONCURRENCY || 8));
const DISPATCH_OFFER_TIMEOUT_MS = Math.max(1000, Number(process.env.DISPATCH_OFFER_TIMEOUT_MS || 10000));
const DISPATCH_RETRY_DELAY_MS = Math.max(500, Number(process.env.DISPATCH_RETRY_DELAY_MS || 1500));
const DISPATCH_MAX_RETRIES = Math.max(1, Number(process.env.DISPATCH_MAX_RETRIES || 40));
const DEFAULT_CUSTOMER_NAME = "Customer";

let queue = null;
let worker = null;
let queueEvents = null;

let producerConnection = null;
let workerConnection = null;
let eventsConnection = null;

function redisUrl() {
  return String(process.env.REDIS_URL || "").trim();
}

export function isDispatchQueueEnabled() {
  return Boolean(redisUrl());
}

function createRedisConnection(label) {
  const url = redisUrl();
  const connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    connectionName: `resqnow_${label}`,
  });

  connection.on("connect", () => {
    console.log(`[Dispatch Queue] Redis connected (${label}).`);
  });
  connection.on("ready", () => {
    console.log(`[Dispatch Queue] Redis ready (${label}).`);
  });
  connection.on("error", (error) => {
    console.error(`[Dispatch Queue] Redis error (${label}):`, error?.message || error);
  });
  connection.on("close", () => {
    console.warn(`[Dispatch Queue] Redis connection closed (${label}).`);
  });
  return connection;
}

async function getProducerConnection() {
  if (producerConnection) return producerConnection;
  producerConnection = createRedisConnection("dispatch_producer");
  await producerConnection.connect();
  return producerConnection;
}

async function getWorkerConnection() {
  if (workerConnection) return workerConnection;
  workerConnection = createRedisConnection("dispatch_worker");
  await workerConnection.connect();
  return workerConnection;
}

async function getEventsConnection() {
  if (eventsConnection) return eventsConnection;
  eventsConnection = createRedisConnection("dispatch_events");
  await eventsConnection.connect();
  return eventsConnection;
}

async function getDispatchQueue() {
  if (!isDispatchQueueEnabled()) return null;
  if (queue) return queue;

  console.log(`[Dispatch Queue] Creating queue instance (${DISPATCH_QUEUE_NAME}).`);
  queue = new Queue(DISPATCH_QUEUE_NAME, {
    connection: await getProducerConnection(),
    defaultJobOptions: {
      removeOnComplete: 5000,
      removeOnFail: 5000,
    },
  });
  return queue;
}

function asPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAttemptedTechnicianIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function buildQueuePayload(input = {}) {
  return {
    jobId: asPositiveInt(input.jobId),
    userId: asPositiveInt(input.userId),
    retryCount: Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    attemptedTechnicianIds: normalizeAttemptedTechnicianIds(input.attemptedTechnicianIds),
    source: String(input.source || "").trim() || "api",
  };
}

async function fetchRequestRow(pool, jobId) {
  const [rows] = await pool.query(
    `SELECT
        sr.id,
        sr.user_id,
        sr.service_type,
        sr.vehicle_type,
        sr.address,
        sr.contact_name,
        sr.location_lat,
        sr.location_lng,
        COALESCE(sr.amount, sr.service_charge, 0) AS amount,
        sr.status,
        sr.technician_id
     FROM service_requests sr
     WHERE sr.id = ?
     LIMIT 1`,
    [jobId]
  );
  return rows?.[0] || null;
}

function isPendingUnassignedRequest(requestRow) {
  if (!requestRow) return false;
  const status = normalizeStatus(requestRow.status);
  const technicianAssigned = requestRow.technician_id != null;
  return status === "pending" && !technicianAssigned;
}

async function expireStaleOffers(pool, jobId) {
  const expiryCutoff = new Date(Date.now() - DISPATCH_OFFER_TIMEOUT_MS);
  await pool.query(
    `UPDATE dispatch_offers
     SET status = 'expired',
         expires_at = COALESCE(expires_at, NOW())
     WHERE service_request_id = ?
       AND status = 'pending'
       AND sent_at <= ?`,
    [jobId, expiryCutoff]
  );
}

async function getActivePendingOffers(pool, jobId) {
  const [rows] = await pool.query(
    `SELECT technician_id
     FROM dispatch_offers
     WHERE service_request_id = ?
       AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [jobId]
  );
  return rows || [];
}

async function getAttemptedTechnicianSet(pool, jobId, explicitAttempted) {
  const attempted = new Set(normalizeAttemptedTechnicianIds(explicitAttempted));
  const [rows] = await pool.query(
    `SELECT technician_id
     FROM dispatch_offers
     WHERE service_request_id = ?
       AND status IN ('accepted', 'rejected', 'expired')`,
    [jobId]
  );
  for (const row of rows || []) {
    const id = String(row?.technician_id || "").trim();
    if (id) attempted.add(id);
  }
  return attempted;
}

function buildOfferPayload(requestRow, candidateTech) {
  const distanceText = String(candidateTech?.distanceText || "Nearby").trim() || "Nearby";
  const etaText = String(candidateTech?.etaText || "").trim();

  return {
    id: String(requestRow.id),
    requestId: String(requestRow.id),
    jobId: String(requestRow.id),
    userId: requestRow.user_id != null ? String(requestRow.user_id) : undefined,
    customerName: String(requestRow.contact_name || DEFAULT_CUSTOMER_NAME),
    serviceType: String(requestRow.service_type || "Roadside Assistance"),
    vehicleType: String(requestRow.vehicle_type || "car"),
    location: {
      lat: Number(requestRow.location_lat),
      lng: Number(requestRow.location_lng),
      address: String(requestRow.address || ""),
    },
    address: String(requestRow.address || ""),
    amount: Number(requestRow.amount || 0),
    priceAmount: Number(requestRow.amount || 0),
    distance: distanceText,
    locationDistance: distanceText,
    eta: etaText || null,
    expiresIn: Math.ceil(DISPATCH_OFFER_TIMEOUT_MS / 1000),
    dispatchSource: "redis_queue",
  };
}

async function upsertPendingOffer(pool, jobId, technicianId) {
  const expiresAt = new Date(Date.now() + DISPATCH_OFFER_TIMEOUT_MS);

  const [existingRows] = await pool.query(
    `SELECT id
     FROM dispatch_offers
     WHERE service_request_id = ?
       AND technician_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [jobId, technicianId]
  );

  const existingId = existingRows?.[0]?.id;
  if (existingId) {
    await pool.query(
      `UPDATE dispatch_offers
       SET status = 'pending',
           sent_at = NOW(),
           expires_at = ?
       WHERE id = ?`,
      [expiresAt, existingId]
    );
    return;
  }

  await pool.query(
    `INSERT INTO dispatch_offers (service_request_id, technician_id, status, sent_at, expires_at)
     VALUES (?, ?, 'pending', NOW(), ?)`,
    [jobId, technicianId, expiresAt]
  );
}

async function scheduleDispatchTimeout(payload) {
  const q = await getDispatchQueue();
  if (!q) return null;

  return q.add(DISPATCH_TIMEOUT_EVENT, payload, {
    delay: DISPATCH_OFFER_TIMEOUT_MS,
    jobId: `${DISPATCH_TIMEOUT_EVENT}:${payload.jobId}:${payload.technicianId}:${Date.now()}`,
  });
}

async function requeueJob(payload, delayMs = DISPATCH_RETRY_DELAY_MS) {
  return enqueueDispatchJob(payload, { delayMs });
}

async function processNewDispatchJob(data) {
  const payload = buildQueuePayload(data);
  const jobId = payload.jobId;
  if (!jobId) return { skipped: true, reason: "invalid_job_id" };
  if (payload.retryCount > DISPATCH_MAX_RETRIES) {
    return { skipped: true, reason: "max_retries_reached" };
  }
  console.log(
    `[Dispatch Queue] Processing new-job requestId=${jobId} retryCount=${payload.retryCount} source=${payload.source}`
  );

  const pool = await getPool();
  const requestRow = await fetchRequestRow(pool, jobId);
  if (!requestRow) return { skipped: true, reason: "request_not_found" };
  if (!isPendingUnassignedRequest(requestRow)) {
    return { skipped: true, reason: `request_not_dispatchable:${normalizeStatus(requestRow.status)}` };
  }

  await expireStaleOffers(pool, jobId);
  const activePendingOffers = await getActivePendingOffers(pool, jobId);
  if ((activePendingOffers || []).length > 0) {
    return { skipped: true, reason: "pending_offer_active" };
  }

  const attemptedSet = await getAttemptedTechnicianSet(pool, jobId, payload.attemptedTechnicianIds);
  const candidates = await jobDispatchService.findTopTechnicians({
    id: requestRow.id,
    service_type: requestRow.service_type,
    vehicle_type: requestRow.vehicle_type,
    address: requestRow.address,
    location_lat: requestRow.location_lat,
    location_lng: requestRow.location_lng,
    amount: requestRow.amount,
    contact_name: requestRow.contact_name || DEFAULT_CUSTOMER_NAME,
  });
  console.log(
    `[Dispatch Queue] Technician candidates requestId=${jobId} count=${Array.isArray(candidates) ? candidates.length : 0}`
  );

  const nextCandidate = (candidates || []).find((candidate) => {
    const candidateId = String(candidate?.id || "").trim();
    return candidateId && !attemptedSet.has(candidateId);
  });

  if (!nextCandidate) {
    const shouldResetAttempts = (candidates || []).length > 0 && attemptedSet.size >= (candidates || []).length;
    const nextAttempted = shouldResetAttempts ? [] : Array.from(attemptedSet);

    await requeueJob(
      {
        ...payload,
        attemptedTechnicianIds: nextAttempted,
        retryCount: payload.retryCount + 1,
        source: "no_candidate_retry",
      },
      DISPATCH_RETRY_DELAY_MS
    );
    console.warn(
      `[Dispatch Queue] No eligible technician for requestId=${jobId}. Requeued retryCount=${payload.retryCount + 1}`
    );
    return { queued: true, reason: "no_available_candidate" };
  }

  const technicianId = asPositiveInt(nextCandidate.id);
  if (!technicianId) {
    await requeueJob({ ...payload, retryCount: payload.retryCount + 1 }, DISPATCH_RETRY_DELAY_MS);
    return { queued: true, reason: "invalid_candidate_id" };
  }

  await upsertPendingOffer(pool, jobId, technicianId);
  const offerPayload = buildOfferPayload(requestRow, nextCandidate);
  console.log(
    `[Dispatch Queue] Dispatching JOB_ALERT requestId=${jobId} technicianId=${technicianId} retryCount=${payload.retryCount}`
  );

  if (socketService.io) {
    socketService.io.to(`technician_${technicianId}`).emit("JOB_ALERT", offerPayload);
    socketService.io.to(`technician_${technicianId}`).emit("job:list_update", {
      requestId: String(jobId),
      action: "created",
    });
  }
  socketService.notifyTechnician(technicianId, "job_offer", offerPayload);

  const nextAttempted = [...new Set([...Array.from(attemptedSet), String(technicianId)])];
  await scheduleDispatchTimeout({
    jobId,
    technicianId,
    retryCount: payload.retryCount + 1,
    attemptedTechnicianIds: nextAttempted,
    source: "offer_timeout",
  });
  console.log(
    `[Dispatch Queue] Timeout scheduled requestId=${jobId} technicianId=${technicianId} timeoutMs=${DISPATCH_OFFER_TIMEOUT_MS}`
  );

  return { queued: true, technicianId };
}

async function processDispatchTimeoutJob(data) {
  const payload = buildQueuePayload(data);
  const jobId = payload.jobId;
  const technicianId = asPositiveInt(data?.technicianId);
  if (!jobId || !technicianId) return { skipped: true, reason: "invalid_timeout_payload" };
  console.log(
    `[Dispatch Queue] Processing timeout requestId=${jobId} technicianId=${technicianId} retryCount=${payload.retryCount}`
  );

  const pool = await getPool();
  const requestRow = await fetchRequestRow(pool, jobId);
  if (!requestRow) return { skipped: true, reason: "request_not_found" };
  if (!isPendingUnassignedRequest(requestRow)) {
    return { skipped: true, reason: `request_resolved:${normalizeStatus(requestRow.status)}` };
  }

  const [pendingOfferRows] = await pool.query(
    `SELECT id
     FROM dispatch_offers
     WHERE service_request_id = ?
       AND technician_id = ?
       AND status = 'pending'
     ORDER BY id DESC
     LIMIT 1`,
    [jobId, technicianId]
  );

  const pendingOfferId = pendingOfferRows?.[0]?.id;
  if (!pendingOfferId) {
    return { skipped: true, reason: "offer_already_handled" };
  }

  await pool.query(
    `UPDATE dispatch_offers
     SET status = 'expired',
         expires_at = COALESCE(expires_at, NOW())
     WHERE id = ?`,
    [pendingOfferId]
  );
  console.log(`[Dispatch Queue] Offer expired requestId=${jobId} technicianId=${technicianId}`);

  const takenPayload = {
    jobId: String(jobId),
    technicianId: null,
    message: "Job offer timed out.",
  };
  if (socketService.io) {
    socketService.io.to(`technician_${technicianId}`).emit("JOB_TAKEN", takenPayload);
  }
  socketService.notifyTechnician(technicianId, "job:revoked", {
    requestId: String(jobId),
    jobId: String(jobId),
    message: "Job offer timed out. Reassigning request.",
  });

  const nextAttempted = [...new Set([...payload.attemptedTechnicianIds, String(technicianId)])];
  await requeueJob(
    {
      ...payload,
      attemptedTechnicianIds: nextAttempted,
      retryCount: payload.retryCount + 1,
      source: "timeout_retry",
    },
    DISPATCH_RETRY_DELAY_MS
  );
  console.log(
    `[Dispatch Queue] Requeued after timeout requestId=${jobId} nextRetryCount=${payload.retryCount + 1}`
  );
  return { queued: true, reason: "requeued_after_timeout" };
}

async function processDispatchQueueJob(job) {
  if (!job || !job.name) return { skipped: true, reason: "invalid_job" };
  console.log(`[Dispatch Queue] Worker received job name=${job.name} id=${job.id}`);
  if (job.name === NEW_JOB_EVENT) return processNewDispatchJob(job.data || {});
  if (job.name === DISPATCH_TIMEOUT_EVENT) return processDispatchTimeoutJob(job.data || {});
  return { skipped: true, reason: `unknown_event:${job.name}` };
}

export async function enqueueDispatchJob(payload, options = {}) {
  if (!isDispatchQueueEnabled()) {
    return { queued: false, reason: "redis_not_configured" };
  }

  const normalizedPayload = buildQueuePayload(payload);
  if (!normalizedPayload.jobId) {
    return { queued: false, reason: "invalid_job_id" };
  }

  try {
    const q = await getDispatchQueue();
    if (!q) return { queued: false, reason: "queue_unavailable" };

    const delayMs = Math.max(0, Number(options.delayMs || 0));
    console.log(
      `[Dispatch Queue] Adding job requestId=${normalizedPayload.jobId} retryCount=${normalizedPayload.retryCount} delayMs=${delayMs}`
    );
    const queuedJob = await q.add(NEW_JOB_EVENT, normalizedPayload, {
      delay: delayMs,
      jobId: `${NEW_JOB_EVENT}:${normalizedPayload.jobId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
    console.log(
      `[Dispatch Queue] Job added requestId=${normalizedPayload.jobId} queueJobId=${queuedJob?.id || "n/a"}`
    );
    return { queued: true, id: queuedJob?.id || null };
  } catch (error) {
    console.error(
      `[Dispatch Queue] Failed to enqueue requestId=${normalizedPayload.jobId}:`,
      error?.message || error
    );
    return { queued: false, reason: "enqueue_failed" };
  }
}

export async function startDispatchQueueWorker() {
  if (!isDispatchQueueEnabled()) {
    console.warn("[Dispatch Queue] REDIS_URL missing. Queue worker is disabled.");
    return false;
  }
  if (worker) return true;

  try {
    console.log(`[Dispatch Queue] Starting worker. pid=${process.pid}, queue=${DISPATCH_QUEUE_NAME}`);
    await getDispatchQueue();

    queueEvents = new QueueEvents(DISPATCH_QUEUE_NAME, {
      connection: await getEventsConnection(),
    });
    queueEvents.on("failed", ({ jobId, failedReason }) => {
      console.error(`[Dispatch Queue] Job ${jobId} failed: ${failedReason}`);
    });
    queueEvents.on("waiting", ({ jobId }) => {
      console.log(`[Dispatch Queue] Job waiting id=${jobId}`);
    });
    queueEvents.on("active", ({ jobId }) => {
      console.log(`[Dispatch Queue] Job active id=${jobId}`);
    });
    await queueEvents.waitUntilReady();

    worker = new Worker(
      DISPATCH_QUEUE_NAME,
      async (job) => processDispatchQueueJob(job),
      {
        connection: await getWorkerConnection(),
        concurrency: DISPATCH_WORKER_CONCURRENCY,
      }
    );

    worker.on("completed", (job) => {
      if (!job) return;
      console.log(`[Dispatch Queue] Completed ${job.name} job id=${job.id}`);
    });

    worker.on("failed", (job, error) => {
      console.error(
        `[Dispatch Queue] Failed ${job?.name || "unknown"} job id=${job?.id || "n/a"}:`,
        error?.message || error
      );
    });

    await worker.waitUntilReady();
    console.log(
      `[Dispatch Queue] Worker started. queue=${DISPATCH_QUEUE_NAME}, concurrency=${DISPATCH_WORKER_CONCURRENCY}, timeoutMs=${DISPATCH_OFFER_TIMEOUT_MS}`
    );
    return true;
  } catch (error) {
    console.error("[Dispatch Queue] Worker start failed:", error?.message || error);
    await stopDispatchQueueWorker();
    return false;
  }
}

export async function stopDispatchQueueWorker() {
  const closeSafely = async (resource, label) => {
    if (!resource) return;
    try {
      await resource.close();
    } catch (error) {
      console.error(`[Dispatch Queue] Failed to close ${label}:`, error?.message || error);
    }
  };

  await closeSafely(worker, "worker");
  await closeSafely(queueEvents, "queueEvents");
  await closeSafely(queue, "queue");

  worker = null;
  queueEvents = null;
  queue = null;

  const disconnectSafely = async (connection, label) => {
    if (!connection) return;
    try {
      await connection.quit();
    } catch {
      try {
        connection.disconnect();
      } catch (error) {
        console.error(`[Dispatch Queue] Failed to disconnect ${label}:`, error?.message || error);
      }
    }
  };

  await disconnectSafely(producerConnection, "producerConnection");
  await disconnectSafely(workerConnection, "workerConnection");
  await disconnectSafely(eventsConnection, "eventsConnection");

  producerConnection = null;
  workerConnection = null;
  eventsConnection = null;
}
