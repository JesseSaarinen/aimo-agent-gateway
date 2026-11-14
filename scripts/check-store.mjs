// Store self-test against the real Postgres database (src/lib/store.ts). It works in its own namespace
// ("selftest-…") and deletes its rows afterwards, so it never touches the app's orders.
//   vercel env pull .env.vercel --environment=development     (once; .env* is gitignored)
//   node --env-file=.env.vercel scripts/check-store.mjs
// Prints results only, never the connection string.
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set: pull the Vercel variables first (see the top of this file).");
  process.exit(1);
}
const ns = `selftest-${Date.now().toString(36)}`;
process.env.STORE_NAMESPACE = ns;
const { store, storeKind } = await import("../src/lib/store.ts");
const sql = neon(process.env.DATABASE_URL);

const host = new URL(process.env.DATABASE_URL).hostname;
console.log(`Store: ${storeKind()}, database region: ${host.split(".").slice(-4, -2).join(".")}`);
assert.equal(storeKind(), `postgres (${ns})`);

let passed = 0;
async function check(name, fn) {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - t} ms)`);
}

try {
  await check("get on a missing id is null", async () => {
    assert.equal(await store.get("orders", "nope"), null);
  });

  await check("put then get returns the same document (nested, numbers, € and ä)", async () => {
    const doc = { id: "a", total: 1010.5, lines: [{ name: "Hyvä suomalainen Arki® 1 l", price: 1.01, ok: true, none: null }], note: "1 010,50 €" };
    await store.put("orders", "a", doc);
    assert.deepEqual(await store.get("orders", "a"), doc);
  });

  await check("list is newest first", async () => {
    await store.put("orders", "b", { id: "b" });
    await store.put("orders", "c", { id: "c" });
    assert.deepEqual((await store.list("orders")).map((d) => d.id), ["c", "b", "a"]);
  });

  await check("put on an existing id replaces it and keeps its place in the list", async () => {
    await store.put("orders", "a", { id: "a", changed: true });
    assert.deepEqual(await store.get("orders", "a"), { id: "a", changed: true });
    assert.deepEqual((await store.list("orders")).map((d) => d.id), ["c", "b", "a"]);
  });

  await check("putIfAbsent on a taken id returns false and writes nothing", async () => {
    assert.equal(await store.putIfAbsent("orders", "b", { id: "b", overwritten: true }), false);
    assert.deepEqual(await store.get("orders", "b"), { id: "b" });
  });

  await check("putIfAbsent on a free id returns true and goes to the top of the list", async () => {
    assert.equal(await store.putIfAbsent("orders", "d", { id: "d" }), true);
    assert.deepEqual((await store.list("orders")).map((d) => d.id), ["d", "c", "b", "a"]);
  });

  await check("list honours the limit", async () => {
    assert.deepEqual((await store.list("orders", 2)).map((d) => d.id), ["d", "c"]);
  });

  await check("five putIfAbsent calls at once on one id: exactly one wins (the replay guard)", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => store.putIfAbsent("orders", "race", { id: "race", n })));
    assert.equal(results.filter(Boolean).length, 1);
  });

  await check("collections are kept apart", async () => {
    await store.put("offers", "a", { id: "offer-a" });
    assert.deepEqual(await store.get("offers", "a"), { id: "offer-a" });
    assert.deepEqual(await store.get("orders", "a"), { id: "a", changed: true });
    assert.equal((await store.list("offers")).length, 1);
  });

  await check("clear deletes this namespace only", async () => {
    const other = `${ns}-other`;
    await sql`insert into aimo_docs (ns, collection, id, body) values (${other}, 'orders', 'keep', '{"id":"keep"}'::jsonb)`;
    await store.clear();
    assert.deepEqual(await store.list("orders"), []);
    assert.deepEqual(await store.list("offers"), []);
    const left = await sql`select count(*)::int as n from aimo_docs where ns = ${other}`;
    assert.equal(left[0].n, 1);
    await sql`delete from aimo_docs where ns = ${other}`;
  });
} finally {
  await sql`delete from aimo_docs where ns like ${`${ns}%`}`;
}

const counts = await sql`select ns, count(*)::int as n from aimo_docs group by ns order by ns`;
console.log(`\n${passed} of 10 checks passed. Rows in the database now, per namespace:`, counts.length ? counts.map((r) => `${r.ns}: ${r.n}`).join(", ") : "none");
