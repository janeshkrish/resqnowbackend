import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as connect } from "socket.io-client";

import {
  canonicalUploadPath,
  signUploadLink,
  signUploadLinks,
  verifyUploadLink,
  signUploadLinksInJson,
  signSocketPayloads,
} from "../services/uploadLinks.js";
import { sanitizeRequestDetails } from "../services/requestDetails.js";

// Fix #4 (AUTH-02 / QA-009): uploaded files are readable only through short-lived
// signed links, which the server adds to responses that already passed their own
// permission checks.

const secret = "synthetic-upload-link-secret";
const HOUR = 3600;
const at = (seconds) => ({ secret, now: () => seconds * 1000 });
const T0 = 1_800_000_000; // a fixed instant, aligned so bucket maths is easy to follow
const parse = (link) => {
  const url = new URL(link, "https://api.example.test");
  return {
    filename: decodeURIComponent(url.pathname.split("/").pop()),
    exp: url.searchParams.get("exp"),
    sig: url.searchParams.get("sig"),
  };
};

test("canonical upload paths: accepts every stored form, strips signatures, rejects everything else", () => {
  const name = "1712-1234-tyre.jpg";
  for (const input of [
    `/api/upload/files/${name}`,
    `api/upload/files/${name}`,
    `https://resqnowbackend.up.railway.app/api/upload/files/${name}`,
    `/api/upload/files/${name}?exp=1&sig=abc`,
    `https://x.test/api/upload/files/${name}?exp=1&sig=abc#frag`,
  ]) assert.equal(canonicalUploadPath(input), `/api/upload/files/${name}`, input);
  for (const input of ["", "/api/upload/files/", "/api/upload/files/../etc", "/api/upload/files/a/b", "/placeholder.svg", "https://x.test/other/a.jpg", null, 42]) {
    assert.equal(canonicalUploadPath(input), null, String(input));
  }
});

test("a signed link verifies, and any tampering or expiry is refused", () => {
  const link = signUploadLink("/api/upload/files/a-b_c.1.png", at(T0));
  assert.match(link, /^\/api\/upload\/files\/a-b_c\.1\.png\?exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
  const parts = parse(link);
  assert.equal(verifyUploadLink(parts, at(T0)), "ok");
  assert.equal(verifyUploadLink({ ...parts, filename: "other.png" }, at(T0)), "invalid");
  assert.equal(verifyUploadLink({ ...parts, exp: String(Number(parts.exp) + 3600) }, at(T0)), "invalid");
  assert.equal(verifyUploadLink({ ...parts, sig: parts.sig.replace(/^./, (c) => (c === "A" ? "B" : "A")) }, at(T0)), "invalid");
  assert.equal(verifyUploadLink({ ...parts, sig: undefined }, at(T0)), "invalid");
  assert.equal(verifyUploadLink(parts, { secret: "another-secret", now: () => T0 * 1000 }), "invalid");
  assert.equal(verifyUploadLink(parts, at(Number(parts.exp) + 1)), "expired");
});

test("links last 6 to 12 hours and stay identical within a 6-hour window, so browsers can cache them", () => {
  const exp = (s) => Number(parse(signUploadLink("/api/upload/files/x.png", at(s))).exp);
  const bucketStart = Math.floor(T0 / (6 * HOUR)) * 6 * HOUR;
  assert.equal(exp(bucketStart), exp(bucketStart + 6 * HOUR - 1));
  for (const s of [bucketStart, bucketStart + 3 * HOUR, bucketStart + 6 * HOUR - 1]) {
    const remaining = exp(s) - s;
    assert.ok(remaining > 6 * HOUR && remaining <= 12 * HOUR, `remaining ${remaining}s`);
  }
});

test("absolute links keep their origin, and stale or already-signed links are re-signed", () => {
  const abs = signUploadLink("https://api.example.test/api/upload/files/x.png", at(T0));
  assert.match(abs, /^https:\/\/api\.example\.test\/api\/upload\/files\/x\.png\?exp=\d+&sig=/);
  const stale = "/api/upload/files/x.png?exp=1&sig=old";
  const fresh = signUploadLink(stale, at(T0));
  assert.equal(verifyUploadLink(parse(fresh), at(T0)), "ok");
});

test("deep signing touches only upload links, anywhere in a payload, and survives cycles", () => {
  const payload = {
    id: "r1",
    note: "see /api/upload/files/x.png in text",
    details: { attachments: [{ type: "photo", url: "/api/upload/files/p.jpg" }, { type: "voice", url: "/api/upload/files/v.webm" }] },
    technician: { documents: { profile_photo: "https://h.test/api/upload/files/me.png", garage_front: "" } },
    image: "/placeholder.svg",
    when: new Date(0),
    bytes: Buffer.from("x"),
    count: 3,
  };
  payload.self = payload;
  const signed = signUploadLinks(payload, at(T0));
  assert.notEqual(signed, payload, "the original object is not mutated");
  assert.equal(payload.details.attachments[0].url, "/api/upload/files/p.jpg");
  for (const link of [signed.details.attachments[0].url, signed.details.attachments[1].url, signed.technician.documents.profile_photo]) {
    assert.equal(verifyUploadLink(parse(link), at(T0)), "ok", link);
  }
  assert.equal(signed.note, payload.note, "free text is never rewritten");
  assert.equal(signed.image, "/placeholder.svg");
  assert.equal(signed.technician.documents.garage_front, "");
  assert.ok(signed.when instanceof Date && Buffer.isBuffer(signed.bytes));
  assert.equal(signed.count, 3);
});

test("without a signing secret nothing is signed (links stay unusable, never forged)", () => {
  assert.equal(signUploadLink("/api/upload/files/x.png", { secret: "", now: () => 0 }), "/api/upload/files/x.png");
  assert.equal(verifyUploadLink({ filename: "x.png", exp: "9999999999", sig: "a".repeat(43) }, { secret: "", now: () => 0 }), "invalid");
});

test("request details keep photos and voice notes when the app sends back a signed link", () => {
  const signed = signUploadLink("/api/upload/files/123-tyre.jpg", at(T0));
  const details = sanitizeRequestDetails({ attachments: [{ type: "photo", url: signed }, { type: "voice", url: "https://api.test/api/upload/files/v.webm?exp=1&sig=x" }] });
  assert.deepEqual(details.attachments, [
    { type: "photo", url: "/api/upload/files/123-tyre.jpg" },
    { type: "voice", url: "/api/upload/files/v.webm" },
  ]);
});

test("every JSON response has its upload links signed", async () => {
  const app = express();
  app.use(signUploadLinksInJson(at(T0)));
  app.get("/job", (_req, res) => res.json({ attachments: [{ type: "photo", url: "/api/upload/files/p.jpg" }] }));
  const server = app.listen(0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/job`)).json();
    assert.equal(verifyUploadLink(parse(body.attachments[0].url), at(T0)), "ok");
  } finally {
    server.close();
  }
});

test("every socket message has its upload links signed (rooms, chained rooms and broadcasts)", async () => {
  const httpServer = createServer();
  const io = new Server(httpServer);
  signSocketPayloads(io, at(T0));
  io.on("connection", (socket) => socket.join("technician_7"));
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const client = connect(`http://127.0.0.1:${httpServer.address().port}`, { transports: ["websocket"] });
  try {
    await new Promise((resolve) => client.on("connect", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const received = (event) => new Promise((resolve) => client.once(event, resolve));
    const job = { requestId: "r1", attachments: [{ type: "voice", url: "/api/upload/files/v.webm" }] };

    let got = received("JOB_ALERT");
    io.to("technician_7").emit("JOB_ALERT", job);
    assert.equal(verifyUploadLink(parse((await got).attachments[0].url), at(T0)), "ok");

    got = received("JOB_TAKEN");
    io.to("technician_7").to("nobody").emit("JOB_TAKEN", job);
    assert.equal(verifyUploadLink(parse((await got).attachments[0].url), at(T0)), "ok");

    got = received("everyone");
    io.emit("everyone", job);
    assert.equal(verifyUploadLink(parse((await got).attachments[0].url), at(T0)), "ok");
    assert.equal(job.attachments[0].url, "/api/upload/files/v.webm", "the caller's object is not mutated");
  } finally {
    client.close();
    io.close();
    httpServer.close();
  }
});
