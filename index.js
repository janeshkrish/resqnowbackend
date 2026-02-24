import "./loadEnv.js";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import path from "path";

import techniciansRouter from "./routes/technicians.js";
import adminRouter from "./routes/admin.js";
import usersRouter from "./routes/users.js";
import authRouter from "./routes/auth.js";
import serviceRequestsRouter from "./routes/service_requests.js";
import publicRouter from "./routes/public.js";
import uploadRouter from "./routes/upload.js";
import vehiclesRouter from "./routes/vehicles.js";
import paymentsRouter from "./routes/payments.js";
import chatbotRouter from "./routes/chatbot.js";

import {
  buildCorsOptions,
  getAllowedOriginsForLogs,
  getApiBaseUrl,
  getBackendPublicUrl,
  getFrontendUrl,
  getGoogleCallbackUrl,
} from "./config/network.js";
import { socketService } from "./services/socket.js";
import { closePool } from "./db.js";

const PORT = Number(process.env.PORT || 3001);
const HOST = "0.0.0.0";

const dbState = {
  ready: false,
  lastCheckedAt: null,
  lastError: null,
};

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function parseUrlOrThrow(name, value) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1") return true;
  return isPrivateIpv4(normalized);
}

function validateRuntimeUrls() {
  const frontendUrl = normalizeUrl(getFrontendUrl());
  const backendPublicUrl = normalizeUrl(getBackendPublicUrl());
  const googleCallbackUrl = normalizeUrl(getGoogleCallbackUrl());

  const frontend = parseUrlOrThrow("FRONTEND_URL/FRONTEND_PUBLIC_URL", frontendUrl);
  const backend = parseUrlOrThrow("BACKEND_URL/BACKEND_PUBLIC_URL", backendPublicUrl);
  const googleCallback = parseUrlOrThrow("GOOGLE_CALLBACK_URL", googleCallbackUrl);

  if (isProductionLike()) {
    if (frontend.protocol !== "https:") {
      throw new Error(`FRONTEND_URL must use https in production. Received: ${frontendUrl}`);
    }
    if (backend.protocol !== "https:") {
      throw new Error(`BACKEND_URL must use https in production. Received: ${backendPublicUrl}`);
    }
    if (googleCallback.protocol !== "https:") {
      throw new Error(`GOOGLE_CALLBACK_URL must use https in production. Received: ${googleCallbackUrl}`);
    }
    if (isPrivateHost(backend.hostname)) {
      throw new Error(`BACKEND_URL cannot point to localhost/private host in production. Received: ${backendPublicUrl}`);
    }
  }

  const expectedGoogleCallback = `${backendPublicUrl}/auth/google/callback`;
  if (googleCallbackUrl !== expectedGoogleCallback) {
    const msg = `GOOGLE_CALLBACK_URL should match ${expectedGoogleCallback}. Received: ${googleCallbackUrl}`;
    if (isProductionLike()) {
      throw new Error(msg);
    }
    console.warn(`[ENV WARNING] ${msg}`);
  }
}

function validateRequiredEnv() {
  const required = [
    "DB_HOST",
    "DB_PORT",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "JWT_SECRET",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "EMAIL_USER",
    "EMAIL_PASS",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ];

  if (isProductionLike()) {
    required.push("GOOGLE_CALLBACK_URL");
  }

  const missing = required.filter((key) => !String(process.env[key] || "").trim());
  const hasFrontendUrl = Boolean(
    String(process.env.FRONTEND_PUBLIC_URL || "").trim() ||
      String(process.env.FRONTEND_URL || "").trim()
  );
  if (!hasFrontendUrl) {
    missing.push("FRONTEND_URL or FRONTEND_PUBLIC_URL");
  }

  if (missing.length === 0) return;

  const msg = `Missing required environment variables: ${missing.join(", ")}`;
  if (isProductionLike()) {
    throw new Error(msg);
  }
  console.warn(`[ENV WARNING] ${msg}`);
}

async function bootstrapDatabase() {
  const {
    ensureTechniciansTable,
    ensureUsersTable,
    ensureServiceRequestsTable,
    ensureNotificationsTable,
    ensureReviewsTable,
    ensureFilesTable,
    ensurePaymentsTable,
    ensureInvoicesTable,
    ensureTechnicianApprovalAuditTable,
    ensureUserVehiclesTable,
    ensureTechnicianDuesTable,
    ensureDispatchOffersTable,
    ensurePlatformPricingConfigTable,
    updateTechniciansTableSchema,
    updateServiceRequestsTableSchema,
    updateUsersTableSchema,
  } = await import("./db.js");

  await Promise.all([
    ensureTechniciansTable(),
    ensureUsersTable(),
    ensureServiceRequestsTable(),
    ensureNotificationsTable(),
    ensureReviewsTable(),
    ensureFilesTable(),
    ensurePaymentsTable(),
    ensureInvoicesTable(),
    ensureTechnicianApprovalAuditTable(),
    ensureUserVehiclesTable(),
    ensureTechnicianDuesTable(),
    ensureDispatchOffersTable(),
    ensurePlatformPricingConfigTable(),
  ]);

  await Promise.all([
    updateTechniciansTableSchema(),
    updateServiceRequestsTableSchema(),
    updateUsersTableSchema(),
  ]);
}

function createApp() {
  const app = express();
  app.set("trust proxy", true);

  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const origin = req.get("origin") || "none";
    const requestId = req.get("x-request-id") || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader("x-request-id", requestId);

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        `[${new Date().toISOString()}] ${requestId} ${req.method} ${req.originalUrl} ` +
          `status=${res.statusCode} duration_ms=${durationMs.toFixed(1)} origin=${origin} ip=${req.ip}`
      );
    });
    next();
  });

  app.use("/uploads", express.static(path.join(process.cwd(), "server", "uploads")));
  app.use("/api/upload", uploadRouter);

  app.use((req, _res, next) => {
    req.io = socketService.io;
    next();
  });

  // Route mounts
  app.use("/api/technicians", techniciansRouter);
  app.use("/api/technician", techniciansRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/auth", authRouter);
  app.use("/auth", authRouter); // Needed for Google callback URI compatibility
  app.use("/api/service-requests", serviceRequestsRouter);
  app.use("/api/requests", serviceRequestsRouter);
  app.use("/api/public", publicRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/vehicles", vehiclesRouter);
  app.use("/api/chatbot", chatbotRouter);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      apiBaseUrl: getApiBaseUrl(),
      backendPublicUrl: getBackendPublicUrl(),
      frontendUrl: getFrontendUrl(),
      googleCallbackUrl: getGoogleCallbackUrl(),
      database: {
        ready: dbState.ready,
        lastCheckedAt: dbState.lastCheckedAt,
        lastError: dbState.lastError,
      },
    });
  });

  app.get("/ready", (_req, res) => {
    const payload = {
      ok: dbState.ready,
      timestamp: new Date().toISOString(),
      database: {
        ready: dbState.ready,
        lastCheckedAt: dbState.lastCheckedAt,
        lastError: dbState.lastError,
      },
    };
    if (!dbState.ready) return res.status(503).json(payload);
    return res.json(payload);
  });

  app.use((err, _req, res, _next) => {
    if (String(err?.message || "").startsWith("CORS policy violation")) {
      return res.status(403).json({ error: "CORS request blocked for this origin." });
    }
    console.error("[UNHANDLED ROUTE ERROR]", err?.stack || err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

const app = createApp();
const httpServer = createServer(app);
socketService.init(httpServer);

httpServer.on("error", (err) => {
  console.error("HTTP server error:", err?.stack || err);
  if (err?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[SHUTDOWN] Received ${signal}. Closing HTTP server...`);
  const forceExitTimer = setTimeout(() => {
    console.error("[SHUTDOWN] Force exit after timeout.");
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  httpServer.close(async (err) => {
    if (err) {
      console.error("[SHUTDOWN] Error while closing HTTP server:", err?.message || err);
    }
    await closePool();
    clearTimeout(forceExitTimer);
    process.exit(err ? 1 : 0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err?.stack || err);
});

async function startServer() {
  validateRequiredEnv();
  validateRuntimeUrls();
  await bootstrapDatabase();
  dbState.ready = true;
  dbState.lastError = null;
  dbState.lastCheckedAt = new Date().toISOString();

  await new Promise((resolve) => {
    httpServer.listen(PORT, HOST, resolve);
  });

  console.log("\n========================================");
  console.log("SERVER STARTED");
  console.log(`Bind: ${HOST}:${PORT}`);
  console.log(`API Base URL: ${getApiBaseUrl()}`);
  console.log(`Frontend URL: ${getFrontendUrl()}`);
  console.log(`Backend Public URL: ${getBackendPublicUrl()}`);
  console.log(`Google Callback URL: ${getGoogleCallbackUrl()}`);
  console.log(`Allowed Origins: ${getAllowedOriginsForLogs().join(", ")}`);
  console.log("========================================\n");
}

startServer().catch((err) => {
  dbState.ready = false;
  dbState.lastCheckedAt = new Date().toISOString();
  dbState.lastError = err?.message || String(err);
  console.error("Fatal startup error:", err?.stack || err);
  process.exit(1);
});
