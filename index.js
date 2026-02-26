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
import paymentsRouter, { razorpayWebhookHandler } from "./routes/payments.js";
import chatbotRouter from "./routes/chatbot.js";

import {
  getApiBaseUrl,
  getBackendPublicUrl,
  getAllowedOriginsForLogs,
  buildCorsOptions,
  getFrontendUrl,
  getGoogleCallbackUrl,
} from "./config/network.js";
import { validateEnvironmentOrThrow, logEnvironmentSummary } from "./config/envValidation.js";
import { socketService } from "./services/socket.js";
import { verifyMailerConnection } from "./services/mailer.js";
import { closePool } from "./db.js";

const PORT = Number(process.env.PORT || 3001);
const HOST = "0.0.0.0";

const dbState = {
  ready: false,
  lastCheckedAt: null,
  lastError: null,
};

async function bootstrapDatabase() {
  const {
    ensureTechniciansTable,
    ensureUsersTable,
    ensureOtpRequestsTable,
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
    ensureOtpRequestsTable(),
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

  const corsOptions = buildCorsOptions();
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));

  // Razorpay webhook must receive the untouched raw body for signature verification.
  app.post("/api/payments/razorpay/webhook", express.raw({ type: "application/json" }), razorpayWebhookHandler);

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
  // explicit early guard for email configuration to produce an immediate
  // and clear error in Render logs if missing.
  if (!String(process.env.EMAIL_USER || "").trim() || !String(process.env.EMAIL_PASS || "").trim()) {
    console.error("Missing email environment variables: EMAIL_USER or EMAIL_PASS");
    // exit so deployment platform shows a failing startup rather than intermittent 503s
    process.exit(1);
  }

  validateEnvironmentOrThrow();
  logEnvironmentSummary();

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

  // Mail connectivity should not block API startup on Render; log and continue if SMTP is unreachable.
  void verifyMailerConnection().then((mailerReady) => {
    if (!mailerReady) {
      console.error("[Mailer] Connectivity check failed after startup. API is running, but email sending may fail.");
    }
  });
}

startServer().catch((err) => {
  dbState.ready = false;
  dbState.lastCheckedAt = new Date().toISOString();
  dbState.lastError = err?.message || String(err);
  console.error("Fatal startup error:", err?.stack || err);
  process.exit(1);
});
