import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRenderClient, deployRenderProduction, deploymentSettings, probeDeploymentDatabase, MAINTENANCE_COMMAND } from "../scripts/render-deployment.js";
import { migrationConfiguration } from "../models/migrations/deploymentMigration.js";

const SHA = "a".repeat(40);
const env = { RENDER_API_KEY: "simulated-key", RENDER_SERVICE_IDS: "srv-api,srv-worker", GITHUB_SHA: SHA,
  GITHUB_REPOSITORY: "janeshkrish/resqnowbackend", DB_HOST: "database.invalid", DB_PORT: "4000", DB_USER: "fixture",
  DB_PASSWORD: "simulated-secret", DB_NAME: "legacy", DB_SSL: "true", DB_SSL_STRICT: "true" };

function platform() {
  const events = [];
  const services = new Map(["srv-api", "srv-worker"].map(id => [id, {
    id, type: id === "srv-api" ? "web_service" : "background_worker", repo: "https://github.com/janeshkrish/resqnowbackend.git",
    branch: "main", autoDeploy: "no", suspended: "not_suspended", serviceDetails: { runtime: "node", maxShutdownDelaySeconds: 30,
      url: id === "srv-api" ? "https://api.invalid/" : undefined,
      envSpecificDetails: { startCommand: id === "srv-api" ? "npm start" : "npm run worker:dispatch" } },
  }]));
  const variables = new Map([...services.keys()].map(id => [id, new Map([["UNRELATED_SETTING", "keep-me"]])]));
  const deployments = new Map();
  const commandOf = service => service.serviceDetails.envSpecificDetails[service.serviceDetails.runtime === "docker" ? "dockerCommand" : "startCommand"];
  const state = { failMigration: false, failMaintenance: null, wrongCommit: false, probeFails: false, failRelease: false, migrationCalls: 0, apiReady: true };
  const request = async (path, { method = "GET", body } = {}) => {
    events.push({ path, method, body });
    const match = path.match(/^\/services\/(srv-[\w]+)(?:\/([^/?]+))?(?:\/([^/?]+))?/);
    const serviceId = match?.[1];
    const kind = match?.[2];
    const key = match?.[3];
    const service = services.get(serviceId);
    assert.ok(service, path);
    if (!kind && method === "GET") return structuredClone(service);
    if (!kind && method === "PATCH") {
      const details = body.serviceDetails;
      Object.assign(service.serviceDetails.envSpecificDetails, details.envSpecificDetails);
      if (details.healthCheckPath) service.serviceDetails.healthCheckPath = details.healthCheckPath;
      return structuredClone(service);
    }
    if (kind === "env-vars" && method === "GET") return variables.get(serviceId).has(key) ? { key, value: variables.get(serviceId).get(key) } : null;
    if (kind === "env-vars" && method === "PUT") { variables.get(serviceId).set(key, body.value); return { key, value: body.value }; }
    if (kind === "deploys" && !key && method === "GET") return [...deployments.values()].filter(deploy => deploy.serviceId === serviceId).map(deploy => ({ deploy }));
    if (kind === "deploys" && method === "POST") {
      const maintenance = commandOf(service) === MAINTENANCE_COMMAND;
      const deploy = { id: `dep-${deployments.size + 1}`, serviceId, maintenance,
        status: maintenance && state.failMaintenance === serviceId || !maintenance && state.failRelease ? "build_failed" : "live",
        commit: { id: state.wrongCommit ? "b".repeat(40) : body.commitId } };
      deployments.set(deploy.id, deploy);
      return deploy;
    }
    if (kind === "deploys" && key && method === "GET") return deployments.get(key);
    throw new Error(`Unexpected platform operation ${method} ${path}`);
  };
  const sleep = async ms => { events.push({ sleep: ms }); };
  const probe = async () => { events.push({ probe: true }); if (state.probeFails) throw new Error("access denied"); };
  const migrate = async options => {
    events.push({ migration: true, options });
    state.migrationCalls++;
    assert.ok([...services.values()].every(service => commandOf(service) === MAINTENANCE_COMMAND));
    assert.equal(events.at(-2).sleep, 100000, "old instances must drain before copying");
    if (state.failMigration) throw new Error("simulated migration failure");
    return { database: "legacy_relational_v2", migrated: true };
  };
  const fetchImpl = async url => {
    events.push({ url });
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ maintenance: true, revision: SHA }) };
    assert.ok(![...services.values()].filter(service => service.type === "web_service").some(service => commandOf(service) === MAINTENANCE_COMMAND));
    return { ok: state.apiReady, json: async () => ({ ok: state.apiReady, database: { ready: state.apiReady } }) };
  };
  const options = { request, sleep, probe, migrate, fetchImpl, log() {}, pollLimit: 2 };
  return { events, services, variables, deployments, state, options };
}

test("production settings fail before network access when required credentials or IDs are missing", async () => {
  assert.throws(() => deploymentSettings({}), /Missing deployment settings/);
  assert.throws(() => deploymentSettings({ ...env, RENDER_SERVICE_IDS: "arbitrary/url" }), /srv-/);
  assert.throws(() => deploymentSettings({ ...env, DB_SSL: "false" }), /DB_SSL/);
  assert.throws(() => deploymentSettings({ ...env, DB_MIGRATION_MODE: "off" }), /cannot disable/);
  assert.throws(() => deploymentSettings({ ...env, GITHUB_SHA: "main" }), /complete commit/);
});

test("push deployment drains API/workers, migrates, aligns credentials and releases the exact commit", async () => {
  const p = platform();
  const result = await deployRenderProduction(env, p.options);
  assert.equal(result.database, "legacy_relational_v2");
  assert.equal(p.state.migrationCalls, 1);
  assert.equal(p.deployments.size, 4);
  assert.ok([...p.deployments.values()].every(deploy => deploy.commit.id === SHA));
  assert.deepEqual([...p.deployments.values()].map(deploy => [deploy.serviceId, deploy.maintenance]), [
    ["srv-api", true], ["srv-worker", true], ["srv-api", false], ["srv-worker", false],
  ]);
  assert.ok(p.events.findIndex(event => event.probe) < p.events.findIndex(event => event.method === "PATCH"));
  const migrationIndex = p.events.findIndex(event => event.migration);
  const readinessIndex = p.events.findIndex(event => event.url?.endsWith("/ready"));
  const workerReleaseIndex = p.events.findIndex((event, index) => index > migrationIndex && event.path === "/services/srv-worker" && event.body?.serviceDetails?.envSpecificDetails?.startCommand === "npm run worker:dispatch");
  assert.ok(readinessIndex > migrationIndex && workerReleaseIndex > readinessIndex);
  for (const vars of p.variables.values()) {
    assert.equal(vars.get("DB_PASSWORD"), env.DB_PASSWORD);
    assert.equal(vars.get("DB_MIGRATION_TARGET"), "legacy_relational_v2");
    assert.equal(vars.get("DB_MIGRATION_MAINTENANCE"), "false");
    assert.equal(vars.get("UNRELATED_SETTING"), "keep-me");
  }
  assert.equal(p.services.get("srv-api").serviceDetails.healthCheckPath, "/ready");
});

test("bad database credentials stop before changing any running service", async () => {
  const p = platform(); p.state.probeFails = true;
  await assert.rejects(deployRenderProduction(env, p.options), /access denied/);
  assert.equal(p.state.migrationCalls, 0);
  assert.ok(p.events.every(event => !event.method || event.method === "GET"));
});

test("Render native auto-deploy must be disabled before this workflow can take control", async () => {
  const p = platform(); p.services.get("srv-api").autoDeploy = "yes";
  await assert.rejects(deployRenderProduction(env, p.options), /Disable Render Auto-Deploy/);
  assert.equal(p.state.migrationCalls, 0);
  assert.ok(p.events.every(event => event.method === "GET"));
});

test("failed maintenance rollout or wrong commit prevents migration", async () => {
  for (const mode of ["failMaintenance", "wrongCommit"]) {
    const p = platform(); p.state[mode] = mode === "failMaintenance" ? "srv-worker" : true;
    await assert.rejects(deployRenderProduction(env, p.options), /build_failed|different commit/);
    assert.equal(p.state.migrationCalls, 0);
  }
});

test("failed migration leaves maintenance commands active and a later run recovers saved release commands", async () => {
  const p = platform(); p.state.failMigration = true;
  await assert.rejects(deployRenderProduction(env, p.options), /simulated migration failure/);
  assert.ok([...p.services.values()].every(service => service.serviceDetails.envSpecificDetails.startCommand === MAINTENANCE_COMMAND));
  assert.ok([...p.variables.values()].every(vars => JSON.parse(vars.get("RESQNOW_RELEASE_COMMAND")).command !== MAINTENANCE_COMMAND));
  p.state.failMigration = false;
  await deployRenderProduction(env, p.options);
  assert.equal(p.services.get("srv-api").serviceDetails.envSpecificDetails.startCommand, "npm start");
  assert.equal(p.services.get("srv-worker").serviceDetails.envSpecificDetails.startCommand, "npm run worker:dispatch");
});

test("worker release waits for API database readiness", async () => {
  const p = platform(); p.state.apiReady = false;
  await assert.rejects(deployRenderProduction(env, p.options), /database-ready/);
  assert.equal(p.services.get("srv-worker").serviceDetails.envSpecificDetails.startCommand, MAINTENANCE_COMMAND);
});

test("an unfinished Render deployment blocks a competing migration", async () => {
  const p = platform();
  p.deployments.set("dep-other", { id: "dep-other", serviceId: "srv-api", status: "update_in_progress" });
  await assert.rejects(deployRenderProduction(env, p.options), /in-progress deploy/);
  assert.equal(p.state.migrationCalls, 0);
  assert.ok(p.events.every(event => event.method === "GET"));
});

test("unsupported writer types and hooks are refused before service mutations", async () => {
  for (const change of [service => { service.type = "cron_job"; }, service => { service.serviceDetails.preDeployCommand = "npm run old-migrate"; }]) {
    const p = platform(); change(p.services.get("srv-worker"));
    await assert.rejects(deployRenderProduction(env, p.options), /Unsupported writer|pre-deploy/);
    assert.equal(p.state.migrationCalls, 0);
    assert.ok(p.events.every(event => event.method === "GET"));
  }
});

test("API client retries explicit rate limiting and never prints secret response bodies", async () => {
  const calls = [];
  const sleeps = [];
  const request = createRenderClient("test-key", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? { status: 429, headers: { get: () => "1" } }
        : { ok: true, status: 200, text: async () => '{"id":"srv-api"}' };
    }, sleep: async ms => sleeps.push(ms),
  });
  assert.deepEqual(await request("/services/srv-api"), { id: "srv-api" });
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(sleeps, [1000]);
  const rejected = createRenderClient("key", { fetchImpl: async () => ({ ok: false, status: 403, text: async () => "private-password" }) });
  await assert.rejects(rejected("/services/srv-api"), error => error.message.includes("403") && !error.message.includes("private-password"));
});

test("database preflight checks the existing source or the already active target without creating a database", async () => {
  for (const ready of [false, true]) {
    const calls = [];
    let ended = false;
    await probeDeploymentDatabase(env, { connect: async () => ({
      query: async sql => {
        calls.push(sql);
        return /information_schema/.test(sql) ? [ready ? [{ table_comment: `${migrationConfiguration(env).marker}:ready` }] : []] : [[{ ok: 1 }]];
      }, end: async () => { ended = true; },
    }) });
    assert.ok(calls.includes(`USE \`${ready ? "legacy_relational_v2" : "legacy"}\``));
    assert.ok(calls.every(sql => /^(SELECT|USE)/.test(sql)));
    assert.equal(ended, true);
  }
});

test("Docker services restore their command overrides, including an empty override for the image default", async () => {
  const p = platform();
  for (const service of p.services.values()) {
    service.serviceDetails.runtime = "docker";
    service.serviceDetails.envSpecificDetails = { dockerCommand: service.type === "web_service" ? "" : "npm run worker:dispatch" };
  }
  await deployRenderProduction(env, p.options);
  assert.equal(p.services.get("srv-api").serviceDetails.envSpecificDetails.dockerCommand, "");
  assert.equal(p.services.get("srv-worker").serviceDetails.envSpecificDetails.dockerCommand, "npm run worker:dispatch");
});

test("real maintenance process serves probes and rejects application traffic without application initialization", async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ["scripts/deployment-maintenance.mjs"], {
    env: { ...process.env, PORT: String(port), RENDER_GIT_COMMIT: SHA, DB_HOST: "unreachable.invalid" }, stdio: "ignore",
  });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode == null) child.kill(); await exited; });
  let response;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { response = await fetch(`http://127.0.0.1:${port}/health`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(response, "maintenance server started");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, SHA);
  for (const path of ["/api/users", "/api/payments/razorpay/webhook", "/uploads/file.pdf"]) {
    const result = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("Retry-After"), "30");
    assert.equal((await result.json()).maintenance, true);
  }
});
