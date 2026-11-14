// The only place that stores anything: mandates, offers, orders and the audit log.
// One small interface with two backends:
//   - Postgres (Neon), one JSONB table, used when DATABASE_URL is set;
//   - memory, used otherwise, in tests and on fake Valio data. Lost on restart, not shared between instances.
import { neon } from "@neondatabase/serverless";

export interface Store {
  get<T>(collection: string, id: string): Promise<T | null>;
  /** Insert or replace. A replaced document keeps its place in the list order. */
  put<T>(collection: string, id: string, value: T): Promise<void>;
  /** Insert only if the id is free. Returns false, and writes nothing, when it is taken. */
  putIfAbsent<T>(collection: string, id: string, value: T): Promise<boolean>;
  /** Newest first, by when each document was first written. */
  list<T>(collection: string, limit?: number): Promise<T[]>;
  /** Delete everything. Only the demo reset uses this. */
  clear(): Promise<void>;
}

// ---- memory ----

type Doc = { seq: number; body: unknown };
type Memory = { seq: number; collections: Map<string, Map<string, Doc>> };

// On globalThis so that every route module (and a hot reload in dev) shares the same data.
const g = globalThis as unknown as { __aimoStore?: Memory; __aimoPostgres?: Store };
const mem = (): Memory => (g.__aimoStore ??= { seq: 0, collections: new Map() });

function collection(name: string): Map<string, Doc> {
  const m = mem();
  let c = m.collections.get(name);
  if (!c) m.collections.set(name, (c = new Map()));
  return c;
}

// Copy on the way in and out, like a database would, so callers can't change stored data by accident.
const copy = <T>(v: T): T => structuredClone(v);

const memoryStore: Store = {
  async get<T>(name: string, id: string) {
    const doc = collection(name).get(id);
    return doc ? (copy(doc.body) as T) : null;
  },
  async put<T>(name: string, id: string, value: T) {
    const c = collection(name);
    c.set(id, { seq: c.get(id)?.seq ?? ++mem().seq, body: copy(value) });
  },
  async putIfAbsent<T>(name: string, id: string, value: T) {
    const c = collection(name);
    if (c.has(id)) return false;
    c.set(id, { seq: ++mem().seq, body: copy(value) });
    return true;
  },
  async list<T>(name: string, limit = 200) {
    return [...collection(name).values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .map((d) => copy(d.body) as T);
  },
  async clear() {
    resetStore();
  },
};

// ---- Postgres ----

/**
 * One table for everything. `ns` keeps environments apart in a shared database (production, preview, local).
 * NOT YET RUN AGAINST A REAL DATABASE: written on Sat 14 Nov before the connection string was available.
 */
function postgresStore(url: string, ns: string): Store {
  const sql = neon(url);
  let ready: Promise<unknown> | null = null;
  const ensure = () =>
    (ready ??= sql`
      create table if not exists aimo_docs (
        ns text not null,
        collection text not null,
        id text not null,
        body jsonb not null,
        seq bigint generated always as identity,
        primary key (ns, collection, id)
      )`
      .then(() => sql`create index if not exists aimo_docs_list on aimo_docs (ns, collection, seq desc)`)
      .catch((e: unknown) => {
        ready = null; // try again on the next call
        throw e;
      }));

  return {
    async get<T>(name: string, id: string) {
      await ensure();
      const rows = await sql`select body from aimo_docs where ns = ${ns} and collection = ${name} and id = ${id}`;
      return (rows[0]?.body as T | undefined) ?? null;
    },
    async put<T>(name: string, id: string, value: T) {
      await ensure();
      await sql`
        insert into aimo_docs (ns, collection, id, body) values (${ns}, ${name}, ${id}, ${JSON.stringify(value)}::jsonb)
        on conflict (ns, collection, id) do update set body = excluded.body`;
    },
    async putIfAbsent<T>(name: string, id: string, value: T) {
      await ensure();
      const rows = await sql`
        insert into aimo_docs (ns, collection, id, body) values (${ns}, ${name}, ${id}, ${JSON.stringify(value)}::jsonb)
        on conflict (ns, collection, id) do nothing
        returning id`;
      return rows.length === 1;
    },
    async list<T>(name: string, limit = 200) {
      await ensure();
      const rows = await sql`select body from aimo_docs where ns = ${ns} and collection = ${name} order by seq desc limit ${limit}`;
      return rows.map((r) => r.body as T);
    },
    async clear() {
      await ensure();
      await sql`delete from aimo_docs where ns = ${ns}`;
    },
  };
}

// ---- which one ----

const postgresEnabled = () => !!process.env.DATABASE_URL && process.env.NODE_ENV !== "test" && process.env.VALIO_FAKE !== "1";

/** "postgres (production)" or "memory": shown by /api/health so it is clear where orders are kept. */
export const storeKind = () => (postgresEnabled() ? `postgres (${namespace()})` : "memory");

const namespace = () => process.env.STORE_NAMESPACE || process.env.VERCEL_ENV || "local";

const backend = (): Store => (postgresEnabled() ? (g.__aimoPostgres ??= postgresStore(process.env.DATABASE_URL!, namespace())) : memoryStore);

export const store: Store = {
  get: (c, id) => backend().get(c, id),
  put: (c, id, v) => backend().put(c, id, v),
  putIfAbsent: (c, id, v) => backend().putIfAbsent(c, id, v),
  list: (c, limit) => backend().list(c, limit),
  clear: () => backend().clear(),
};

/** Tests only: start from an empty in-memory store. */
export function resetStore() {
  g.__aimoStore = { seq: 0, collections: new Map() };
}
