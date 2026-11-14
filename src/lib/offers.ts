// Offers: a basket priced at fixed prices for 30 minutes, checked against the buyer's mandate and signed.
// Each line carries its decision (alone / needs approval / blocked), the findings behind it, up to three
// ranked options when it is an exception, and the product claims Valio Aimo stands behind (origin, labels,
// whether allergen data exists). The whole offer is inside the signature.
import { actorOf, buyerIdOf, requireRole, type Caller } from "./agents";
import { audit } from "./audit";
import { getProduct, productName, type Requirement, type Verdict } from "./catalog";
import { fmtDateTime, helsinkiDate } from "./dates";
import { checkDelivery, checkProperties, checkSpend, checkSubstitution, eur, getMandate, supplyFindings } from "./mandate";
import { buildOptions, MAX_SUBSTITUTE_CANDIDATES, substituteCandidates, type Need, type Option } from "./options";
import { normaliseUnit, quoteBasket, round2 } from "./quote";
import { Refusal, refuse, worst, type Decision, type Finding } from "./rules";
import { signOffer, verifyOfferToken, type Verification } from "./signing";
import { weekSpend } from "./spend";
import { store } from "./store";

export const OFFER_VALID_MINUTES = 30;
export const MAX_OFFER_LINES = 30;
/** Across all exception lines of one offer, at most this many candidate products are quoted (in one call). */
const MAX_CANDIDATES_PER_OFFER = 600;

export type OfferLine = {
  line: number;
  productId: string;
  name: string | null;
  brand: string | null;
  requested: { amount: number; unit: string };
  substituteFor: string | null;
  quantity: number | null; // sales units, rounded up to whole units or lots
  salesUnit: string;
  lotSize: number | null;
  unitPrice: number | null; // EUR per sales unit, excl. VAT, fixed until the offer expires
  total: number | null;
  delivers: number | null; // what the quantity holds, in the requested unit
  /** What Valio Aimo's product data says. Signed with the offer. */
  claims: {
    origin: string | null;
    labels: string[];
    nutritionClaims: string[];
    allergenDataKnown: boolean;
    requirements: Record<string, Verdict>;
    /** The same verdicts as sentences that say where each comes from. */
    requirementNotes: string[];
  };
  supply: { logisticModel: string | null; orderCutoff: string | null; cutoffPassed: boolean; availableOnDate: number; deliveryReliability: number | null };
  decision: Decision;
  findings: Finding[];
  options: Option[];
  optionsNote: string | null;
};

export type Offer = {
  id: string;
  issuer: string;
  buyerId: string;
  agentId: string;
  mandateId: string;
  mandateVersion: number;
  deliverySite: string;
  deliveryDate: string;
  createdAt: string;
  expiresAt: string;
  currency: "EUR";
  vat: "excluded";
  requirements: Requirement[]; // asked for by the agent, on top of the mandate's own
  lines: OfferLine[];
  total: number; // every line that is not blocked
  /** The mandate's view of the whole order when the offer was made. It is checked again when the order is placed. */
  decision: Decision;
  findings: Finding[];
  source: string;
  pricedAt: string;
};

export type StoredOffer = { offer: Offer; token: string; keyId: string };

export type OfferRequest = {
  deliverySite: string;
  deliveryDate: string;
  lines: { productId: string; amount: number; unit: string; substituteFor?: string }[];
  requirements?: Requirement[];
};

const summary = (lines: { decision: Decision }[]) => ({
  allowed: lines.filter((l) => l.decision === "allowed").length,
  needsApproval: lines.filter((l) => l.decision === "needs_approval").length,
  blocked: lines.filter((l) => l.decision === "blocked").length,
});

export async function requestOffer(caller: Caller, input: OfferRequest) {
  const agent = await requireRole(caller, ["agent"], "request_offer", "access", "Offers are made to agents. Use an agent key.");
  const mandate = await getMandate(agent.mandateId);
  const who = { actor: actorOf(agent), buyerId: agent.buyerId, action: "request_offer" };
  const requirements = input.requirements ?? [];

  if (input.lines.length === 0 || input.lines.length > MAX_OFFER_LINES) {
    throw new Refusal("invalid_request", `An offer needs 1 to ${MAX_OFFER_LINES} lines`, 400);
  }
  const ids = input.lines.map((l) => l.productId);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated) throw new Refusal("invalid_request", `Product ${repeated} is on two lines. Put each product on one line.`, 400);

  // Rule 2 first: no offer at all for a site or date outside the mandate
  const [outside] = checkDelivery(mandate, input.deliverySite, input.deliveryDate, helsinkiDate(new Date()));
  if (outside) await refuse({ ...who, rule: outside.rule, reason: outside.reason, http: 403, data: { deliverySite: input.deliverySite, deliveryDate: input.deliveryDate } });

  // One price call and one availability call for the whole basket
  const quoted = await quoteBasket({ lines: input.lines, deliveryDate: input.deliveryDate });

  const lines: OfferLine[] = input.lines.map((req, i) => {
    const q = quoted.lines[i];
    const p = getProduct(req.productId);
    const original = req.substituteFor ? getProduct(req.substituteFor) : null;
    const props = p ? checkProperties(mandate, p, requirements) : { requirements: {}, notes: [], findings: [] };
    const findings: Finding[] = [
      ...supplyFindings(q.problems),
      ...props.findings,
      ...(req.substituteFor && !original
        ? [{ rule: "unknown_product" as const, decision: "blocked" as const, reason: `No product ${req.substituteFor} in the catalogue (substituteFor)` }]
        : []),
      ...(p && original ? checkSubstitution(mandate, original, p) : []),
    ];
    return {
      line: i + 1,
      productId: req.productId,
      name: p ? productName(p) : null,
      brand: p?.brand?.trim() ?? null,
      requested: { amount: req.amount, unit: normaliseUnit(req.unit) },
      substituteFor: req.substituteFor ?? null,
      quantity: q.salesUnitsNeeded,
      salesUnit: q.salesUnit,
      lotSize: q.lotSize,
      unitPrice: q.pricePerSalesUnit,
      total: q.total,
      delivers: q.deliveredAmount,
      claims: {
        origin: p?.origin ?? null,
        labels: p?.labels ?? [],
        nutritionClaims: p?.claims ?? [],
        allergenDataKnown: p?.allergenDataKnown ?? false,
        requirements: props.requirements,
        requirementNotes: props.notes,
      },
      supply: {
        logisticModel: q.logisticModel,
        orderCutoff: q.orderCutoff,
        cutoffPassed: q.cutoffPassed,
        availableOnDate: q.availableOnDate,
        deliveryReliability: q.deliveryReliability,
      },
      decision: worst(findings),
      findings,
      options: [],
      optionsNote: null,
    };
  });

  // Exception lines get up to three ranked options. All of them share one more price and availability call.
  const exceptions = lines.filter((l) => l.decision !== "allowed" && getProduct(l.productId));
  if (exceptions.length) {
    const cap = Math.min(MAX_SUBSTITUTE_CANDIDATES, Math.floor(MAX_CANDIDATES_PER_OFFER / exceptions.length));
    const needs: Need[] = exceptions.map((l) => {
      const reference = getProduct(l.productId)!;
      return {
        amount: l.requested.amount,
        unit: l.requested.unit,
        requirements,
        reference,
        referenceQuote: quoted.lines[l.line - 1],
        candidates: substituteCandidates(reference, mandate, requirements, cap),
      };
    });
    const { results } = await buildOptions(mandate, needs, input.deliveryDate, false);
    exceptions.forEach((l, i) => {
      l.options = results[i].options;
      l.optionsNote = results[i].possible ? null : results[i].message;
    });
  }

  const total = round2(lines.reduce((sum, l) => sum + (l.decision !== "blocked" && l.total !== null ? l.total : 0), 0));
  const now = new Date();
  const { spent, weekFrom } = await weekSpend(agent.buyerId, now);
  const findings = checkSpend(mandate, total, spent, weekFrom);
  const open = lines.filter((l) => l.decision !== "blocked");
  const offer: Offer = {
    id: `off_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    issuer: "Valio Aimo Agent Gateway (Junction 2026 demo)",
    buyerId: agent.buyerId,
    agentId: agent.id,
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    deliverySite: input.deliverySite,
    deliveryDate: input.deliveryDate,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OFFER_VALID_MINUTES * 60_000).toISOString(),
    currency: "EUR",
    vat: "excluded",
    requirements,
    lines,
    total,
    decision: open.length ? worst([...open, ...findings]) : "blocked",
    findings,
    source: quoted.source,
    pricedAt: quoted.retrievedAt,
  };

  const { token, keyId } = await signOffer(offer);
  await store.put<StoredOffer>("offers", offer.id, { offer, token, keyId });
  const s = summary(lines);
  await audit({
    ...who,
    action: "offer_issued",
    outcome: offer.decision,
    rule: findings[0]?.rule ?? lines.find((l) => l.decision !== "allowed")?.findings[0]?.rule ?? null,
    reason: `Offer for ${lines.length} line${lines.length === 1 ? "" : "s"}, ${eur(total)}, valid until ${fmtDateTime(offer.expiresAt)}: ${s.allowed} can be ordered alone, ${s.needsApproval} need approval, ${s.blocked} blocked`,
    offerId: offer.id,
  });

  return { offer, token, keyId, summary: s };
}

export async function getStoredOffer(id: string): Promise<StoredOffer | null> {
  return store.get<StoredOffer>("offers", id);
}

/** Read an offer: the agent it was made for, the buyer's purchaser, or Valio Aimo. */
export async function getOffer(caller: Caller, id: string): Promise<StoredOffer> {
  const stored = await getStoredOffer(id);
  const mayRead =
    stored &&
    (caller.role === "supplier" ||
      (caller.role === "purchaser" && caller.buyerId === stored.offer.buyerId) ||
      (caller.role === "agent" && caller.id === stored.offer.agentId));
  if (!mayRead) {
    return refuse({ rule: "access", reason: `No offer ${id} for this caller.`, http: 404, actor: actorOf(caller), buyerId: buyerIdOf(caller), action: "read_offer", offerId: id });
  }
  return stored;
}

/** Is this a real, unaltered, unexpired offer from this gateway? Anyone holding the token may ask. */
export async function verifyOffer(token: string) {
  const v: Verification = await verifyOfferToken(token);
  const offer = v.offer;
  const order = offer ? await store.get<{ id: string }>("orders", orderIdFor(offer.id)) : null;
  return {
    valid: v.valid,
    problem: v.valid ? null : v.problem,
    rule: v.valid ? null : v.rule,
    reason: v.valid ? `Signed by this gateway and unchanged. Valid until ${fmtDateTime(v.offer.expiresAt)}.` : v.reason,
    checkedAt: new Date().toISOString(),
    signature: { algorithm: "Ed25519 (JWT, alg EdDSA)", keyId: v.valid ? v.keyId : null, publicKeys: "/.well-known/jwks.json" },
    alreadyOrdered: order?.id ?? null,
    offer,
  };
}

/** One order per offer: the order id follows from the offer id, which makes a second order impossible. */
export const orderIdFor = (offerId: string) => `ord_${offerId.replace(/^off_/, "")}`;
