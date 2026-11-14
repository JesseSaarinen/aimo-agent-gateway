// The names of every rule the gateway can cite, and the refusal it raises when a rule stops a request outright.
import { audit, type Actor, type AuditEntry } from "./audit";
import { RULES, type RuleId } from "./rule-names";

export { RULES, type RuleId };

/** What a rule says about a line or an order. */
export type Decision = "allowed" | "needs_approval" | "blocked";
export type Finding = { rule: RuleId; decision: Decision; reason: string };

const RANK: Record<Decision, number> = { allowed: 0, needs_approval: 1, blocked: 2 };
export const worst = (findings: { decision: Decision }[]): Decision =>
  findings.reduce<Decision>((w, f) => (RANK[f.decision] > RANK[w] ? f.decision : w), "allowed");

/** A request the gateway refuses outright. Final: asking again with the same input gets the same answer. */
export class Refusal extends Error {
  constructor(
    readonly rule: RuleId,
    readonly reason: string,
    readonly http: number,
    readonly auditId: string | null = null,
  ) {
    super(reason);
    this.name = "Refusal";
  }
  toJSON() {
    return { status: "refused" as const, rule: this.rule, ruleName: RULES[this.rule], reason: this.reason, final: true, auditId: this.auditId };
  }
}

/** Write the audit entry, then refuse. */
export async function refuse(input: {
  rule: RuleId;
  reason: string;
  http: number;
  actor: Actor;
  buyerId: string | null;
  action: string;
  offerId?: string;
  orderId?: string;
  line?: number;
  data?: AuditEntry["data"];
}): Promise<never> {
  const { http, ...entry } = input;
  const written = await audit({ ...entry, outcome: "refused" });
  throw new Refusal(input.rule, input.reason, http, written.id);
}
