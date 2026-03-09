import "../loadEnv.js";

import { validateEnvironmentOrThrow, logEnvironmentSummary } from "../config/envValidation.js";
import { closePool, getPool } from "../db.js";
import { startDispatchQueueWorker, stopDispatchQueueWorker } from "../services/dispatchQueueService.js";

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Dispatch Worker] Shutdown requested via ${signal}.`);
  await stopDispatchQueueWorker();
  await closePool();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[Dispatch Worker] Unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[Dispatch Worker] Uncaught exception:", error?.stack || error);
});

async function main() {
  validateEnvironmentOrThrow();
  logEnvironmentSummary();

  await getPool();
  const started = await startDispatchQueueWorker();
  if (!started) {
    throw new Error("Dispatch queue worker failed to start.");
  }

  console.log(`[Dispatch Worker] Running. pid=${process.pid}`);
}

main().catch(async (error) => {
  console.error("[Dispatch Worker] Fatal startup error:", error?.stack || error);
  await stopDispatchQueueWorker();
  await closePool();
  process.exit(1);
});
