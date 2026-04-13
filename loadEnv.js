import "dotenv/config";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const candidateEnvPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, ".env"),
  path.resolve(__dirname, "..", ".env"),
];

for (const envPath of candidateEnvPaths) {
  if (!fs.existsSync(envPath)) continue;
  dotenv.config({ path: envPath });
  break;
}

console.log("[ENV] SMTP host:", process.env.SMTP_HOST || "missing");
console.log("[ENV] SMTP port:", process.env.SMTP_PORT || "missing");
console.log("[ENV] Email user set:", Boolean(String(process.env.EMAIL_USER || "").trim()));
console.log("[ENV] Email from:", process.env.EMAIL_FROM || "not set");
