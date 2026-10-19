import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Read-only: no SMS, credentials exchange, database access or configuration writes.
export async function checkProductionLogin({ backendUrl, frontendUrl, firebaseApiKey, firebaseProjectId, firebaseProjectNumber }, { fetchImpl = fetch } = {}) {
  const checks = [];
  const add = (name, ok, message) => checks.push({ name, ok, message });
  let backend;
  let frontend;
  try {
    backend = new URL(backendUrl);
    frontend = new URL(frontendUrl);
    if ([backend, frontend].some(url => url.protocol !== "https:" || url.username || url.password)) throw new Error();
  } catch {
    add("urls", false, "Set HTTPS BACKEND_PUBLIC_URL and FRONTEND_URL without embedded credentials.");
    return checks;
  }
  try {
    const response = await fetchImpl(new URL("/ready", backend), { signal: AbortSignal.timeout(20000), cache: "no-store" });
    const text = await response.text();
    let status;
    try { status = JSON.parse(text); } catch { /* Render can return an HTML suspension page. */ }
    const ready = response.ok && status?.ok === true && status?.database?.ready === true && !status?.maintenance;
    add("api", ready, ready ? "API database is ready." : /service has been suspended/i.test(text)
      ? "Render service is suspended. Resume it in Render before deploying or testing login."
      : `API is not database-ready (HTTP ${response.status}). Check startup logs and complete the maintenance migration workflow.`);
  } catch {
    add("api", false, "API readiness request failed. Check the backend URL, network and hosting service status.");
  }
  if (!String(firebaseApiKey || "").trim() || !String(firebaseProjectId || "").trim()) {
    add("firebase", false, "Provide FIREBASE_WEB_API_KEY and FIREBASE_PROJECT_ID, or --frontend-env with the VITE_FIREBASE_* settings.");
    return checks;
  }
  for (const endpoint of ["projects", "recaptchaParams"]) {
    try {
      const url = new URL(`https://identitytoolkit.googleapis.com/v1/${endpoint}`);
      url.searchParams.set("key", firebaseApiKey);
      const response = await fetchImpl(url, { headers: { Origin: frontend.origin, Referer: `${frontend.origin}/` }, signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!response.ok) {
        const missing = data.error?.message === "CONFIGURATION_NOT_FOUND";
        add(endpoint, false, missing
          ? "Firebase Authentication is not initialized for the web API key's project (CONFIGURATION_NOT_FOUND). Open Firebase Authentication, Get started, and configure Phone sign-in."
          : `Firebase ${endpoint} check failed (HTTP ${response.status}). Check the web API key, API restrictions and Authentication setup.`);
        continue;
      }
      if (endpoint === "projects") {
        // Identity Toolkit can return the numeric Google Cloud project number.
        // Firebase's messagingSenderId is that same number, even for Auth-only checks.
        const projectMatches = !data.projectId || String(data.projectId) === firebaseProjectId ||
          Boolean(firebaseProjectNumber && String(data.projectId) === String(firebaseProjectNumber));
        const domainAllowed = (data.authorizedDomains || []).includes(frontend.hostname);
        add("project", projectMatches, projectMatches ? "Firebase project matches." : "Web API key and FIREBASE_PROJECT_ID belong to different projects.");
        add("domain", domainAllowed, domainAllowed ? "Frontend domain is authorized." : `Add ${frontend.hostname} to Firebase Authentication > Settings > Authorized domains.`);
      } else {
        add("recaptcha", Boolean(data.recaptchaSiteKey), data.recaptchaSiteKey ? "Firebase reCAPTCHA configuration is available." : "Firebase did not return a reCAPTCHA site key. Check Authentication setup.");
      }
    } catch {
      add(endpoint, false, `Firebase ${endpoint} request failed. Check network access and retry.`);
    }
  }
  return checks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dotenv.config();
  const frontFlag = process.argv.indexOf("--frontend-env");
  let front = {};
  if (frontFlag !== -1) {
    const file = process.argv[frontFlag + 1];
    if (!file || file.startsWith("--")) throw new Error("--frontend-env requires a file path.");
    const loaded = dotenv.config({ path: file, processEnv: {} });
    if (loaded.error) throw new Error("Cannot read --frontend-env file.");
    front = loaded.parsed;
  }
  const checks = await checkProductionLogin({
    backendUrl: process.env.BACKEND_PUBLIC_URL || process.env.BACKEND_URL || front.VITE_API_URL,
    frontendUrl: process.env.FRONTEND_PUBLIC_URL || process.env.FRONTEND_URL,
    firebaseApiKey: process.env.FIREBASE_WEB_API_KEY || front.VITE_FIREBASE_API_KEY,
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID || front.VITE_FIREBASE_PROJECT_ID,
    firebaseProjectNumber: process.env.FIREBASE_PROJECT_NUMBER || front.VITE_FIREBASE_MESSAGING_SENDER_ID,
  });
  for (const check of checks) console.log(`[${check.ok ? "PASS" : "FAIL"}] ${check.name}: ${check.message}`);
  console.log("This check does not send SMS or certify delivery. Also verify Phone provider, billing, India SMS region policy, matching server credentials, and a real OTP login after deployment.");
  process.exitCode = checks.every(check => check.ok) ? 0 : 1;
}
