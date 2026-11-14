// The audit log: every decision the gateway makes, with who, what, which rule and why.
// The buyer's purchaser reads the entries of their own company; Valio Aimo reads all of them.
import { store } from "./store";
import type { RuleId } from "./rule-names";

export type Actor = { role: "agent" | "purchaser" | "supplier" | "gateway" | "unknown"; id: string };

export type AuditOutcome = "allowed" | "needs_approval" | "blocked" | "refused" | "approved" | "rejected" | "info";

export type AuditEntry = {
  id: string;
  at: string;
  buyerId: string | null; // null when the caller could not be tied to a buyer
  actor: Actor;
  action: string; // e.g. "order_placed", "line_held", "order_refused"
  outcome: AuditOutcome;
  rule: RuleId | null;
  reason: string;
  offerId?: string;
  orderId?: string;
  line?: number;
  data?: Record<string, unknown>;
};

export async function audit(entry: Omit<AuditEntry, "id" | "at">): Promise<AuditEntry> {
  const full: AuditEntry = { id: `aud_${crypto.randomUUID().slice(0, 13)}`, at: new Date().toISOString(), ...entry };
  await store.put("audit", full.id, full);
  return full;
}

export async function listAudit(filter: { buyerId?: string; orderId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  const all = await store.list<AuditEntry>("audit", 2000);
  return all
    .filter((e) => (filter.buyerId === undefined || e.buyerId === filter.buyerId) && (filter.orderId === undefined || e.orderId === filter.orderId))
    .slice(0, filter.limit ?? 200);
}
