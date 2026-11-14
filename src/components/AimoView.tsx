"use client";
// Valio Aimo's read-only view: the order book and the full log, including calls the gateway turned away.
import { useState } from "react";
import type { AuditEntry } from "@/lib/audit";
import { AuditLog } from "./AuditLog";
import { api, money, usePoll } from "./client";
import { OrderDocket, type OrderView } from "./OrderDocket";

type View = { orders: OrderView[]; log: (AuditEntry & { ruleName: string | null })[] };
const ROLE = { role: "supplier" } as const;
const isSandbox = (buyerId: string | null) => !!buyerId?.startsWith("sbx-");

async function load(): Promise<View> {
  const [orders, log] = await Promise.all([api("/api/v1/orders", ROLE), api("/api/v1/audit?limit=200", ROLE)]);
  if (!orders.ok || !log.ok) throw new Error(orders.json.reason ?? log.json.reason ?? "The gateway did not answer.");
  return { orders: orders.json.orders, log: log.json.entries };
}

export function AimoView() {
  const { data, error } = usePoll(load, 4000);
  const [sandbox, setSandbox] = useState(false);
  const [onlyStopped, setOnlyStopped] = useState(false);

  if (error && !data) {
    return (
      <p role="alert" className="rounded border border-stop bg-stop-bg px-4 py-3 text-stop">
        The view could not load: {error}
      </p>
    );
  }
  if (!data) return <p className="text-soft">Loading the order book…</p>;

  const orders = data.orders.filter((o) => sandbox || !isSandbox(o.buyerId));
  const log = data.log.filter((e) => (sandbox || !isSandbox(e.buyerId)) && (!onlyStopped || ["refused", "blocked", "needs_approval"].includes(e.outcome)));
  const confirmed = orders.reduce((sum, o) => sum + o.totals.confirmed, 0);
  const waiting = orders.filter((o) => o.status === "awaiting_approval").length;
  const refused = data.log.filter((e) => e.outcome === "refused" && (sandbox || !isSandbox(e.buyerId))).length;

  return (
    <>
      <h1 className="text-3xl font-extrabold sm:text-4xl">Valio Aimo&apos;s view</h1>
      <p className="mt-1 max-w-3xl text-soft">
        What the supplier sees: every order that came through the gateway and every call it turned away. Read-only. This view can&apos;t approve an order
        or change a buyer&apos;s mandate.
      </p>

      <dl className="mt-6 grid max-w-2xl grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-sm text-soft">Confirmed orders</dt>
          <dd className="text-2xl font-extrabold">{money(confirmed)}</dd>
        </div>
        <div>
          <dt className="text-sm text-soft">Waiting for a buyer&apos;s purchaser</dt>
          <dd className="text-2xl font-extrabold">{waiting}</dd>
        </div>
        <div>
          <dt className="text-sm text-soft">Calls refused</dt>
          <dd className="text-2xl font-extrabold">{refused}</dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} className="h-4 w-4 accent-teal" />
          Include the break-it run&apos;s sandbox buyers
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={onlyStopped} onChange={(e) => setOnlyStopped(e.target.checked)} className="h-4 w-4 accent-teal" />
          Log: only what was held, blocked or refused
        </label>
      </div>

      <section aria-labelledby="book-heading" className="mt-8">
        <h2 id="book-heading" className="text-xl font-bold">
          Order book
        </h2>
        {orders.length === 0 ? (
          <p className="mt-3 rounded border border-dashed border-line px-4 py-6 text-soft">No orders yet. Start a run on the demo page, or connect an agent.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {orders.map((o) => (
              <OrderDocket key={o.id} order={o} showBuyer />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="aimo-log-heading" className="mt-10">
        <h2 id="aimo-log-heading" className="text-xl font-bold">
          Log
        </h2>
        <p className="mb-3 mt-1 text-soft">Includes callers with no valid key. Their key is never stored, only a fingerprint.</p>
        <AuditLog entries={log} showBuyer empty="Nothing in the log yet." />
      </section>
    </>
  );
}
