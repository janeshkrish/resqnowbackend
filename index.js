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

const app = express();
app.set("trust proxy", true);

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
  });
});

const PORT = Number(process.env.PORT || 3001);
const HOST = "0.0.0.0";

httpServer.listen(PORT, HOST, async () => {
  try {
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

    console.log("Database setup and migrations completed.");
  } catch (err) {
    console.error("DB init error:", err?.message || err);
  }

  console.log("\n========================================");
  console.log("SERVER STARTED");
  console.log(`Bind: ${HOST}:${PORT}`);
  console.log(`Frontend URL: ${getFrontendUrl()}`);
  console.log(`Backend Public URL: ${getBackendPublicUrl()}`);
  console.log(`Allowed Origins: ${getAllowedOriginsForLogs().join(", ")}`);
  console.log("========================================\n");
});
