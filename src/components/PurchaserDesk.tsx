"use client";
// The purchaser's desk: the orders waiting for a decision, the mandate, and the log. Polls every few seconds.
import { useState } from "react";
import type { AuditEntry } from "@/lib/audit";
import { fmtDay } from "@/lib/dates";
import type { Mandate } from "@/lib/mandate";
import type { DecisionInput } from "@/lib/orders";
import { AuditLog } from "./AuditLog";
import { api, money, usePoll } from "./client";
import { OrderDocket, type OrderView } from "./OrderDocket";

type MandateView = {
  buyer: { id: string; name: string; sites: { id: string; name: string }[] };
  mandate: Mandate;
  rules: string[];
  week: { from: string; ordered: number; left: number };
};
type Desk = { orders: OrderView[]; mandate: MandateView; log: (AuditEntry & { ruleName: string | null })[] };

const ROLE = { role: "purchaser" } as const;

async function load(): Promise<Desk> {
  const [orders, mandate, log] = await Promise.all([api("/api/v1/orders", ROLE), api("/api/v1/mandate", ROLE), api("/api/v1/audit?limit=60", ROLE)]);
  if (!orders.ok || !mandate.ok || !log.ok) throw new Error(orders.json.reason ?? mandate.json.reason ?? log.json.reason ?? "The gateway did not answer.");
  return { orders: orders.json.orders, mandate: mandate.json, log: log.json.entries };
}

const field = "mt-1 w-full rounded border border-line bg-sheet px-2 py-1.5 text-right font-semibold";

function MandatePanel({ view, onSaved }: { view: MandateView; onSaved: () => void }) {
  const m = view.mandate;
  const [limit, setLimit] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<string | null>(null);
  const [state, setState] = useState<{ tone: "go" | "stop"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const changed = (limit !== null && Number(limit) !== m.maxOrderEur) || (weekly !== null && Number(weekly) !== m.weeklyBudgetEur);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const r = await api("/api/v1/mandate", { ...ROLE, method: "PATCH", body: { maxOrderEur: Number(limit ?? m.maxOrderEur), weeklyBudgetEur: Number(weekly ?? m.weeklyBudgetEur) } });
    setSaving(false);
    if (r.ok) {
      setLimit(null);
      setWeekly(null);
      setState({ tone: "go", text: `Saved as version ${r.json.mandate.version}. It applies from the next order on.` });
      onSaved();
    } else setState({ tone: "stop", text: r.json.reason ?? "The mandate was not saved." });
  }

  return (
    <section aria-labelledby="mandate-heading" className="rounded border border-line bg-sheet">
      <header className="border-b border-line px-4 py-3">
        <h2 id="mandate-heading" className="font-bold">
          The agent&apos;s mandate
        </h2>
        <p className="text-sm text-soft">
          Version {m.version}. Only you can change it; the agent can&apos;t.
        </p>
      </header>
      <form onSubmit={save} className="grid grid-cols-2 gap-3 border-b border-line px-4 py-3">
        <label className="text-sm">
          Most one order may cost, €
          <input type="number" min={1} step="any" inputMode="decimal" value={limit ?? m.maxOrderEur} onChange={(e) => setLimit(e.target.value)} className={field} />
        </label>
        <label className="text-sm">
          Most a week may cost, €
          <input type="number" min={1} step="any" inputMode="decimal" value={weekly ?? m.weeklyBudgetEur} onChange={(e) => setWeekly(e.target.value)} className={field} />
        </label>
        <div className="col-span-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-soft">
            This week since {fmtDay(view.week.from)}: {money(view.week.ordered)} ordered, {money(view.week.left)} left.
          </p>
          <button type="submit" disabled={!changed || saving} className="rounded border border-teal bg-teal px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-50">
            Save limits
          </button>
        </div>
        {state && (
          <p role="status" className={`col-span-2 text-sm ${state.tone === "go" ? "text-go" : "text-stop"}`}>
            {state.text}
          </p>
        )}
      </form>
      <ol className="list-decimal space-y-1.5 border-b border-line py-3 pl-9 pr-4 text-sm">
        {view.rules.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ol>
      <details className="px-4 py-3 text-sm">
        <summary className="cursor-pointer text-soft">The same mandate as data</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-paper p-3 font-mono text-xs leading-relaxed">{JSON.stringify(m, null, 2)}</pre>
      </details>
    </section>
  );
}

export function PurchaserDesk() {
  const { data, error, refresh } = usePoll(load, 3000);
  const [resetting, setResetting] = useState(false);

  async function decide(orderId: string, decision: DecisionInput): Promise<string | null> {
    const r = await api(`/api/v1/orders/${orderId}/decisions`, { ...ROLE, body: decision });
    await refresh();
    return r.ok ? null : `${r.json.ruleName ? `${r.json.ruleName}. ` : ""}${r.json.reason ?? "The gateway refused."}`;
  }

  async function reset() {
    if (!window.confirm("Clear all orders, offers, the log and the mandate, and start the demo from the beginning?")) return;
    setResetting(true);
    await api("/api/demo/reset", { ...ROLE, method: "POST" });
    await refresh();
    setResetting(false);
  }

  if (error && !data) {
    return (
      <p role="alert" className="rounded border border-stop bg-stop-bg px-4 py-3 text-stop">
        The desk could not load: {error}
      </p>
    );
  }
  if (!data) return <p className="text-soft">Loading the desk…</p>;

  const open = data.orders.filter((o) => o.status === "awaiting_approval");
  const decided = data.orders.filter((o) => o.status !== "awaiting_approval");

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Purchaser&apos;s desk</h1>
          <p className="mt-1 text-soft">
            {data.mandate.buyer.name}. You are signed in as the demo purchaser; a real buyer would use their own login.
          </p>
        </div>
        <button type="button" onClick={reset} disabled={resetting} className="rounded border border-line bg-sheet px-3 py-1.5 text-sm font-semibold hover:border-ink disabled:opacity-50">
          Reset demo data
        </button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="inbox-heading" className="min-w-0">
          <h2 id="inbox-heading" className="text-xl font-bold">
            {open.length ? `${open.length} order${open.length === 1 ? "" : "s"} waiting for you` : "Nothing is waiting for you"}
          </h2>
          {open.length === 0 && (
            <p className="mt-3 rounded border border-dashed border-line px-4 py-6 text-soft">
              Orders inside the mandate go through without you. When the agent hits a rule, the order shows up here with the rule and the options. Start the
              menu run on the demo page to see one.
            </p>
          )}
          <div className="mt-3 space-y-4">
            {open.map((o) => (
              <OrderDocket key={o.id} order={o} onDecide={(d) => decide(o.id, d)} />
            ))}
          </div>

          {decided.length > 0 && (
            <>
              <h2 className="mt-8 text-xl font-bold">Decided orders</h2>
              <div className="mt-3 space-y-4">
                {decided.map((o) => (
                  <OrderDocket key={o.id} order={o} />
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="min-w-0">
          <MandatePanel view={data.mandate} onSaved={refresh} />
        </aside>
      </div>

      <section aria-labelledby="log-heading" className="mt-10">
        <h2 id="log-heading" className="text-xl font-bold">
          Log
        </h2>
        <p className="mb-3 mt-1 text-soft">Every decision about your orders: who made it, under which rule, and why. Valio Aimo sees the same entries.</p>
        <AuditLog entries={data.log} empty="Nothing has happened yet. The log fills as soon as an agent asks for an offer." />
      </section>
    </>
  );
}
