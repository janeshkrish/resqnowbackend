import mysql from "mysql2/promise";
import { databaseConnectionOptions, migrationConfiguration, prepareDeploymentDatabase } from "../models/migrations/deploymentMigration.js";

export const MAINTENANCE_COMMAND = "node scripts/deployment-maintenance.mjs";
const RELEASE_SETTING = "RESQNOW_RELEASE_COMMAND";
const TERMINAL_FAILURES = new Set(["deactivated", "build_failed", "update_failed", "canceled", "pre_deploy_failed"]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const repositoryName = value => String(value || "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();

export function deploymentSettings(env) {
  const required = ["RENDER_API_KEY", "RENDER_SERVICE_IDS", "GITHUB_SHA", "GITHUB_REPOSITORY", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missing = required.filter(name => !String(env[name] || "").trim());
  if (missing.length) throw new Error(`Missing deployment settings: ${missing.join(", ")}. See docs/github-tidb-deployment.md.`);
  if (!/^[a-f0-9]{40}$/i.test(env.GITHUB_SHA)) throw new Error("GITHUB_SHA must be a complete commit SHA.");
  const serviceIds = [...new Set(env.RENDER_SERVICE_IDS.split(/[\s,]+/).filter(Boolean))];
  if (!serviceIds.length || serviceIds.some(id => !/^srv-[a-zA-Z0-9]+$/.test(id))) throw new Error("RENDER_SERVICE_IDS must list Render srv- IDs for every production API and worker.");
  if (env.DB_MIGRATION_MODE === "off") throw new Error("The production pipeline cannot disable database migration checks.");
  if (!["true", "1"].includes(env.DB_SSL)) throw new Error("TiDB Cloud deployment requires DB_SSL=true.");
  const migration = migrationConfiguration({ ...env, DB_MIGRATION_MODE: "auto" });
  return { serviceIds, migration, commit: env.GITHUB_SHA, repository: repositoryName(env.GITHUB_REPOSITORY), branch: "main" };
}

export function createRenderClient(apiKey, { fetchImpl = fetch, sleep = pause } = {}) {
  return async function request(path, { method = "GET", body, allowMissing = false } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetchImpl(`https://api.render.com/v1${path}`, {
        method, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
      });
      if (response.status === 404 && allowMissing) return null;
      // Retry only explicit rate-limit rejections. A failed network response to
      // POST /deploys is ambiguous and must not silently create duplicate deploys.
      if (response.status === 429 && attempt < 4) {
        await sleep(Math.min(60000, Math.max(1000, Number(response.headers.get("Retry-After") || 10) * 1000)));
        continue;
      }
      if (!response.ok) throw new Error(`Render ${method} ${path} failed (HTTP ${response.status}); check the Render dashboard. Response bodies are withheld to protect environment values.`);
      if (response.status === 204) return null;
      const content = await response.text();
      return content ? JSON.parse(content) : null;
    }
  };
}

export async function probeDeploymentDatabase(env, { connect = options => mysql.createConnection(options) } = {}) {
  const config = migrationConfiguration(env);
  const connection = await connect(databaseConnectionOptions(env));
  try {
    const [rows] = await connection.query("SELECT table_comment AS table_comment FROM information_schema.tables WHERE table_schema = ? AND table_name = 'users'", [config.target]);
    const active = rows.some(row => row.table_comment === `${config.marker}:ready`) ? config.target : config.source;
    // USE fails if a first-time source name is wrong. Never deploy an accidental
    // empty installation over a production service. After cutover a completed
    // target can still be used even if its retained legacy source was retired.
    await connection.query(`USE \`${active}\``);
    await connection.query("SELECT 1");
  } finally { await connection.end(); }
}

export async function preflightRenderProduction(env, {
  request, probe = probeDeploymentDatabase, fetchImpl = fetch, sleep = pause,
} = {}) {
  const settings = deploymentSettings(env);
  request ||= createRenderClient(env.RENDER_API_KEY, { fetchImpl, sleep });
  const serviceSnapshots = [];
  for (const id of settings.serviceIds) {
    const service = await request(`/services/${id}`);
    if (!["web_service", "background_worker"].includes(service.type)) throw new Error(`Unsupported writer type for ${id}; this pipeline supports Render web services and background workers only.`);
    if (service.suspended !== "not_suspended") throw new Error(`${id} is suspended. Resume the API/worker in the Render dashboard before rerunning this workflow; suspended services cannot serve login requests.`);
    if (service.autoDeploy !== "no") throw new Error(`Disable Render Auto-Deploy for ${id} before using this pipeline, so it cannot race the database transfer.`);
    if (repositoryName(service.repo) !== settings.repository || service.branch !== settings.branch) throw new Error(`${id} must use this repository's main branch.`);
    const details = service.serviceDetails;
    const runtime = details?.runtime || details?.env;
    if (!["node", "docker"].includes(runtime)) throw new Error(`Unsupported Render runtime for ${id}.`);
    if (details.preDeployCommand || details.envSpecificDetails?.preDeployCommand) throw new Error(`Remove the separate pre-deploy command from ${id}; migration is owned by this workflow.`);
    const commandKey = runtime === "docker" ? "dockerCommand" : "startCommand";
    const currentCommand = details.envSpecificDetails?.[commandKey] || "";
    const saved = await request(`/services/${id}/env-vars/${RELEASE_SETTING}`, { allowMissing: true });
    let releaseCommand = currentCommand;
    if (currentCommand === MAINTENANCE_COMMAND) {
      let checkpoint;
      try { checkpoint = JSON.parse(saved?.value || ""); } catch { /* diagnostic below */ }
      if (checkpoint?.key !== commandKey || typeof checkpoint.command !== "string" || checkpoint.command === MAINTENANCE_COMMAND) throw new Error(`Missing release-command checkpoint for ${id}; configure its original start command before retrying.`);
      releaseCommand = checkpoint.command;
    }
    if (runtime === "node" && !releaseCommand) throw new Error(`Missing application start command for ${id}.`);
    serviceSnapshots.push({ id, type: service.type, commandKey, releaseCommand,
      shutdownSeconds: Number(details.maxShutdownDelaySeconds || 30), url: details.url?.replace(/\/$/, "") });
    const deploys = await request(`/services/${id}/deploys?limit=20`);
    if ((deploys || []).some(item => !["live", ...TERMINAL_FAILURES].includes((item.deploy || item).status))) throw new Error(`${id} already has an in-progress deploy. Wait for it to finish before rerunning this workflow.`);
  }
  const api = serviceSnapshots.filter(service => service.type === "web_service");
  if (api.length !== 1 || !api[0].url) throw new Error("RENDER_SERVICE_IDS must include exactly one API web service and all its background workers.");
  const apiService = api[0];
  // Check credentials BEFORE taking any service offline. The transfer itself
  // repeats all schema/data checks after writers have been drained.
  await probe(env);

  return { settings, serviceSnapshots, apiService, request };
}

export async function deployRenderProduction(env, {
  request, migrate = prepareDeploymentDatabase, probe = probeDeploymentDatabase,
  fetchImpl = fetch, sleep = pause, log = console.log, pollLimit = 360,
} = {}) {
  const preflight = await preflightRenderProduction(env, { request, probe, fetchImpl, sleep });
  const { settings, serviceSnapshots, apiService } = preflight;
  request = preflight.request;
  const putVariable = (id, key, value) => request(`/services/${id}/env-vars/${key}`, { method: "PUT", body: { value: String(value) } });

  const patchCommand = (service, command, healthPath) => request(`/services/${service.id}`, {
    method: "PATCH", body: { serviceDetails: {
      envSpecificDetails: { [service.commandKey]: command },
      ...(service.type === "web_service" ? { healthCheckPath: healthPath } : {}),
    } },
  });
  const waitForDeploy = async (service, id) => {
    for (let poll = 0; poll < pollLimit; poll++) {
      const result = await request(`/services/${service.id}/deploys/${id}`);
      if (TERMINAL_FAILURES.has(result.status)) throw new Error(`Render deploy ${id} for ${service.id} ended as ${result.status}.`);
      if (result.status === "live") {
        if (result.commit?.id !== settings.commit) throw new Error(`Render deployed a different commit for ${service.id}; refusing database migration/release.`);
        return;
      }
      await sleep(10000);
    }
    throw new Error(`Timed out waiting for Render deploy ${id}.`);
  };
  const deploy = async service => {
    const created = await request(`/services/${service.id}/deploys`, { method: "POST", body: { commitId: settings.commit, clearCache: "do_not_clear" } });
    if (!created?.id) throw new Error(`Render did not return a deployment ID for ${service.id}; inspect its dashboard before retrying.`);
    await waitForDeploy(service, created.id);
  };
  const waitForApi = async maintenance => {
    for (let poll = 0; poll < 60; poll++) {
      try {
        const response = await fetchImpl(`${apiService.url}${maintenance ? "/health" : "/ready"}`, { signal: AbortSignal.timeout(15000), cache: "no-store" });
        const status = await response.json();
        if (response.ok && (maintenance ? status.maintenance === true && status.revision === settings.commit : status.ok === true && status.database?.ready === true && !status.maintenance)) return;
      } catch { /* service may still be starting */ }
      await sleep(5000);
    }
    throw new Error(`API did not reach ${maintenance ? "maintenance" : "database-ready"} state.`);
  };

  try {
    for (const service of serviceSnapshots) {
      // Durable retry state on the service, never a customer-data artifact.
      await putVariable(service.id, RELEASE_SETTING, JSON.stringify({ key: service.commandKey, command: service.releaseCommand }));
      await patchCommand(service, MAINTENANCE_COMMAND, "/health");
      await deploy(service);
      log(`[Deploy] ${service.id}: maintenance process is live`);
    }
    await waitForApi(true);
    // Render retains the previous instance for 60 seconds before SIGTERM,
    // followed by its configured shutdown allowance. Wait for ALL old writers.
    const drainMs = (60 + Math.max(...serviceSnapshots.map(service => service.shutdownSeconds)) + 10) * 1000;
    log(`[Deploy] draining old instances for ${drainMs / 1000} seconds`);
    await sleep(drainMs);
    const result = await migrate({ ...env, DB_MIGRATION_MODE: "auto", DB_MIGRATION_MAINTENANCE: "true" });
    if (!result.database) throw new Error("Migration did not select an application database.");
    log(`[Deploy] verified database selected: ${result.database}`);

    for (const service of serviceSnapshots) {
      for (const key of ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_SSL", "DB_SSL_STRICT"]) {
        await putVariable(service.id, key, env[key] ?? (key === "DB_SSL_STRICT" ? "true" : ""));
      }
      await putVariable(service.id, "DB_LEGACY_NAME", env.DB_LEGACY_NAME || "");
      await putVariable(service.id, "DB_MIGRATION_TARGET", settings.migration.target);
      await putVariable(service.id, "DB_MIGRATION_MODE", "auto");
      await putVariable(service.id, "DB_MIGRATION_MAINTENANCE", "false");
    }
    // Start the API first so bootstrap/schema alignment completes before workers.
    await patchCommand(apiService, apiService.releaseCommand, "/ready");
    await deploy(apiService);
    await waitForApi(false);
    for (const service of serviceSnapshots.filter(service => service.type === "background_worker")) {
      await patchCommand(service, service.releaseCommand, "");
      await deploy(service);
    }
    log(`[Deploy] commit ${settings.commit}: API and workers released`);
    return result;
  } catch (error) {
    // Never restore an old application automatically against a partially
    // migrated database. A subsequent run resumes from saved start commands.
    log("[Deploy] failed. Services already in maintenance remain there until a successful rerun. Do not point an old application at the migrated database.");
    throw error;
  }
}
