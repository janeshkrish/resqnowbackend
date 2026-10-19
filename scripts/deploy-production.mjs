import "../loadEnv.js";
import { appendFile } from "node:fs/promises";
import { deployRenderProduction, preflightRenderProduction } from "./render-deployment.js";

if (process.argv.includes("--help")) {
  console.log("GitHub production deployment: checks Render configuration/DB access, deploys maintenance-only processes, drains old API/workers, runs verified TiDB transfer, then releases this commit.\nUse --check for a read-only preflight without changing services or migrating data.\nSee docs/github-tidb-deployment.md for required GitHub secrets and one-time Render configuration.");
} else {
  try {
    if (String(process.env.DEPLOY_PROVIDER || "railway").trim().toLowerCase() !== "render") {
      throw new Error("Production is hosted on Railway. Railway deploys through its connected GitHub repository; use docs/railway-tidb-deployment.md for a controlled TiDB cutover. The legacy Render adapter requires explicit DEPLOY_PROVIDER=render.");
    }
    if (process.argv.includes("--check")) {
      await preflightRenderProduction(process.env);
      console.log("[Deploy] Preflight passed: service configuration and database access checked; no services changed.");
    } else {
      await deployRenderProduction(process.env);
    }
  } catch (error) {
    console.error(`[Deploy] ${error.message}`);
    if (process.env.GITHUB_ACTIONS === "true") {
      // Only our diagnostic is emitted, never provider response bodies or env values.
      const message = String(error.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      console.error(`::error title=Production deployment blocked::${message}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY,
          `### Production deployment blocked\n\n${String(error.message).replace(/[\r\n]/g, " ")}\n\nSee docs/github-tidb-deployment.md and docs/production-login-recovery.md.\n`).catch(() => {});
      }
    }
    process.exitCode = 1;
  }
}
