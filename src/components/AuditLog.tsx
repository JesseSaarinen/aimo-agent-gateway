"use client";
// The audit log as a table: when, who, what happened, which rule, why. Newest first.
import type { AuditEntry } from "@/lib/audit";
import { fmtDateTime } from "@/lib/dates";
import { TONE, type Tone } from "./client";

type Entry = AuditEntry & { ruleName: string | null };

const OUTCOME: Record<AuditEntry["outcome"], { label: string; tone: Tone }> = {
  allowed: { label: "Went through", tone: "go" },
  approved: { label: "Approved", tone: "go" },
  needs_approval: { label: "Held", tone: "wait" },
  blocked: { label: "Blocked", tone: "stop" },
  refused: { label: "Refused", tone: "stop" },
  rejected: { label: "Rejected", tone: "stop" },
  info: { label: "Noted", tone: "ink" },
};

const WHO: Record<AuditEntry["actor"]["role"], string> = { agent: "Agent", purchaser: "Purchaser", supplier: "Valio Aimo", gateway: "Gateway", unknown: "Unknown caller" };

export function AuditLog({ entries, showBuyer = false, empty }: { entries: Entry[]; showBuyer?: boolean; empty: string }) {
  if (!entries.length) return <p className="rounded border border-dashed border-line px-4 py-6 text-soft">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded border border-line bg-sheet">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-soft">
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Who</th>
            <th className="px-3 py-2 font-medium">Outcome</th>
            <th className="px-3 py-2 font-medium">Rule</th>
            <th className="px-3 py-2 font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-b border-line align-top last:border-0">
              <td className="whitespace-nowrap px-3 py-2 text-soft">{fmtDateTime(e.at)}</td>
              <td className="px-3 py-2">
                {WHO[e.actor.role]}
                <span className="block text-xs text-soft">{e.actor.id}</span>
                {showBuyer && <span className="block text-xs text-soft">{e.buyerId ? `for ${e.buyerId}` : "no buyer"}</span>}
              </td>
              <td className="px-3 py-2">
                <span className={`inline-block whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-xs font-bold ${TONE[OUTCOME[e.outcome].tone]}`}>{OUTCOME[e.outcome].label}</span>
              </td>
              <td className="px-3 py-2">{e.ruleName ?? <span className="text-soft">none</span>}</td>
              <td className="px-3 py-2">
                {e.reason}
                <span className="mt-0.5 block font-mono text-xs text-soft">
                  {e.id}
                  {e.orderId ? ` ${e.orderId}` : ""}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
