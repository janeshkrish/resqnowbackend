import test, { mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";

// Fix #3 (AUTH-01): admin sign-in uses a bcrypt hash, sessions are revocable by
// ADMIN_SESSION_VERSION everywhere (REST guard, verifyAdmin, sockets), and the
// customer login no longer accepts admin credentials.

const ADMIN_EMAIL = "ops@resqnow.test";
const PASSWORD = "correct horse battery staple";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";

Object.assign(process.env, {
  DB_HOST: "simulated.invalid", DB_USER: "simulated", DB_PASSWORD: "simulated", DB_NAME: "simulated",
  DB_MIGRATION_MODE: "off", JWT_SECRET: "synthetic-admin-auth-secret", ADMIN_EMAIL,
});
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_SESSION_VERSION;
const GOOD_HASH = await bcrypt.hash(PASSWORD, 10);
process.env.ADMIN_PASSWORD_HASH = GOOD_HASH;

// Fake database: admin identity lookup, login-throttle bookkeeping, no customers.
const throttleRow = [[{ request_count: 0, age_seconds: 0 }]];
const pool = {
  query: async (sql) => {
    if (sql === "SELECT 1") return [[{ ok: 1 }]];
    if (sql.includes("recovery_rate_limits")) return throttleRow;
    if (/SELECT id FROM users WHERE email/.test(sql)) return [[{ id: ADMIN_ID }]];
    if (sql.includes("FROM users")) return [[]];
    throw Error(`Unexpected admin auth query: ${sql}`);
  },
  execute: async (sql, args) => {
    if (sql.includes("recovery_rate_limits")) return sql.includes("SELECT") ? throttleRow : [{ affectedRows: 1 }];
    if (sql.includes("INSERT INTO users")) return [{ affectedRows: 1 }];
    if (sql.includes("SELECT")) return pool.query(sql, args);
    throw Error(`Unexpected admin auth statement: ${sql}`);
  },
  getConnection: async () => ({
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    query: (...a) => pool.query(...a), execute: (...a) => pool.execute(...a),
  }),
  end: async () => {},
};
mock.method(mysql, "createPool", () => pool);

const db = await import("../db.js");
const { default: adminRouter } = await import("../routes/admin.js");
const { default: usersRouter } = await import("../routes/users.js");
const { mountCredentialSessions } = await import("../middleware/credentialSessions.js");
const { verifyAdmin } = await import("../middleware/auth.js");
const { createCredentialSessionValidator } = await import("../services/credentialSessions.js");

const app = express();
app.use(express.json());
mountCredentialSessions(app);
app.use("/api/users", usersRouter);
app.use("/api/admin", adminRouter);
app.get("/api/admin-probe", verifyAdmin, (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
test.after(async () => { await new Promise((resolve) => server.close(resolve)); await db.closePool(); });

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
const login = (path, body) => fetch(url(path), {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const probe = (token) => fetch(url("/api/admin-probe"), { headers: { authorization: `Bearer ${token}` } });

function withEnv(values, body) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(body).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test("admin signs in with the hashed password and gets an 8-hour token carrying the session version", async () => {
  const res = await login("/api/admin/login", { email: ` ${ADMIN_EMAIL.toUpperCase()} `, password: PASSWORD });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(payload.role, "admin");
  assert.equal(payload.sv, 1);
  assert.equal(payload.exp - payload.iat, 8 * 60 * 60);
  assert.equal((await probe(token)).status, 200);
});

test("wrong password and unknown email get the same 401, and both pay for a bcrypt comparison", async () => {
  const compare = mock.method(bcrypt, "compare");
  try {
    const wrong = await login("/api/admin/login", { email: ADMIN_EMAIL, password: "not-it" });
    const unknown = await login("/api/admin/login", { email: "someone@else.test", password: PASSWORD });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
    assert.equal(compare.mock.callCount(), 2, "an unknown email must still run bcrypt so timing reveals nothing");
  } finally {
    compare.mock.restore();
  }
});

test("a plaintext ADMIN_PASSWORD alone no longer enables admin sign-in", () => withEnv(
  { ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: PASSWORD },
  async () => {
    const res = await login("/api/admin/login", { email: ADMIN_EMAIL, password: PASSWORD });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured/i);
  },
));

test("a malformed or low-cost hash is refused", async () => {
  for (const hash of ["plaintext-password", await bcrypt.hash(PASSWORD, 4)]) {
    await withEnv({ ADMIN_PASSWORD_HASH: hash }, async () => {
      assert.equal((await login("/api/admin/login", { email: ADMIN_EMAIL, password: PASSWORD })).status, 503);
    });
  }
});

test("admin signs in from the customer login page with the hashed password", async () => {
  const res = await login("/api/users/login", { email: ` ${ADMIN_EMAIL.toUpperCase()} `, password: PASSWORD });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, "admin");
  assert.equal(body.user.role, "admin");
  const payload = jwt.verify(body.token, process.env.JWT_SECRET);
  assert.equal(payload.role, "admin");
  assert.equal(payload.sv, 1);
  assert.equal(payload.exp - payload.iat, 8 * 60 * 60);
  assert.equal((await probe(body.token)).status, 200);
});

test("the customer login page never accepts the old plaintext ADMIN_PASSWORD", () => withEnv(
  { ADMIN_PASSWORD: "old-plaintext-password" },
  async () => {
    const res = await login("/api/users/login", { email: ADMIN_EMAIL, password: "old-plaintext-password" });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).token, undefined);
  },
));

test("on the customer login page a wrong admin password looks exactly like a wrong customer password", async () => {
  const admin = await login("/api/users/login", { email: ADMIN_EMAIL, password: "not-it" });
  const customer = await login("/api/users/login", { email: "nobody@customer.test", password: "not-it" });
  assert.equal(admin.status, 401);
  assert.equal(customer.status, 401);
  assert.deepEqual(await admin.json(), await customer.json());
});

test("without ADMIN_PASSWORD_HASH the customer login page refuses the admin with a plain 401", () => withEnv(
  { ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: PASSWORD },
  async () => {
    const res = await login("/api/users/login", { email: ADMIN_EMAIL, password: PASSWORD });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).token, undefined);
  },
));

test("raising ADMIN_SESSION_VERSION also revokes admin tokens issued by the customer login page", async () => {
  const { token } = await (await login("/api/users/login", { email: ADMIN_EMAIL, password: PASSWORD })).json();
  await withEnv({ ADMIN_SESSION_VERSION: "5" }, async () => {
    assert.equal((await probe(token)).status, 401);
  });
});

test("raising ADMIN_SESSION_VERSION revokes every existing admin token", async () => {
  const { token: v1 } = await (await login("/api/admin/login", { email: ADMIN_EMAIL, password: PASSWORD })).json();
  assert.equal((await probe(v1)).status, 200);
  await withEnv({ ADMIN_SESSION_VERSION: "2" }, async () => {
    assert.equal((await probe(v1)).status, 401, "old token rejected after the bump");
    const { token: v2 } = await (await login("/api/admin/login", { email: ADMIN_EMAIL, password: PASSWORD })).json();
    assert.equal(jwt.decode(v2).sv, 2);
    assert.equal((await probe(v2)).status, 200);
  });
});

test("legacy admin tokens without a session version are rejected", async () => {
  const legacy = jwt.sign({ id: ADMIN_ID, userId: ADMIN_ID, email: ADMIN_EMAIL, role: "admin" }, process.env.JWT_SECRET);
  assert.equal((await probe(legacy)).status, 401);
});

test("an invalid ADMIN_SESSION_VERSION fails closed", () => withEnv({ ADMIN_SESSION_VERSION: "abc" }, async () => {
  assert.equal((await login("/api/admin/login", { email: ADMIN_EMAIL, password: PASSWORD })).status, 503);
  const token = jwt.sign({ id: ADMIN_ID, userId: ADMIN_ID, role: "admin", sv: 1 }, process.env.JWT_SECRET);
  assert.equal((await probe(token)).status, 401);
}));

test("the shared session validator (REST guard and sockets) checks admin versions without a database", async () => {
  const validate = createCredentialSessionValidator({ getPool: async () => { throw Error("database not needed for admins"); } });
  await validate({ id: ADMIN_ID, role: "admin", sessionVersion: 1 });
  await assert.rejects(validate({ id: ADMIN_ID, role: "admin", sessionVersion: 0 }), { statusCode: 401 });
  await assert.rejects(validate({ id: ADMIN_ID, role: "admin" }), { statusCode: 401 });
  await withEnv({ ADMIN_SESSION_VERSION: "3" }, async () => {
    await assert.rejects(validate({ id: ADMIN_ID, role: "admin", sessionVersion: 1 }), { statusCode: 401 });
  });
});

test("startup env validation no longer requires the plaintext ADMIN_PASSWORD", () => withEnv(
  { ADMIN_PASSWORD: undefined, ADMIN_PASSWORD_HASH: undefined, DB_PORT: undefined },
  async () => {
    const { validateEnvironmentOrThrow } = await import("../config/envValidation.js");
    let message = "";
    try { validateEnvironmentOrThrow(); } catch (error) { message = error.message; }
    assert.match(message, /DB_PORT/, "sanity: other missing keys are still reported");
    assert.doesNotMatch(message, /ADMIN_PASSWORD/, "removing ADMIN_PASSWORD must not take the whole API down");
  },
));
