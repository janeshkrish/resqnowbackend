import test from "node:test";
import assert from "node:assert/strict";
import { checkProductionLogin } from "../scripts/production-login-check.mjs";

const config = { backendUrl: "https://api.example.test", frontendUrl: "https://resqnow.org", firebaseApiKey: "fixture-web-key", firebaseProjectId: "fixture-project" };
const response = (status, value) => ({ ok: status === 200, status, json: async () => value, text: async () => typeof value === "string" ? value : JSON.stringify(value) });
const ready = { ok: true, database: { ready: true } };

test("reports suspended API and uninitialized Firebase without sending SMS or leaking the key", async () => {
  const urls = [];
  const checks = await checkProductionLogin(config, { fetchImpl: async url => {
    urls.push(String(url));
    return String(url).endsWith("/ready") ? response(503, "This service has been suspended by its owner.")
      : response(400, { error: { message: "CONFIGURATION_NOT_FOUND" } });
  } });
  assert.equal(checks.filter(check => !check.ok).length, 3);
  assert.match(checks[0].message, /Resume it/);
  assert.match(checks[1].message, /CONFIGURATION_NOT_FOUND/);
  assert.ok(urls.every(url => /\/ready$|\/v1\/(projects|recaptchaParams)\?/.test(url)));
  assert.ok(!JSON.stringify(checks).includes(config.firebaseApiKey));
});

test("requires a ready database, matching project, authorized production domain and reCAPTCHA config", async () => {
  const checks = await checkProductionLogin(config, { fetchImpl: async url => {
    if (String(url).endsWith("/ready")) return response(200, ready);
    if (String(url).includes("/projects?")) return response(200, { projectId: config.firebaseProjectId, authorizedDomains: ["resqnow.org"] });
    return response(200, { recaptchaSiteKey: "fixture-site" });
  } });
  assert.ok(checks.every(check => check.ok));
  assert.deepEqual(checks.map(check => check.name), ["api", "project", "domain", "recaptcha"]);
});

test("flags wrong project and unauthorized www domain independently", async () => {
  const checks = await checkProductionLogin({ ...config, frontendUrl: "https://www.resqnow.org" }, { fetchImpl: async url => {
    if (String(url).endsWith("/ready")) return response(200, ready);
    if (String(url).includes("/projects?")) return response(200, { projectId: "other-project", authorizedDomains: ["resqnow.org"] });
    return response(200, {});
  } });
  assert.deepEqual(checks.filter(check => !check.ok).map(check => check.name), ["project", "domain", "recaptcha"]);
  assert.match(checks.find(check => check.name === "domain").message, /www.resqnow.org/);
});

test("accepts Identity Toolkit's numeric project number only when it matches configured Firebase settings", async () => {
  const fetchImpl = async url => String(url).endsWith("/ready") ? response(200, ready)
    : String(url).includes("/projects?") ? response(200, { projectId: "123456789", authorizedDomains: ["resqnow.org"] })
    : response(200, { recaptchaSiteKey: "fixture-site" });
  const matched = await checkProductionLogin({ ...config, firebaseProjectNumber: "123456789" }, { fetchImpl });
  assert.equal(matched.find(check => check.name === "project").ok, true);
  const mismatched = await checkProductionLogin({ ...config, firebaseProjectNumber: "999999999" }, { fetchImpl });
  assert.equal(mismatched.find(check => check.name === "project").ok, false);
});

test("handles unavailable network and missing Firebase settings without exposing provider errors", async () => {
  const checks = await checkProductionLogin({ ...config, firebaseApiKey: "" }, { fetchImpl: async () => { throw new Error("private diagnostic"); } });
  assert.equal(checks.length, 2);
  assert.ok(checks.every(check => !check.ok));
  assert.ok(!JSON.stringify(checks).includes("private diagnostic"));
});

test("rejects non-HTTPS and embedded credential URLs before requests", async () => {
  for (const backendUrl of ["http://api.example.test", "https://user:secret@api.example.test"]) {
    const checks = await checkProductionLogin({ ...config, backendUrl }, { fetchImpl: () => assert.fail("unexpected request") });
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].name, "urls");
  }
});
