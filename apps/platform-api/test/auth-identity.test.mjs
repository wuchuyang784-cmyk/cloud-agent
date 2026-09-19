import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.mjs";
import { PostgresStore } from "../src/postgres-store.mjs";

test("identity provisioning is idempotent and isolates personal spaces", async () => {
  const store = new MemoryStore();
  const input = { subject: "better-auth:one", email: "one@example.test" };
  const users = await Promise.all(Array.from({ length: 20 }, () => store.ensureIdentityUser(input)));
  assert.equal(new Set(users.map(user => user.id)).size, 1);
  assert.equal(store.organizations.size, 1);
  const other = await store.ensureIdentityUser({ subject: "better-auth:two", email: "two@example.test" });
  assert.notEqual(other.organizationId, users[0].organizationId);
  assert.equal(users[0].passwordHash, undefined);
});

test("email equality never grants access to a legacy identity", async () => {
  const store = new MemoryStore();
  store.createUserWithOrganization({ email: "old@example.test", passwordHash: "old" });
  await assert.rejects(async () => store.ensureIdentityUser({ subject: "better-auth:attacker", email: "old@example.test" }), /identity_link_required/);
  assert.equal(store.organizations.size, 1);
});

test("PostgreSQL provisions identity and membership in one serialized transaction", async () => {
  const calls = [];
  const client = {
    async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
    release() { calls.push({ sql: "release" }); },
  };
  const store = new PostgresStore({ pool: { connect: async () => client } });
  const user = await store.ensureIdentityUser({ subject: "better-auth:new", email: "NEW@example.test" });
  assert.equal(user.email, "new@example.test");
  assert.equal(calls[0].sql, "BEGIN");
  assert.ok(calls.some(call => call.sql.includes("pg_advisory_xact_lock")));
  assert.ok(calls.some(call => call.sql.includes("INSERT INTO users") && call.sql.includes("auth_subject") && call.params.includes("better-auth:new")));
  assert.ok(calls.some(call => call.sql.includes("INSERT INTO organization_members")));
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "release");
});

test("PostgreSQL rejects email collisions and rolls back", async () => {
  const calls = [];
  const client = {
    async query(sql) { calls.push(sql); return { rows: sql.includes("lower(email)") ? [{ id: "legacy" }] : [] }; },
    release() {},
  };
  const store = new PostgresStore({ pool: { connect: async () => client } });
  await assert.rejects(store.ensureIdentityUser({ subject: "better-auth:new", email: "old@example.test" }), /identity_link_required/);
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(!calls.some(sql => sql.includes("INSERT")));
});
