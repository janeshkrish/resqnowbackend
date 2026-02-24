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
  getBackendPublicUrl,
  getFrontendUrl,
} from "./config/network.js";
import { socketService } from "./services/socket.js";
import { closePool } from "./db.js";

const app = express();
app.set("trust proxy", true);

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
    "FRONTEND_URL",
  ];

  const missing = required.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length > 0) {
    const msg = `Missing required environment variables: ${missing.join(", ")}`;
    if (isProductionLike()) {
      throw new Error(msg);
    }
    console.warn(`[ENV WARNING] ${msg}`);
  }
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

const httpServer = createServer(app);
socketService.init(httpServer);

const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path} origin=${req.get("origin") || "none"} ip=${req.ip}`
  );
  next();
});

app.use("/uploads", express.static(path.join(process.cwd(), "server", "uploads")));
app.use("/api/upload", uploadRouter);

app.use((req, _res, next) => {
  req.io = socketService.io;
  next();
});

// Mount routes
app.use("/api/technicians", techniciansRouter);
app.use("/api/technician", techniciansRouter);
app.use("/api/admin", adminRouter);
app.use("/api/users", usersRouter);
app.use("/api/auth", authRouter);
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
    backendPublicUrl: getBackendPublicUrl(),
    frontendUrl: getFrontendUrl(),
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

const PORT = Number(process.env.PORT || 3001);
const HOST = "0.0.0.0";

httpServer.on("error", (err) => {
  console.error("HTTP server error:", err?.message || err);
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

httpServer.listen(PORT, HOST, async () => {
  try {
    validateRequiredEnv();
    await bootstrapDatabase();
    dbState.ready = true;
    dbState.lastError = null;
    dbState.lastCheckedAt = new Date().toISOString();

    console.log("Database setup and migrations completed.");
  } catch (err) {
    dbState.ready = false;
    dbState.lastCheckedAt = new Date().toISOString();
    dbState.lastError = err?.message || String(err);
    console.error("DB init error:", err?.stack || err);

    if (isProductionLike()) {
      console.error("Fatal startup failure in production-like environment. Exiting.");
      process.exit(1);
    }
  }

  console.log("\n========================================");
  console.log("SERVER STARTED");
  console.log(`Bind: ${HOST}:${PORT}`);
  console.log(`Frontend URL: ${getFrontendUrl()}`);
  console.log(`Backend Public URL: ${getBackendPublicUrl()}`);
  console.log(`Allowed Origins: ${getAllowedOriginsForLogs().join(", ")}`);
  console.log("========================================\n");
});
