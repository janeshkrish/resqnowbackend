import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const files = [];
for (const directory of ["tests", "services"]) {
  for (const name of await fs.readdir(directory)) {
    if (name.endsWith(".test.js")) files.push(path.join(directory, name));
  }
}
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files.sort()], {
  stdio: "inherit", env: { ...process.env, NODE_ENV: "test", DB_MIGRATION_MODE: "off" },
});
process.exit(result.status ?? 1);
