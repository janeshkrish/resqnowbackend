import "../../loadEnv.js";
import { prepareDeploymentDatabase } from "./deploymentMigration.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("npm run db:migrate:deploy -- --maintenance\nStop all old API/worker/database writers first. Copies into a separate database, verifies data, and preserves the original.\nNormal API/worker startup runs this check automatically using DB_MIGRATION_* settings. See models/README.md.");
} else {
  try {
    if (args.some(arg => arg !== "--maintenance")) throw new Error("Unknown argument. Use --help.");
    const env = { ...process.env, ...(args.includes("--maintenance") ? { DB_MIGRATION_MAINTENANCE: "true" } : {}) };
    const result = await prepareDeploymentDatabase(env);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[DB migration] ${error.message}`);
    process.exitCode = 1;
  }
}
