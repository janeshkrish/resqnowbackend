import test from "node:test";
import assert from "node:assert/strict";
import { reviewedSourceConnection } from "../models/migrations/reviewedSource.js";

const review = { unmodeledTablesRetainedInSource: ["old_module"], quarantinedRowsRetainedInSource: { users: ["1", "2"] } };

test("reviewed transfer preserves strict failures for unreviewed tables and inbound dependencies", async () => {
  const unknown = reviewedSourceConnection({ query: async () => [[{ table_name: "unreviewed" }]] }, review);
  await assert.rejects(unknown.query("SELECT * FROM information_schema.columns"), /Unreviewed legacy table/);
  const inbound = reviewedSourceConnection({ query: async () => [[{ table_name: "users", referenced_table_name: "old_module" }]] }, review);
  await assert.rejects(inbound.query("SELECT * FROM information_schema.key_column_usage"), /Active table references an archived table/);
  assert.throws(() => reviewedSourceConnection({}, { unmodeledTablesRetainedInSource: ["users"] }), /entire active model/);
});

test("reviewed source is read-only and filters archived metadata and excluded records", async () => {
  const source = reviewedSourceConnection({ query: async sql => /information_schema/.test(sql)
    ? [[{ table_name: "users" }, { table_name: "old_module" }]] : [[{ id: 1 }, { id: 3 }]] }, review);
  assert.deepEqual((await source.query("SELECT * FROM information_schema.columns"))[0], [{ table_name: "users" }]);
  assert.deepEqual((await source.query("SELECT id FROM `users`"))[0], [{ id: 3 }]);
  await assert.rejects(source.query("UPDATE users SET id=4"), /read-only/);
  assert.throws(() => source.execute("DELETE FROM users"), /read-only/);
});

test("pagination excludes rows in SQL before LIMIT, including a page with 100 excluded rows", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));
  const calls = [];
  const source = reviewedSourceConnection({ query: async (sql, params) => { calls.push({ sql, params }); return [[{ id: 101 }]]; } },
    { quarantinedRowsRetainedInSource: { users: ids } });
  assert.deepEqual((await source.query("SELECT * FROM `users` ORDER BY id LIMIT 100"))[0], [{ id: 101 }]);
  assert.match(calls[0].sql, /WHERE id NOT IN \(\?,/);
  assert.equal(calls[0].params.length, 100);
  await source.query("SELECT * FROM `users` WHERE id > ? ORDER BY id LIMIT 100", [200]);
  assert.match(calls[1].sql, /WHERE id > \? AND id NOT IN/);
  assert.deepEqual(calls[1].params, [200, ...ids]);
});
