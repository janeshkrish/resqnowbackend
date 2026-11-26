import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createLoginThrottle, createMemoryThrottleStore } from "../services/loginThrottle.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-signing-secret-for-login-throttle";

const LIMITS = { windowSeconds: 900, accountAttempts: 3, otpAttempts: 2, ipFailures: 5 };

// Simulates Railway: the platform proxy appends the real client IP as the last
// X-Forwarded-For entry, and trust proxy = 1 makes that entry req.ip.
function realIp(ip, spoofed = "") {
  return { "x-forwarded-for": spoofed ? `${spoofed}, ${ip}` : ip };
}

async function withApp({ store = createMemoryThrottleStore(), kind = "password", limits = LIMITS } = {}, body) {
  const throttle = createLoginThrottle({ store, limits });
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  let handlerCalls = 0;
  app.post("/login", throttle({ kind, scope: "user", account: (req) => req.body?.email }), (req, res) => {
    handlerCalls += 1;
    if (req.body.password === "right") return res.json({ ok: true });
    return res.status(kind === "otp" ? 400 : 401).json({ error: "Invalid" });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (payload, headers = realIp("203.0.113.9")) => {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    await res.text();
    await new Promise((resolve) => setImmediate(resolve)); // let the 'finish' bookkeeping run
    return res;
  };
  try {
    await body({ post, calls: () => handlerCalls, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("an account is locked after the attempt limit, even for the right password", () => withApp({}, async ({ post, calls }) => {
  for (let i = 0; i < LIMITS.accountAttempts; i += 1) {
    assert.equal((await post({ email: "a@x.in", password: "wrong" })).status, 401);
  }
  const blocked = await post({ email: "a@x.in", password: "right" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "900");
  assert.equal(calls(), LIMITS.accountAttempts, "blocked attempts never reach the password check");
}));

test("account keys ignore case and surrounding spaces", () => withApp({}, async ({ post }) => {
  for (const email of ["A@X.in", " a@x.in", "a@X.IN"]) await post({ email, password: "wrong" });
  assert.equal((await post({ email: "a@x.in", password: "right" })).status, 429);
}));

test("a successful sign-in clears the account counter", () => withApp({}, async ({ post }) => {
  await post({ email: "a@x.in", password: "wrong" });
  await post({ email: "a@x.in", password: "wrong" });
  assert.equal((await post({ email: "a@x.in", password: "right" })).status, 200);
  assert.equal((await post({ email: "a@x.in", password: "wrong" })).status, 401);
  assert.equal((await post({ email: "a@x.in", password: "right" })).status, 200);
}));

test("parallel guesses cannot exceed the account limit", () => withApp({}, async ({ post, calls }) => {
  const results = await Promise.all(Array.from({ length: 12 }, () => post({ email: "a@x.in", password: "wrong" })));
  assert.equal(calls(), LIMITS.accountAttempts);
  assert.equal(results.filter((r) => r.status === 429).length, 12 - LIMITS.accountAttempts);
}));

test("one IP spraying many accounts is blocked after the failure limit", () => withApp({}, async ({ post }) => {
  for (let i = 0; i < LIMITS.ipFailures; i += 1) {
    assert.equal((await post({ email: `victim${i}@x.in`, password: "wrong" })).status, 401);
  }
  assert.equal((await post({ email: "fresh@x.in", password: "right" })).status, 429);
  // A different client IP is unaffected.
  assert.equal((await post({ email: "fresh@x.in", password: "right" }, realIp("198.51.100.4"))).status, 200);
}));

test("successful sign-ins never count against a shared carrier-NAT IP", () => withApp({}, async ({ post }) => {
  for (let i = 0; i < LIMITS.ipFailures * 4; i += 1) {
    assert.equal((await post({ email: `customer${i}@x.in`, password: "right" })).status, 200);
  }
}));

test("rotating a client-supplied X-Forwarded-For value does not reset the IP limit", () => withApp({}, async ({ post }) => {
  for (let i = 0; i < LIMITS.ipFailures; i += 1) {
    await post({ email: `victim${i}@x.in`, password: "wrong" }, realIp("203.0.113.9", `10.0.0.${i}`));
  }
  assert.equal((await post({ email: "fresh@x.in", password: "right" }, realIp("203.0.113.9", "10.9.9.9"))).status, 429);
}));

test("OTP verification treats a wrong code (400) as a failure and allows fewer attempts", () => withApp({ kind: "otp" }, async ({ post, calls }) => {
  for (let i = 0; i < LIMITS.otpAttempts; i += 1) {
    assert.equal((await post({ email: "new@x.in", password: "wrong" })).status, 400);
  }
  assert.equal((await post({ email: "new@x.in", password: "right" })).status, 429);
  assert.equal(calls(), LIMITS.otpAttempts);
}));

test("if the limiter store is down, sign-in fails closed with 503", () => {
  const broken = createMemoryThrottleStore();
  broken.exceeded = async () => { throw new Error("db down"); };
  return withApp({ store: broken }, async ({ post, calls }) => {
    assert.equal((await post({ email: "a@x.in", password: "right" })).status, 503);
    assert.equal(calls(), 0);
  });
});

test("the limit resets after the window", async () => {
  let clock = 0;
  const store = createMemoryThrottleStore({ now: () => clock });
  await withApp({ store }, async ({ post }) => {
    for (let i = 0; i < LIMITS.accountAttempts; i += 1) await post({ email: "a@x.in", password: "wrong" });
    assert.equal((await post({ email: "a@x.in", password: "right" })).status, 429);
    clock += LIMITS.windowSeconds * 1000;
    assert.equal((await post({ email: "a@x.in", password: "right" })).status, 200);
  });
});

// Regression guard: every credential endpoint must keep the throttle.
function throttledRoutes(router) {
  return router.stack
    .filter((layer) => layer.route?.methods?.post)
    .filter((layer) => layer.route.stack.some((s) => s.handle?.name === "loginThrottleMiddleware"))
    .map((layer) => layer.route.path);
}

test("users, technicians and admin credential routes are all throttled", async () => {
  const [{ default: users }, { default: technicians }, { default: admin }] = await Promise.all([
    import("../routes/users.js"),
    import("../routes/technicians.js"),
    import("../routes/admin.js"),
  ]);
  assert.deepEqual(throttledRoutes(users).sort(), ["/login", "/verify-otp"]);
  assert.deepEqual(throttledRoutes(technicians), ["/login"]);
  assert.deepEqual(throttledRoutes(admin), ["/login"]);
});

// Real MySQL (CI only): the production store must count, lock and clear correctly.
// A SQL mistake here would make every sign-in fail closed with 503.
const realDb = process.env.APP_ANALYTICS_TEST_DB === "1";

test("real DB: MySQL store enforces limits atomically, counts failures, and clears", { skip: !realDb }, async () => {
  const [{ createDisposableDatabase }, { TABLES }, { withUuidPersistence }, { createMysqlThrottleStore }] = await Promise.all([
    import("./helpers/appAnalyticsDatabase.mjs"),
    import("../models/schema/index.js"),
    import("../models/persistence.js"),
    import("../services/loginThrottle.js"),
  ]);
  const db = await createDisposableDatabase();
  try {
    await db.pool.query(TABLES.recovery_rate_limits);
    const pool = withUuidPersistence(db.pool); // same wrapper as production getPool()
    const store = createMysqlThrottleStore({ getPool: async () => pool });

    assert.equal(await store.take("acct", 2, 900), true);
    assert.equal(await store.take("acct", 2, 900), true);
    assert.equal(await store.take("acct", 2, 900), false);
    await store.clear("acct");
    assert.equal(await store.take("acct", 2, 900), true);

    const parallel = await Promise.allSettled(Array.from({ length: 10 }, () => store.take("race", 3, 900)));
    const granted = parallel.filter((r) => r.status === "fulfilled" && r.value === true).length;
    assert.ok(granted >= 1 && granted <= 3, `parallel takes granted ${granted}, limit 3`);

    assert.equal(await store.exceeded("ip", 2, 900), false);
    await store.increment("ip", 900);
    await store.increment("ip", 900);
    assert.equal(await store.exceeded("ip", 2, 900), true);
    assert.equal(await store.exceeded("ip", 2, 0), false, "an expired window no longer blocks");
  } finally {
    await db.close();
  }
});
