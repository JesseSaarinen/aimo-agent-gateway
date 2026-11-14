// Orders and approvals.
// place_order takes a signed offer and refuses: no offer, a bad signature, an expired offer, an offer made
// for another agent. A second order on the same offer returns the first one and creates nothing.
// The mandate and the stock are checked again at this moment, so the offer's own verdicts are only a preview:
// raise the limit and the same offer goes through; lose the stock and the line is held back.
// Lines that pass alone are confirmed, exceptions wait for the purchaser, blocked lines are reported with
// their options. Only the buyer's purchaser can approve, reject or pick an option. Every decision is logged.
import { actorOf, buyerIdOf, requireRole, type Caller } from "./agents";
import { audit, type Actor } from "./audit";
import { getProduct } from "./catalog";
import { fmtDay, helsinkiDate } from "./dates";
import { checkDelivery, checkProperties, checkSpend, checkSubstitution, eur, getMandate, supplyFindings } from "./mandate";
import { getStoredOffer, orderIdFor, type Offer, type OfferLine } from "./offers";
import type { Option, OptionPart } from "./options";
import { checkSupply, round2, supplyProblems } from "./quote";
import { Refusal, refuse, worst, type Decision, type Finding } from "./rules";
import { verifyOfferToken } from "./signing";
import { weekSpend } from "./spend";
import { store } from "./store";

export type OrderLineStatus = "confirmed" | "awaiting_approval" | "blocked" | "rejected";

export type OrderLine = {
  line: number;
  productId: string;
  name: string | null;
  requested: { amount: number; unit: string };
  substituteFor: string | null;
  status: OrderLineStatus;
  /** true while the purchaser can still decide this line (approve, reject or pick an option) */
  open: boolean;
  decision: Decision; // at the moment the order was placed, against the mandate and stock of that moment
  findings: Finding[];
  offered: OptionPart | null; // what the offer priced for this line
  fulfilment: OptionPart[]; // what will be delivered. Empty until the line is confirmed.
  total: number; // of the fulfilment, EUR excl. VAT
  options: Option[];
  resolution: { action: "confirmed_alone" | "approved" | "rejected" | "option_picked"; option: number | null; by: Actor; at: string; note: string | null } | null;
};

export type Order = {
  id: string;
  offerId: string;
  buyerId: string;
  agentId: string;
  deliverySite: string;
  deliveryDate: string;
  placedAt: string;
  updatedAt: string;
  mandateVersion: number; // the mandate version the order was checked against
  status: "confirmed" | "awaiting_approval" | "rejected";
  findings: Finding[]; // about the order as a whole: order limit and weekly budget
  lines: OrderLine[];
  totals: { confirmed: number; awaitingApproval: number };
};

export type DecisionInput = { line: number; action: "approve" | "reject" | "pick_option"; option?: number; note?: string };

function offeredPart(l: OfferLine, deliveryDate: string): OptionPart | null {
  if (l.quantity === null || l.unitPrice === null || l.total === null || l.name === null) return null;
  return {
    productId: l.productId,
    name: l.name,
    brand: l.brand,
    quantity: l.quantity,
    salesUnit: l.salesUnit,
    unitPrice: l.unitPrice,
    total: l.total,
    covers: l.delivers ?? l.quantity,
    deliveryDate,
    origin: l.claims.origin,
    labels: l.claims.labels,
    allergenDataKnown: l.claims.allergenDataKnown,
  };
}

function settle(order: Order): Order {
  for (const l of order.lines) l.total = l.status === "confirmed" ? round2(l.fulfilment.reduce((s, p) => s + p.total, 0)) : 0;
  order.totals = {
    confirmed: round2(order.lines.reduce((s, l) => s + l.total, 0)),
    awaitingApproval: round2(order.lines.reduce((s, l) => s + (l.status === "awaiting_approval" ? (l.offered?.total ?? 0) : 0), 0)),
  };
  order.status = order.lines.some((l) => l.open) ? "awaiting_approval" : order.lines.some((l) => l.status === "confirmed") ? "confirmed" : "rejected";
  order.updatedAt = new Date().toISOString();
  return order;
}

const counts = (order: Order) => {
  const n = (s: OrderLineStatus) => order.lines.filter((l) => l.status === s).length;
  return { confirmed: n("confirmed"), awaitingApproval: n("awaiting_approval"), blocked: n("blocked"), rejected: n("rejected") };
};

function describe(order: Order): string {
  const c = counts(order);
  const parts = [
    c.confirmed ? `${c.confirmed} line${c.confirmed === 1 ? "" : "s"} confirmed (${eur(order.totals.confirmed)})` : "",
    c.awaitingApproval ? `${c.awaitingApproval} waiting for the purchaser's approval` : "",
    c.blocked ? `${c.blocked} blocked` : "",
    c.rejected ? `${c.rejected} rejected by the purchaser` : "",
  ].filter(Boolean);
  return `Order ${order.id} for ${fmtDay(order.deliveryDate)} to ${order.deliverySite}: ${parts.join(", ")}.`;
}

export const orderView = (order: Order) => ({ ...order, summary: counts(order), message: describe(order) });

export async function placeOrder(caller: Caller, input: { offerId?: string; offerToken?: string }) {
  const agent = await requireRole(caller, ["agent"], "place_order", "access", "Orders are placed by agents. Use an agent key.");
  const who = { actor: actorOf(agent), buyerId: agent.buyerId, action: "place_order" };

  // 1. The order must point at an offer
  let token = input.offerToken?.trim() || null;
  if (!token && input.offerId) {
    token = (await getStoredOffer(input.offerId))?.token ?? null;
    if (!token) {
      await refuse({ ...who, rule: "offer_required", http: 404, reason: `There is no offer ${input.offerId}. An order needs a valid offer from request_offer.`, offerId: input.offerId });
    }
  }
  if (!token) await refuse({ ...who, rule: "offer_required", http: 400, reason: "An order must refer to an offer. Call request_offer first, then place_order with its offerId." });

  // 2. ... that this gateway signed, that nobody changed, and that has not expired
  const v = await verifyOfferToken(token);
  if (!v.valid) {
    await refuse({ ...who, rule: v.rule, reason: v.reason, http: v.problem === "expired" ? 410 : 422, offerId: v.offer?.id ?? input.offerId });
    throw new Error("unreachable");
  }
  const offer: Offer = v.offer;
  if (input.offerId && input.offerId !== offer.id) {
    await refuse({ ...who, rule: "offer_signature", http: 422, reason: `The signed offer is ${offer.id}, not ${input.offerId}.`, offerId: input.offerId });
  }

  // 3. ... and that was made for this agent
  if (offer.agentId !== agent.id || offer.buyerId !== agent.buyerId) {
    await refuse({ ...who, rule: "offer_owner", http: 403, reason: "This offer was made for another agent. Only the agent an offer was made for can order on it.", offerId: offer.id });
  }

  // 4. One order per offer. A repeat gets the first order back.
  const id = orderIdFor(offer.id);
  const replay = async (existing: Order) => {
    const entry = await audit({
      ...who,
      action: "order_replayed",
      outcome: "refused",
      rule: "offer_replay",
      reason: `Offer ${offer.id} was already ordered as ${existing.id}. No new order was created.`,
      offerId: offer.id,
      orderId: existing.id,
    });
    return { replayed: true, rule: "offer_replay" as const, auditId: entry.id, notice: entry.reason, order: orderView(existing) };
  };
  const existing = await store.get<Order>("orders", id);
  if (existing) return replay(existing);

  // 5. The mandate as it is now, not as it was when the offer was made
  const mandate = await getMandate(agent.mandateId);
  const now = new Date();
  const [outside] = checkDelivery(mandate, offer.deliverySite, offer.deliveryDate, helsinkiDate(now));
  if (outside) await refuse({ ...who, rule: outside.rule, reason: outside.reason, http: 403, offerId: offer.id });

  // 6. Stock and cut-off again: one availability call for the lines that could be priced
  const priced = offer.lines.filter((l) => offeredPart(l, offer.deliveryDate));
  const { supply } = await checkSupply(priced.map((l) => l.productId), offer.deliveryDate);

  const judged = offer.lines.map((l) => {
    const p = getProduct(l.productId);
    const offered = offeredPart(l, offer.deliveryDate);
    const original = l.substituteFor ? getProduct(l.substituteFor) : null;
    const findings: Finding[] =
      !p || !offered
        ? l.findings.filter((f) => f.decision === "blocked") // could not be priced: nothing to re-check
        : [
            ...supplyFindings(supplyProblems(supply(l.productId), offered.quantity, offered.salesUnit, offer.deliveryDate)),
            ...checkProperties(mandate, p, offer.requirements).findings,
            ...(original ? checkSubstitution(mandate, original, p) : []),
            ...(l.substituteFor && !original ? l.findings.filter((f) => f.rule === "unknown_product") : []),
          ];
    return { l, offered, findings, decision: worst(findings) };
  });

  // 7. Rule 1 on the whole order: the limit for one order and the weekly budget
  const orderTotal = round2(judged.reduce((s, j) => s + (j.decision !== "blocked" ? (j.offered?.total ?? 0) : 0), 0));
  const { spent, weekFrom } = await weekSpend(agent.buyerId, now);
  const orderFindings = checkSpend(mandate, orderTotal, spent, weekFrom);

  const lines: OrderLine[] = judged.map(({ l, offered, findings, decision }) => {
    const held = decision === "allowed" && orderFindings.length > 0;
    const status: OrderLineStatus = decision === "blocked" ? "blocked" : decision === "needs_approval" || held ? "awaiting_approval" : "confirmed";
    return {
      line: l.line,
      productId: l.productId,
      name: l.name,
      requested: l.requested,
      substituteFor: l.substituteFor,
      status,
      open: status === "awaiting_approval" || (status === "blocked" && l.options.some((o) => o.decision !== "blocked")),
      decision: held ? "needs_approval" : decision,
      findings: held ? orderFindings : findings,
      offered,
      fulfilment: status === "confirmed" ? [offered!] : [],
      total: 0,
      options: l.options,
      resolution: status === "confirmed" ? { action: "confirmed_alone", option: null, by: { role: "gateway", id: "mandate" }, at: now.toISOString(), note: null } : null,
    };
  });

  const order = settle({
    id,
    offerId: offer.id,
    buyerId: offer.buyerId,
    agentId: offer.agentId,
    deliverySite: offer.deliverySite,
    deliveryDate: offer.deliveryDate,
    placedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    mandateVersion: mandate.version,
    status: "awaiting_approval",
    findings: orderFindings,
    lines,
    totals: { confirmed: 0, awaitingApproval: 0 },
  });

  if (!(await store.putIfAbsent("orders", id, order))) return replay((await store.get<Order>("orders", id))!);

  // 8. One audit entry per line, and one for the order
  for (const l of order.lines) {
    const what = `Line ${l.line} (${l.offered ? `${l.offered.quantity} ${l.offered.salesUnit} of ` : ""}${l.name ?? l.productId})`;
    await audit({
      ...who,
      action: l.status === "confirmed" ? "line_confirmed" : l.status === "blocked" ? "line_blocked" : "line_held",
      outcome: l.status === "confirmed" ? "allowed" : l.status === "blocked" ? "blocked" : "needs_approval",
      rule: l.findings[0]?.rule ?? null,
      reason:
        l.status === "confirmed"
          ? `${what} is inside the mandate and in stock: confirmed without a human, ${eur(l.total)}`
          : `${what} ${l.status === "blocked" ? "can't be ordered" : "waits for the purchaser"}: ${l.findings.map((f) => f.reason).join("; ")}`,
      offerId: offer.id,
      orderId: order.id,
      line: l.line,
    });
  }
  await audit({
    ...who,
    action: "order_placed",
    outcome: order.status === "confirmed" ? "allowed" : order.status === "awaiting_approval" ? "needs_approval" : "blocked",
    rule: orderFindings[0]?.rule ?? null,
    reason: `${describe(order)} Checked against mandate version ${mandate.version}.`,
    offerId: offer.id,
    orderId: order.id,
  });

  return { replayed: false, rule: null, auditId: null, notice: null, order: orderView(order) };
}

const mayRead = (caller: Caller, order: Order) =>
  caller.role === "supplier" || (caller.role === "purchaser" && caller.buyerId === order.buyerId) || (caller.role === "agent" && caller.id === order.agentId);

export async function getOrder(caller: Caller, id: string): Promise<Order> {
  const order = await store.get<Order>("orders", id);
  if (!order || !mayRead(caller, order)) {
    return refuse({ rule: "access", reason: `No order ${id} for this caller.`, http: 404, actor: actorOf(caller), buyerId: buyerIdOf(caller), action: "read_order", orderId: id });
  }
  return order;
}

/** Newest first. An agent sees its own orders, the purchaser the buyer's, Valio Aimo all of them. */
export async function listOrders(caller: Caller): Promise<Order[]> {
  return (await store.list<Order>("orders", 500)).filter((o) => mayRead(caller, o));
}

/** Check that every part can still be delivered. One availability call per delivery date. */
async function stillDeliverable(parts: OptionPart[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const date of [...new Set(parts.map((p) => p.deliveryDate))]) {
    const onDate = parts.filter((p) => p.deliveryDate === date);
    const { supply } = await checkSupply(onDate.map((p) => p.productId), date);
    for (const p of onDate) findings.push(...supplyFindings(supplyProblems(supply(p.productId), p.quantity, p.salesUnit, date)));
  }
  return findings;
}

/** The purchaser approves, rejects, or picks an option for one line. An agent key can never do this. */
export async function decideLine(caller: Caller, orderId: string, input: DecisionInput) {
  const ref = { orderId, line: input.line };
  const purchaser = await requireRole(
    caller,
    ["purchaser"],
    "order_decision",
    "approval_authority",
    "Only the buyer's purchaser can approve, reject or change an order line. An agent can't approve its own order.",
    ref,
  );
  const who = { actor: actorOf(purchaser), buyerId: purchaser.buyerId, action: "order_decision", ...ref };
  const order = await store.get<Order>("orders", orderId);
  if (!order || order.buyerId !== purchaser.buyerId) return refuse({ ...who, rule: "access", http: 404, reason: `No order ${orderId} for this buyer.` });
  const l = order.lines.find((x) => x.line === input.line);
  if (!l) throw new Refusal("invalid_request", `Order ${orderId} has no line ${input.line}`, 400);
  if (!l.open) throw new Refusal("invalid_request", `Line ${l.line} is already ${l.status} and can't be changed`, 409);

  const name = l.name ?? l.productId;
  const heldBy = l.findings[0]?.rule ?? null;
  const close = (status: OrderLineStatus, action: NonNullable<OrderLine["resolution"]>["action"], fulfilment: OptionPart[]) => {
    l.status = status;
    l.open = false;
    l.fulfilment = fulfilment;
    l.resolution = { action, option: action === "option_picked" ? input.option! : null, by: actorOf(purchaser), at: new Date().toISOString(), note: input.note ?? null };
  };
  const save = async (entry: { action: string; outcome: "approved" | "rejected"; reason: string }) => {
    settle(order);
    await store.put("orders", order.id, order);
    await audit({ ...who, ...entry, rule: heldBy, offerId: order.offerId });
    return orderView(order);
  };
  const note = input.note ? ` Note: ${input.note}` : "";

  if (input.action === "reject") {
    close("rejected", "rejected", []);
    return save({ action: "line_rejected", outcome: "rejected", reason: `The purchaser rejected line ${l.line} (${name}).${note}` });
  }

  if (input.action === "approve") {
    if (l.status !== "awaiting_approval" || !l.offered) {
      const why = l.findings.find((f) => f.decision === "blocked");
      return refuse({
        ...who,
        rule: why?.rule ?? "invalid_request",
        http: 409,
        reason: `Line ${l.line} can't be approved as it is: ${why?.reason ?? "it could not be priced"}. Pick one of its options or reject it.`,
        offerId: order.offerId,
      });
    }
    const gone = await stillDeliverable([l.offered]);
    if (gone.length) {
      // What was approved can no longer be delivered. The line stays open only if it has options to pick from.
      l.status = "blocked";
      l.decision = "blocked";
      l.findings = [...gone, ...l.findings];
      l.open = l.options.some((o) => o.decision !== "blocked");
      settle(order);
      await store.put("orders", order.id, order);
      return refuse({ ...who, rule: gone[0].rule, http: 409, reason: `Line ${l.line} could not be approved: ${gone[0].reason}`, offerId: order.offerId });
    }
    close("confirmed", "approved", [l.offered]);
    return save({
      action: "line_approved",
      outcome: "approved",
      reason: `The purchaser approved line ${l.line} (${l.offered.quantity} ${l.offered.salesUnit} of ${name}, ${eur(l.offered.total)}), held by: ${l.findings.map((f) => f.reason).join("; ")}.${note}`,
    });
  }

  // pick_option
  const option = l.options.find((o) => o.rank === input.option);
  if (!option) throw new Refusal("invalid_request", `Line ${l.line} has no option ${input.option}. It has ${l.options.length} option(s).`, 400);
  if (option.decision === "blocked") {
    const why = option.findings.find((f) => f.decision === "blocked")!;
    return refuse({ ...who, rule: why.rule, http: 409, reason: `Option ${option.rank} is not allowed by the mandate: ${why.reason}`, offerId: order.offerId });
  }
  const gone = await stillDeliverable(option.parts);
  if (gone.length) {
    return refuse({ ...who, rule: gone[0].rule, http: 409, reason: `Option ${option.rank} can no longer be delivered: ${gone[0].reason}`, offerId: order.offerId });
  }
  close("confirmed", "option_picked", option.parts);
  return save({
    action: "option_picked",
    outcome: "approved",
    reason: `The purchaser picked option ${option.rank} for line ${l.line} (${name}): ${option.parts.map((p) => `${p.quantity} ${p.salesUnit} of ${p.name} for ${fmtDay(p.deliveryDate)}`).join(" + ")}, ${eur(option.total)}.${note}`,
  });
}
