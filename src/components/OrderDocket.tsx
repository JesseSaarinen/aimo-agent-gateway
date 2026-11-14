"use client";
// One order as a docket: what was asked, what the gateway decided per line and why, and (for the
// purchaser) the buttons to approve, reject or take an option. The same docket is read-only for Valio Aimo.
import { useState } from "react";
import { fmtDateTime, fmtDay } from "@/lib/dates";
import type { Option } from "@/lib/options";
import type { DecisionInput, OrderLine, orderView } from "@/lib/orders";
import { RULES } from "@/lib/rule-names";
import { money, qty, TONE, type Tone } from "./client";

export type OrderView = ReturnType<typeof orderView>;

const ORDER_STAMP: Record<OrderView["status"], { label: string; tone: Tone; spine: string }> = {
  awaiting_approval: { label: "Waits for the purchaser", tone: "wait", spine: "border-l-wait" },
  confirmed: { label: "Confirmed", tone: "go", spine: "border-l-go" },
  rejected: { label: "Nothing ordered", tone: "stop", spine: "border-l-stop" },
};

function lineStamp(l: OrderLine): { label: string; tone: Tone } {
  if (l.status === "confirmed") {
    const how = l.resolution?.action;
    return { label: how === "approved" ? "Approved by the purchaser" : how === "option_picked" ? `Option ${l.resolution?.option} taken` : "Confirmed alone", tone: "go" };
  }
  if (l.status === "awaiting_approval") return { label: "Needs approval", tone: "wait" };
  if (l.status === "rejected") return { label: "Rejected", tone: "stop" };
  return { label: l.open ? "Blocked: pick an option" : "Blocked", tone: "stop" };
}

export const Chip = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <span className={`inline-block whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-xs font-bold ${TONE[tone]}`}>{children}</span>
);

const button = "rounded border px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-teal bg-teal text-white hover:bg-teal-deep`;
const quiet = `${button} border-line bg-sheet text-ink hover:border-ink`;

function OptionRow({ option, onTake, busy }: { option: Option; onTake?: () => void; busy: boolean }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-line py-2.5 first:border-0">
      <div className="min-w-0 flex-1 basis-80">
        <p className="font-medium">
          Option {option.rank}: {option.parts.map((p) => `${qty(p.quantity, p.salesUnit)} of ${p.name}`).join(" + ")}
        </p>
        <p className="text-sm text-soft">{option.reason}</p>
        {option.findings.map((f, i) => (
          <p key={i} className="text-sm text-wait">
            {RULES[f.rule]}: {f.reason}
          </p>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="font-semibold">{money(option.total)}</span>
        {onTake && (
          <button type="button" className={primary} disabled={busy} onClick={onTake}>
            Take option {option.rank}
          </button>
        )}
      </div>
    </li>
  );
}

export function OrderDocket({
  order,
  onDecide,
  showBuyer = false,
}: {
  order: OrderView;
  /** Given on the purchaser's desk only. Resolves with an error text when the gateway refuses. */
  onDecide?: (decision: DecisionInput) => Promise<string | null>;
  showBuyer?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ line: number; text: string } | null>(null);
  const stamp = ORDER_STAMP[order.status];

  const decide = async (decision: DecisionInput) => {
    if (!onDecide) return;
    setBusy(true);
    const text = await onDecide(decision);
    setProblem(text ? { line: decision.line, text } : null);
    setBusy(false);
  };

  return (
    <article className={`rounded border border-l-4 border-line bg-sheet ${stamp.spine}`}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-3">
        <div>
          <h3 className="font-bold">
            Delivery {fmtDay(order.deliveryDate)} to {order.deliverySite}
          </h3>
          <p className="text-sm text-soft">
            Placed {fmtDateTime(order.placedAt)} by {order.agentId}
            {showBuyer ? ` for ${order.buyerId}` : ""}
          </p>
          <p className="font-mono text-xs text-soft">{order.id}</p>
        </div>
        <div className="text-right">
          <Chip tone={stamp.tone}>{stamp.label}</Chip>
          <p className="mt-1 text-sm">
            Confirmed <span className="font-semibold">{money(order.totals.confirmed)}</span>
          </p>
          {order.totals.awaitingApproval > 0 && <p className="text-sm text-wait">Waiting {money(order.totals.awaitingApproval)}</p>}
        </div>
      </header>

      {order.findings.length > 0 && (
        <p className="border-b border-wait bg-wait-bg px-4 py-2 text-sm text-wait">
          {order.findings.map((f) => `${RULES[f.rule]}: ${f.reason}`).join(". ")}. Every line of this order needs approval.
        </p>
      )}

      <ol>
        {order.lines.map((l) => {
          const s = lineStamp(l);
          // A blocked or rejected line delivers nothing, so it shows no quantity and no price of its own
          const delivered = l.fulfilment.length ? l.fulfilment : l.offered && l.status === "awaiting_approval" ? [l.offered] : [];
          return (
            <li key={l.line} className="border-b border-line px-4 py-3 last:border-0">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0 flex-1 basis-72">
                  <p className="font-medium">
                    <span className="mr-2 text-soft">{l.line}</span>
                    {l.name ?? l.productId}
                  </p>
                  <p className="text-sm text-soft">
                    Asked for {l.requested.amount} {l.requested.unit}
                    {delivered.map((p) => `; ${l.status === "confirmed" ? "delivers" : "offered as"} ${qty(p.quantity, p.salesUnit)}${p.productId !== l.productId ? ` of ${p.name}` : ""} at ${money(p.unitPrice)}${p.deliveryDate !== order.deliveryDate ? ` on ${fmtDay(p.deliveryDate)}` : ""}`).join("")}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {delivered.length > 0 && <span className="font-semibold">{money(delivered.reduce((sum, p) => sum + p.total, 0))}</span>}
                  <Chip tone={s.tone}>{s.label}</Chip>
                </div>
              </div>

              {l.status !== "confirmed" &&
                l.findings.map((f, i) => (
                  <p key={i} className={`mt-1.5 text-sm ${f.decision === "blocked" ? "text-stop" : "text-wait"}`}>
                    <span className="font-semibold">{RULES[f.rule]}.</span> {f.reason}
                  </p>
                ))}
              {l.resolution && l.resolution.by.role === "purchaser" && (
                <p className="mt-1.5 text-sm text-soft">
                  Decided by {l.resolution.by.id}, {fmtDateTime(l.resolution.at)}
                  {l.resolution.note ? `: "${l.resolution.note}"` : ""}
                </p>
              )}

              {l.open && (
                <div className="mt-3 rounded border border-line bg-paper px-3 py-1">
                  {l.options.length > 0 ? (
                    <ul>
                      {l.options.map((o) => (
                        <OptionRow key={o.rank} option={o} busy={busy} onTake={onDecide && o.decision !== "blocked" ? () => decide({ line: l.line, action: "pick_option", option: o.rank }) : undefined} />
                      ))}
                    </ul>
                  ) : l.findings.some((f) => f.rule !== "order_limit" && f.rule !== "weekly_budget") ? (
                    <p className="py-2 text-sm text-soft">The gateway found no other product it could offer for this line.</p>
                  ) : (
                    <p className="py-2 text-sm text-soft">The line itself is inside the mandate. It waits because of the order as a whole.</p>
                  )}
                  {onDecide && (
                    <div className="flex flex-wrap gap-2 border-t border-line py-2.5">
                      {l.status === "awaiting_approval" && (
                        <button type="button" className={l.options.length ? quiet : primary} disabled={busy} onClick={() => decide({ line: l.line, action: "approve" })}>
                          Approve as asked
                        </button>
                      )}
                      <button type="button" className={quiet} disabled={busy} onClick={() => decide({ line: l.line, action: "reject" })}>
                        Reject line
                      </button>
                    </div>
                  )}
                  {problem?.line === l.line && (
                    <p role="alert" className="border-t border-stop py-2 text-sm text-stop">
                      {problem.text}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </article>
  );
}
