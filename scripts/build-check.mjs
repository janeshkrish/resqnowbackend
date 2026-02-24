import fs from "fs/promises";
import path from "path";
import { spawnSync } from "child_process";

const rootDir = process.cwd();
const ignoreDirs = new Set([".git", "node_modules"]);
const targetExt = new Set([".js", ".mjs"]);

async function collectJsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      files.push(...(await collectJsFiles(fullPath)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!targetExt.has(path.extname(entry.name))) continue;
    files.push(fullPath);
  }

  return files;
}

async function main() {
  const files = await collectJsFiles(rootDir);
  const failures = [];

  for (const filePath of files) {
    const result = spawnSync(process.execPath, ["--check", filePath], {
      cwd: rootDir,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      failures.push({
        file: path.relative(rootDir, filePath),
        stderr: result.stderr?.trim() || "Unknown syntax check failure",
      });
    }
  }

  if (failures.length > 0) {
    console.error(`[build-check] Syntax failures: ${failures.length}`);
    failures.forEach((failure, index) => {
      console.error(`\n[${index + 1}] ${failure.file}\n${failure.stderr}`);
    });
    process.exit(1);
  }

  console.log(`[build-check] OK - ${files.length} files passed syntax check.`);
}

main().catch((err) => {
  console.error("[build-check] Failed:", err?.stack || err);
  process.exit(1);
});
