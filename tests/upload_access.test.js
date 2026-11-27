import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";

import { createUploadRouter } from "../routes/upload.js";
import { signUploadLinksInJson, signUploadLink } from "../services/uploadLinks.js";
import { createMemoryThrottleStore } from "../services/loginThrottle.js";

// Fix #4 (AUTH-02 / QA-009): no anonymous downloads, real file types only,
// throttled uploads, private caching.

process.env.JWT_SECRET = "synthetic-upload-access-secret";
const TECH_ID = "33333333-3333-4333-8333-333333333333";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from("%PDF-1.7\n%test\n");
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

async function withApp({ limits } = {}, body) {
  const clock = { now: Date.UTC(2027, 0, 15, 3, 0, 0) };
  const linkOptions = { secret: process.env.JWT_SECRET, now: () => clock.now };
  const files = new Map();
  const pool = {
    execute: async (sql, args) => {
      if (sql.startsWith("INSERT INTO files")) {
        const [filename, content, mimetype, size] = args;
        files.set(filename, { filename, content, mimetype, size });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("SELECT")) return [files.has(args[0]) ? [files.get(args[0])] : []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const app = express();
  app.set("trust proxy", 1);
  app.use(signUploadLinksInJson(linkOptions));
  app.use("/api/upload", createUploadRouter({
    getPool: async () => pool, throttleStore: createMemoryThrottleStore({ now: () => clock.now }), limits, linkOptions,
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = async (bytes, type, name, { token, ip = "203.0.113.5" } = {}) => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    const headers = { "x-forwarded-for": ip };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api/upload`, { method: "POST", body: form, headers });
    return { res, body: await res.json().catch(() => ({})) };
  };
  const get = (link) => fetch(link.startsWith("http") ? link : `${base}${link}`);
  try {
    await body({ upload, get, clock, files, linkOptions });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("an upload returns a signed link that opens the file, privately cached and never type-sniffed", () => withApp({}, async ({ upload, get }) => {
  const { res, body } = await upload(PNG, "image/png", "garage front.png");
  assert.equal(res.status, 200);
  assert.match(body.url, /^\/api\/upload\/files\/[A-Za-z0-9._-]+\?exp=\d+&sig=/);
  const file = await get(body.url);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.match(file.headers.get("cache-control"), /^private, max-age=\d+$/);
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
}));

test("the plain file address no longer works for anyone", () => withApp({}, async ({ upload, get }) => {
  const { body } = await upload(PNG, "image/png", "doc.png");
  const plain = body.url.split("?")[0];
  const res = await get(plain);
  assert.equal(res.status, 403);
}));

test("expired, altered or foreign links are refused; a missing file is 404", () => withApp({}, async ({ upload, get, clock, linkOptions }) => {
  const { body } = await upload(PNG, "image/png", "doc.png");
  const tampered = body.url.replace(/sig=./, (m) => (m.endsWith("A") ? "sig=B" : "sig=A"));
  assert.equal((await get(tampered)).status, 403);
  const otherFile = body.url.replace(/files\/[^?]+/, "files/someone-elses.png");
  assert.equal((await get(otherFile)).status, 403);
  assert.equal((await get(signUploadLink("/api/upload/files/never-uploaded.png", linkOptions))).status, 404);
  assert.equal((await get("/api/upload/files/..%2Fsecrets")).status, 400);
  clock.now += 13 * 60 * 60 * 1000;
  const expired = await get(body.url);
  assert.equal(expired.status, 403);
  assert.match((await expired.json()).error, /expired/i);
}));

test("a file whose contents do not match its type is rejected (no HTML disguised as an image)", () => withApp({}, async ({ upload }) => {
  const html = Buffer.from("<html><script>alert(1)</script></html>");
  assert.equal((await upload(html, "image/png", "x.png")).res.status, 400);
  assert.equal((await upload(html, "application/pdf", "x.pdf")).res.status, 400);
  assert.equal((await upload(PDF, "image/jpeg", "x.jpg")).res.status, 400);
  assert.equal((await upload(PDF, "application/pdf", "resume.pdf")).res.status, 200);
  assert.equal((await upload(WEBM, "audio/webm;codecs=opus", "voice.webm")).res.status, 200, "voice notes still work");
  assert.equal((await upload(Buffer.from("text"), "text/html", "x.html")).res.status, 400);
}));

test("anonymous uploads are limited per IP; a signed-in technician has their own allowance", () => withApp({ limits: { windowSeconds: 3600, anonymousPerIp: 2, perAccount: 3 } }, async ({ upload }) => {
  assert.equal((await upload(PNG, "image/png", "a.png")).res.status, 200);
  assert.equal((await upload(PNG, "image/png", "b.png")).res.status, 200);
  const blocked = await upload(PNG, "image/png", "c.png");
  assert.equal(blocked.res.status, 429);
  assert.equal((await upload(PNG, "image/png", "d.png", { ip: "198.51.100.9" })).res.status, 200, "another IP is unaffected");
  const token = jwt.sign({ id: TECH_ID, role: "technician", sv: 0 }, process.env.JWT_SECRET);
  for (let i = 0; i < 3; i += 1) assert.equal((await upload(PNG, "image/png", `t${i}.png`, { token })).res.status, 200);
  assert.equal((await upload(PNG, "image/png", "t4.png", { token })).res.status, 429);
}));
