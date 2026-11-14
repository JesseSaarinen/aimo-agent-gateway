// The buyer's mandate: what an agent may order on its own, what needs the purchaser, and what is never allowed.
// Six rules, all checked here on the server. Every check returns findings: a decision, the rule and a one-line
// reason a purchaser can read. No finding means the rule is satisfied.
//
//   1. Max EUR per order and a weekly budget      -> over either: needs approval
//   2. Delivery sites and the latest delivery date -> outside: blocked
//   3. Required product properties                 -> product fails one: blocked
//   4. Substitutions                               -> a substitute Valio lists, same brand: alone; other brand: ask;
//                                                     only the same product group: always ask; other type: never
//   5. Missing allergen data                       -> always ask
//   6. Order cut-off passed                        -> blocked (the offer lists alternatives)
import { actorOf, DEMO_BUYER, DEMO_MANDATE_ID, getBuyer, requireRole, type Caller } from "./agents";
import { audit } from "./audit";
import { checkRequirement, productName, requirementNote, REQUIREMENTS, type Product, type Requirement, type Verdict } from "./catalog";
import { addDays, fmtDay } from "./dates";
import type { Problem } from "./quote";
import { Refusal, type Decision, type Finding, type RuleId } from "./rules";
import { store } from "./store";

export type Mandate = {
  id: string;
  buyerId: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  maxOrderEur: number; // rule 1
  weeklyBudgetEur: number; // rule 1, Monday to Sunday
  deliverySites: string[]; // rule 2, site ids
  latestDeliveryDays: number; // rule 2, how many days ahead a delivery may be
  requiredProperties: Requirement[]; // rule 3, applies to every product
  substitutions: { sameTypeSameBrand: Decision; otherBrand: Decision; otherType: Decision }; // rule 4
};

export type MandatePatch = Partial<Pick<Mandate, "maxOrderEur" | "weeklyBudgetEur" | "deliverySites" | "latestDeliveryDays" | "requiredProperties" | "substitutions">>;

const seed = (id: string, buyerId: string): Mandate => ({
  id,
  buyerId,
  version: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: "seed",
  maxOrderEur: 5000,
  weeklyBudgetEur: 15000,
  deliverySites: DEMO_BUYER.sites.map((s) => s.id),
  latestDeliveryDays: 14,
  requiredProperties: ["lactose_free"],
  substitutions: { sameTypeSameBrand: "allowed", otherBrand: "needs_approval", otherType: "blocked" },
});

export async function getMandate(id: string): Promise<Mandate> {
  const found = await store.get<Mandate>("mandates", id);
  if (found) return found;
  // The demo buyer's mandate, or a fresh copy of it for a break-it sandbox buyer
  const sandbox = /^mandate-sbx-([a-z0-9]+)$/.exec(id);
  if (id !== DEMO_MANDATE_ID && !sandbox) throw new Error(`No mandate ${id}`);
  await store.putIfAbsent("mandates", id, seed(id, sandbox ? `sbx-${sandbox[1]}` : DEMO_BUYER.id));
  return (await store.get<Mandate>("mandates", id))!;
}

/** Only the buyer's purchaser can change the mandate. The change takes effect on the next order. */
export async function updateMandate(caller: Caller, patch: MandatePatch): Promise<Mandate> {
  const purchaser = await requireRole(caller, ["purchaser"], "mandate_update", "mandate_authority", "Only the buyer's purchaser can change the mandate.");
  const current = await getMandate(purchaser.mandateId);
  const sites = getBuyer(purchaser.buyerId)?.sites.map((s) => s.id) ?? [];
  const foreign = patch.deliverySites?.filter((s) => !sites.includes(s)) ?? [];
  if (foreign.length) throw new Refusal("invalid_request", `Unknown delivery site: ${foreign.join(", ")}. This buyer's sites: ${sites.join(", ")}`, 400);

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, to] of Object.entries(patch) as [keyof MandatePatch, unknown][]) {
    if (to !== undefined && JSON.stringify(current[field]) !== JSON.stringify(to)) changes[field] = { from: current[field], to };
  }
  if (Object.keys(changes).length === 0) return current;

  const next: Mandate = { ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString(), updatedBy: purchaser.id };
  await store.put("mandates", next.id, next);
  await audit({
    buyerId: purchaser.buyerId,
    actor: actorOf(purchaser),
    action: "mandate_updated",
    outcome: "info",
    rule: null,
    reason: `Mandate changed to version ${next.version}: ${Object.entries(changes).map(([f, c]) => `${f} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join("; ")}`,
    data: { changes },
  });
  return next;
}

export const eur = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** The mandate as sentences, for the purchaser's screen and for agents that want to know their limits. */
export function describeMandate(m: Mandate): string[] {
  const act = { allowed: "the agent may order alone", needs_approval: "the purchaser must approve", blocked: "never allowed" };
  return [
    `One order may be at most ${eur(m.maxOrderEur)}, and all orders in a week (Mon-Sun) at most ${eur(m.weeklyBudgetEur)}. Above either, the purchaser must approve.`,
    `Deliveries only to: ${m.deliverySites.join(", ")}, and at most ${m.latestDeliveryDays} days ahead.`,
    m.requiredProperties.length
      ? `Every product must be: ${m.requiredProperties.map((r) => REQUIREMENTS[r]).join(", ")}.`
      : "No product properties are required.",
    `Substitutes that Valio Aimo lists for a product: same brand: ${act[m.substitutions.sameTypeSameBrand]}; another brand: ${act[m.substitutions.otherBrand]}. A product that only shares the product group: the purchaser must approve. Another product type: ${act[m.substitutions.otherType]}.`,
    "A product without allergen data always needs the purchaser's approval when an allergen property is required.",
    "A product whose order cut-off has passed can't be ordered for that date. The gateway lists alternatives instead.",
  ];
}

// Rule 1
export function checkSpend(m: Mandate, orderTotal: number, weekSpent: number, weekFrom: string): Finding[] {
  const out: Finding[] = [];
  if (orderTotal > m.maxOrderEur) {
    out.push({ rule: "order_limit", decision: "needs_approval", reason: `Order total ${eur(orderTotal)} is over the ${eur(m.maxOrderEur)} limit for one order` });
  }
  if (weekSpent + orderTotal > m.weeklyBudgetEur) {
    out.push({
      rule: "weekly_budget",
      decision: "needs_approval",
      reason: `This order (${eur(orderTotal)}) would bring the week to ${eur(weekSpent + orderTotal)}, over the ${eur(m.weeklyBudgetEur)} weekly budget (${eur(weekSpent)} already ordered since ${fmtDay(weekFrom)})`,
    });
  }
  return out;
}

// Rule 2
export function checkDelivery(m: Mandate, site: string, date: string, today: string): Finding[] {
  const out: Finding[] = [];
  if (!m.deliverySites.includes(site)) {
    out.push({ rule: "delivery_site", decision: "blocked", reason: `Delivery site "${site}" is not in the mandate (allowed: ${m.deliverySites.join(", ")})` });
  }
  const latest = addDays(today, m.latestDeliveryDays);
  if (date < today) out.push({ rule: "delivery_date", decision: "blocked", reason: `Delivery date ${fmtDay(date)} is in the past` });
  else if (date > latest) {
    out.push({
      rule: "delivery_date",
      decision: "blocked",
      reason: `Delivery on ${fmtDay(date)} is later than the mandate allows (latest ${fmtDay(latest)}, ${m.latestDeliveryDays} days ahead)`,
    });
  }
  return out;
}

const ALLERGEN_REQUIREMENTS: Requirement[] = ["lactose_free", "gluten_free", "milk_free", "egg_free", "nut_free", "fish_free", "soy_free"];

// Rules 3 and 5. `extra` are properties the agent asked for on top of the mandate's own.
export function checkProperties(m: Mandate, p: Product, extra: Requirement[] = []): { requirements: Record<string, Verdict>; notes: string[]; findings: Finding[] } {
  const requirements: Record<string, Verdict> = {};
  const notes: string[] = [];
  const findings: Finding[] = [];
  for (const r of new Set([...m.requiredProperties, ...extra])) {
    const verdict = (requirements[r] = checkRequirement(p, r));
    notes.push(requirementNote(p, r));
    if (verdict === "no") {
      findings.push({ rule: "required_properties", decision: "blocked", reason: `${productName(p)} does not meet "${REQUIREMENTS[r]}" according to the product data` });
    } else if (verdict === "unknown") {
      findings.push(
        ALLERGEN_REQUIREMENTS.includes(r)
          ? { rule: "missing_allergen_data", decision: "needs_approval", reason: `${productName(p)} has no allergen data, so "${REQUIREMENTS[r]}" can't be confirmed` }
          : { rule: "required_properties", decision: "needs_approval", reason: `"${REQUIREMENTS[r]}" can't be confirmed for ${productName(p)} from the product data` },
      );
    }
  }
  return { requirements, notes, findings };
}

// Rule 4
const norm = (s: string) => s.trim().toLowerCase();

/**
 * How a substitute relates to the product it replaces. `listed`: Valio names it as a substitute. `sameType`: listed, or the
 * same category code. A category is a product group, not a product: on live stock one code holds diced tomato and shredded
 * cabbage (17443), another salmon and saithe (18701). So only a listed substitute counts as like-for-like.
 */
export function relationOf(original: Product, substitute: Product) {
  const listed = original.substitutes.includes(substitute.id); // Valio's own pairs are one-way
  const sameType = listed || original.category === substitute.category;
  const sameBrand =
    (!!original.brand && !!substitute.brand && norm(original.brand) === norm(substitute.brand)) || norm(original.vendor) === norm(substitute.vendor);
  return { listed, sameType, sameBrand };
}

const brandOf = (p: Product) => p.brand?.trim() || p.vendor;

export function checkSubstitution(m: Mandate, original: Product, substitute: Product): Finding[] {
  if (original.id === substitute.id) return [];
  const rel = relationOf(original, substitute);
  let [decision, why]: [Decision, string] = !rel.sameType
    ? [m.substitutions.otherType, `is another product type than ${productName(original)}`]
    : rel.sameBrand
      ? [m.substitutions.sameTypeSameBrand, `is the same type and brand as ${productName(original)}`]
      : [m.substitutions.otherBrand, `is another brand (${brandOf(substitute)}) than ${productName(original)} (${brandOf(original)})`];
  // Sharing a product group is not proof that it fits, so a person decides. The mandate can be stricter, never looser.
  if (rel.sameType && !rel.listed) {
    if (decision === "allowed") decision = "needs_approval";
    why = `is in the same product group as ${productName(original)}, but Valio Aimo does not list it as a substitute${rel.sameBrand ? "" : `, and it is another brand (${brandOf(substitute)})`}`;
  }
  return decision === "allowed" ? [] : [{ rule: "substitution", decision, reason: `${productName(substitute)} ${why}` }];
}

// Rule 6, plus the plain supply facts (stock, price) that stop a line whatever the mandate says.
const PROBLEM_RULE: Record<Problem["code"], RuleId> = {
  cutoff: "order_cutoff",
  stock: "stock",
  unavailable: "stock",
  price: "price",
  sales_block: "sales_block",
  unit_conversion: "unit_conversion",
  unknown_product: "unknown_product",
};
export const supplyFindings = (problems: Problem[]): Finding[] =>
  problems.map((p) => ({ rule: PROBLEM_RULE[p.code], decision: "blocked" as const, reason: p.text }));
