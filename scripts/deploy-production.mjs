import "../loadEnv.js";
import { deployRenderProduction } from "./render-deployment.js";

if (process.argv.includes("--help")) {
  console.log("GitHub production deployment: checks Render configuration/DB access, deploys maintenance-only processes, drains old API/workers, runs verified TiDB transfer, then releases this commit.\nSee docs/github-tidb-deployment.md for required GitHub secrets and one-time Render configuration.");
} else {
  try {
    await deployRenderProduction(process.env);
  } catch (error) {
    console.error(`[Deploy] ${error.message}`);
    process.exitCode = 1;
  }
}
