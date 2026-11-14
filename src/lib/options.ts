// Ranked options for something the buyer needs: used by find_options and for every exception line in an offer.
// The ranking happens here on the server, so every agent gets the same answer:
//   1. a substitute Valio Aimo itself lists for the product
//   2. the same type and brand
//   3. the same type, another brand
//   then the lower price per unit, and delivery reliability breaks ties.
// A split (what is in stock, the rest from the best substitute) and the same product on its first possible
// later date are added when they apply. If nothing can be delivered, the answer says so. It never guesses.
import { getProduct, productName, productsInCategory, REQUIREMENTS, searchProducts, type Product, type Requirement } from "./catalog";
import { addDays, fmtDateTime, fmtDay, helsinkiDate, startOfDay } from "./dates";
import { checkProperties, checkSubstitution, eur, relationOf, type Mandate } from "./mandate";
import { checkSupply, normaliseUnit, quantityFor, quoteBasket, round2, round3, UNLIMITED, type BasketLine, type QuoteLine } from "./quote";
import { worst, type Decision, type Finding } from "./rules";
import { valioSource } from "./valio";

/** Hard caps, so one request can never fan out into many Valio calls or product codes. */
export const MAX_SEARCH_CANDIDATES = 100;
export const MAX_SUBSTITUTE_CANDIDATES = 120; // per line, from the same category
export const MAX_LATER_DATE_CALLS = 3; // per request, for all lines together
export const MAX_OPTIONS = 3;

export type OptionPart = {
  productId: string;
  name: string;
  brand: string | null;
  quantity: number; // sales units
  salesUnit: string;
  unitPrice: number; // EUR per sales unit, excl. VAT
  total: number;
  covers: number; // how much of the requested amount this part delivers, in the requested unit
  deliveryDate: string;
  origin: string | null;
  labels: string[];
  allergenDataKnown: boolean;
};

export type Relation = "requested" | "listed_substitute" | "same_type_same_brand" | "same_type_other_brand" | "other_type" | "search_match";

export type Option = {
  rank: number;
  kind: "product" | "split" | "later_date";
  relation: Relation;
  parts: OptionPart[];
  total: number;
  pricePerUnit: number | null; // EUR per requested unit
  unit: string;
  deliveryReliability: number | null;
  reason: string;
  /** What the buyer's mandate says about this option on its own. Order limits are checked on the whole order. */
  decision: Decision;
  findings: Finding[];
};

export type OptionsResult = {
  options: Option[];
  possible: boolean;
  message: string;
  notOffered: { productId: string; name: string; reason: string }[];
  checked: number;
};

/** One thing the buyer needs. `reference` is the product they asked for, if they named one. */
export type Need = {
  amount: number;
  unit: string;
  requirements: Requirement[];
  reference: Product | null;
  referenceQuote: QuoteLine | null; // pass it when the reference is already quoted, to save a call
  candidates: Product[];
};

type Evaluated = {
  product: Product;
  quote: QuoteLine;
  relation: Relation;
  tier: number;
  findings: Finding[]; // from the mandate
  decision: Decision;
  pricePerUnit: number | null;
  full: boolean; // can deliver the whole amount on the date
  partial: boolean; // can deliver some of it on the date
  laterOnly: boolean; // a later date could fix it
  whyNot: string | null;
};

const TIER: Record<Relation, number> = { requested: 0, listed_substitute: 1, same_type_same_brand: 2, same_type_other_brand: 3, other_type: 4, search_match: 1 };
const RANK: Record<Decision, number> = { allowed: 0, needs_approval: 1, blocked: 2 };

function evaluate(mandate: Mandate, need: Need, product: Product, quote: QuoteLine): Evaluated {
  const isReference = need.reference?.id === product.id;
  const rel = need.reference && !isReference ? relationOf(need.reference, product) : null;
  const relation: Relation = isReference
    ? "requested"
    : !rel
      ? "search_match"
      : rel.listed
        ? "listed_substitute"
        : !rel.sameType
          ? "other_type"
          : rel.sameBrand
            ? "same_type_same_brand"
            : "same_type_other_brand";
  const findings = [
    ...checkProperties(mandate, product, need.requirements).findings,
    ...(need.reference && !isReference ? checkSubstitution(mandate, need.reference, product) : []),
  ];
  const decision = worst(findings);
  const codes = quote.problems.map((p) => p.code);
  const priced = quote.pricePerSalesUnit !== null && !!quote.contentPerSalesUnit && quote.salesUnitsNeeded !== null;
  const full = quote.deliverable;
  return {
    product,
    quote,
    relation,
    tier: TIER[relation],
    findings,
    decision,
    pricePerUnit: priced ? round2(quote.pricePerSalesUnit! / quote.contentPerSalesUnit!) : null,
    full,
    partial: priced && codes.length > 0 && codes.every((c) => c === "stock"),
    laterOnly:
      priced &&
      codes.length > 0 &&
      codes.every((c) => c === "cutoff" || c === "stock" || c === "unavailable") &&
      (codes.includes("cutoff") || quote.nextAvailableDate !== null),
    whyNot: decision === "blocked" ? findings.find((f) => f.decision === "blocked")!.reason : full ? null : quote.issues[0],
  };
}

/** With a reference product the tiers lead. For a plain search there are no tiers, so what the agent may order alone leads. */
const compare = (hasReference: boolean) => (a: Evaluated, b: Evaluated) =>
  (hasReference ? a.tier - b.tier : RANK[a.decision] - RANK[b.decision]) ||
  (a.pricePerUnit ?? Infinity) - (b.pricePerUnit ?? Infinity) ||
  (b.product.deliveryReliability ?? -1) - (a.product.deliveryReliability ?? -1) ||
  a.product.id.localeCompare(b.product.id);

const brandOf = (p: Product) => p.brand?.trim() || p.vendor;

function part(e: Evaluated, quantity: number, deliveryDate: string): OptionPart {
  const p = e.product;
  return {
    productId: p.id,
    name: productName(p),
    brand: p.brand?.trim() ?? null,
    quantity,
    salesUnit: e.quote.salesUnit,
    unitPrice: e.quote.pricePerSalesUnit!,
    total: round2(quantity * e.quote.pricePerSalesUnit!),
    covers: round3(quantity * e.quote.contentPerSalesUnit!),
    deliveryDate,
    origin: p.origin,
    labels: p.labels,
    allergenDataKnown: p.allergenDataKnown,
  };
}

function relationText(e: Evaluated, reference: Product | null): string {
  const ref = reference ? productName(reference) : "";
  switch (e.relation) {
    case "requested":
      return "The product that was asked for";
    case "listed_substitute":
      return `Valio Aimo lists it as a substitute for ${ref}${relationOf(reference!, e.product).sameBrand ? "" : `; another brand (${brandOf(e.product)})`}`;
    case "same_type_same_brand":
      return `Same type and brand as ${ref}`;
    case "same_type_other_brand":
      return `Same type as ${ref}, another brand (${brandOf(e.product)})`;
    case "other_type":
      return `Another product type than ${ref}`;
    case "search_match":
      return "Matches the search";
  }
}

const reliabilityText = (p: Product) => (p.deliveryReliability === null ? "" : `, delivery reliability ${Math.round(p.deliveryReliability * 100)}%`);
const priceText = (e: Evaluated, unit: string) => (e.pricePerUnit === null ? "" : `${eur(e.pricePerUnit)}/${unit}`);

function productOption(e: Evaluated, need: Need, date: string): Omit<Option, "rank"> {
  const p = part(e, e.quote.salesUnitsNeeded!, date);
  return {
    kind: "product",
    relation: e.relation,
    parts: [p],
    total: p.total,
    pricePerUnit: e.pricePerUnit,
    unit: need.unit,
    deliveryReliability: e.product.deliveryReliability,
    reason: `${relationText(e, need.reference)}. ${priceText(e, need.unit)}, in stock for ${fmtDay(date)}${reliabilityText(e.product)}.`,
    decision: e.decision,
    findings: e.findings,
  };
}

const capacity = (e: Evaluated) => (e.quote.availableOnDate >= UNLIMITED ? Infinity : e.quote.availableOnDate * e.quote.contentPerSalesUnit!);

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => !seen.has(f.rule + f.reason) && seen.add(f.rule + f.reason));
}

function splitOption(primary: Evaluated, rest: Evaluated, need: Need, date: string): Omit<Option, "rank"> | null {
  const first = part(primary, primary.quote.availableOnDate, date);
  const restAmount = round3(need.amount - first.covers);
  if (restAmount <= 0) return null;
  const second = part(rest, quantityFor(restAmount, rest.quote.contentPerSalesUnit!, rest.quote.lotSize), date);
  const findings = dedupe([
    ...primary.findings,
    ...rest.findings,
    { rule: "substitution", decision: "needs_approval", reason: `The line would be split across two products: ${first.name} and ${second.name}` },
  ]);
  const total = round2(first.total + second.total);
  return {
    kind: "split",
    relation: primary.relation,
    parts: [first, second],
    total,
    pricePerUnit: round2(total / (first.covers + second.covers)),
    unit: need.unit,
    deliveryReliability: null,
    reason: `${first.quantity} ${first.salesUnit} of ${first.name} (all that is in stock) plus ${second.quantity} ${second.salesUnit} of ${second.name} to cover ${need.amount} ${need.unit}.`,
    decision: worst(findings),
    findings,
  };
}

type Later = { date: string; orderCutoff: string | null };

function laterOption(e: Evaluated, later: Later, need: Need, requestedDate: string): Omit<Option, "rank"> {
  const p = part(e, e.quote.salesUnitsNeeded!, later.date);
  const priceHolds = !e.quote.priceValidTo || e.quote.priceValidTo.slice(0, 10) >= later.date;
  const findings = dedupe([
    ...e.findings,
    { rule: "delivery_date", decision: "needs_approval", reason: `Delivery would be on ${fmtDay(later.date)} instead of ${fmtDay(requestedDate)}` },
  ]);
  return {
    kind: "later_date",
    relation: e.relation,
    parts: [p],
    total: p.total,
    pricePerUnit: e.pricePerUnit,
    unit: need.unit,
    deliveryReliability: e.product.deliveryReliability,
    reason:
      `${e.relation === "requested" ? "The same product" : productName(e.product)} on its first possible date, ${fmtDay(later.date)}` +
      `${later.orderCutoff ? ` (order by ${fmtDateTime(later.orderCutoff)})` : ""}${priceHolds ? "" : "; the price must be confirmed for that date"}.`,
    decision: worst(findings),
    findings,
  };
}

function whyNothing(evals: Evaluated[]): string {
  const count = (test: (e: Evaluated) => boolean) => evals.filter(test).length;
  const has = (e: Evaluated, code: string) => e.quote.problems.some((p) => p.code === code);
  const parts = [
    [count((e) => e.decision === "blocked"), "not allowed by the mandate"],
    [count((e) => e.decision !== "blocked" && has(e, "cutoff")), "past the order cut-off"],
    [count((e) => e.decision !== "blocked" && !has(e, "cutoff") && (has(e, "unavailable") || has(e, "stock"))), "not in stock"],
    [count((e) => e.decision !== "blocked" && has(e, "price")), "without a price"],
  ] as const;
  return parts.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`).join(", ");
}

function compose(need: Need, deliveryDate: string, reference: Evaluated | null, candidates: Evaluated[], later: { target: Evaluated; hit: Later } | null, includeReference: boolean): OptionsResult {
  const order = compare(!!need.reference);
  const viable = candidates.filter((e) => e.decision !== "blocked");
  const full = viable.filter((e) => e.full).sort(order);
  const partials = viable.filter((e) => e.partial).sort(order);
  const referenceOk = !!reference && reference.full && reference.decision !== "blocked";

  const products = [...(referenceOk && includeReference ? [reference] : []), ...full].map((e) => productOption(e, need, deliveryDate));

  // A split is worth offering when the closest match has some stock but not enough.
  let split: Omit<Option, "rank"> | null = null;
  if (!referenceOk) {
    const primary =
      (reference?.partial && reference.decision !== "blocked" ? reference : null) ?? partials.find((p) => !full.length || p.tier < full[0].tier) ?? null;
    if (primary) {
      const restAmount = need.amount - capacity(primary);
      const rest = [...full, ...partials].find((e) => e.product.id !== primary.product.id && capacity(e) >= restAmount);
      if (rest) split = splitOption(primary, rest, need, deliveryDate);
    }
  }
  const laterOpt = later ? laterOption(later.target, later.hit, need, deliveryDate) : null;

  const reserved = (split ? 1 : 0) + (laterOpt ? 1 : 0);
  const chosen = [...products.slice(0, MAX_OPTIONS - reserved), ...(split ? [split] : []), ...(laterOpt ? [laterOpt] : [])];
  const options = chosen.map((o, i) => ({ rank: i + 1, ...o }));

  const all = [...(reference ? [reference] : []), ...candidates];
  // Near misses first: the asked-for product, then products Valio has a price for, in ranking order
  const notOffered = all
    .filter((e) => e.whyNot && !(e === reference && !includeReference))
    .sort((a, b) => Number(b === reference) - Number(a === reference) || Number(b.pricePerUnit !== null) - Number(a.pricePerUnit !== null) || order(a, b))
    .slice(0, 8)
    .map((e) => ({ productId: e.product.id, name: productName(e.product), reason: e.whyNot! }));
  const checked = all.length;
  const what = `${need.amount} ${need.unit} on ${fmtDay(deliveryDate)}`;
  const message = options.length
    ? `${options.length} option${options.length === 1 ? "" : "s"} for ${what}, best first. ${checked} product${checked === 1 ? "" : "s"} checked.`
    : checked === 0
      ? `Nothing can be delivered for ${what}: no product of the same type was found. The gateway does not guess a replacement.`
      : `Nothing can be delivered for ${what}: ${checked} product${checked === 1 ? "" : "s"} checked, ${whyNothing(all) || "none usable"}. The gateway does not guess a replacement.`;
  return { options, possible: options.length > 0, message, notOffered, checked };
}

/** Products that could replace `p`: the substitutes Valio lists, then the same category, same brand first. */
export function substituteCandidates(p: Product, mandate: Mandate, requirements: Requirement[], cap = MAX_SUBSTITUTE_CANDIDATES): Product[] {
  const listed = p.substitutes.map(getProduct).filter((x): x is Product => !!x && x.id !== p.id);
  const seen = new Set([p.id, ...listed.map((x) => x.id)]);
  const sameType = productsInCategory(p.category)
    .filter((x) => !seen.has(x.id))
    .sort(
      (a, b) =>
        Number(relationOf(p, b).sameBrand) - Number(relationOf(p, a).sameBrand) ||
        (b.deliveryReliability ?? -1) - (a.deliveryReliability ?? -1) ||
        a.id.localeCompare(b.id),
    );
  // Static data first: a product that fails a required property is never sent to Valio for a quote.
  const passes = (x: Product) => worst(checkProperties(mandate, x, requirements).findings) !== "blocked";
  return [...listed, ...sameType].filter(passes).slice(0, cap);
}

/** The first date whose cut-off is still ahead, assuming the cut-off is a fixed lead time before delivery. */
function firstDateGuess(deliveryDate: string, quote: QuoteLine, now: Date): string {
  let guess = addDays(deliveryDate, 1);
  if (quote.cutoffPassed && quote.orderCutoff) {
    const lead = startOfDay(deliveryDate).getTime() - new Date(quote.orderCutoff).getTime();
    const afterLead = addDays(helsinkiDate(new Date(now.getTime() + lead)), 1);
    if (afterLead > guess) guess = afterLead;
  }
  if (quote.nextAvailableDate && quote.nextAvailableDate > guess) guess = quote.nextAvailableDate;
  return guess;
}

/**
 * Options for several needs at once. Valio calls: one price and one availability call for all candidates,
 * plus at most MAX_LATER_DATE_CALLS availability calls to find later dates.
 * `includeReference`: list the asked-for product itself as an option when it can be ordered (find_options does, offers don't).
 */
export async function buildOptions(mandate: Mandate, needs: Need[], deliveryDate: string, includeReference: boolean): Promise<{ results: OptionsResult[]; retrievedAt: string }> {
  // 1. Quote every candidate of every need in one go
  const lines: BasketLine[] = [];
  const spans = needs.map((n) => {
    const products = [...(n.reference && !n.referenceQuote ? [n.reference] : []), ...n.candidates];
    const start = lines.length;
    for (const p of products) lines.push({ productId: p.id, amount: n.amount, unit: n.unit });
    return { start, products };
  });
  const quoted = lines.length ? await quoteBasket({ lines, deliveryDate }) : null;
  const retrievedAt = quoted?.retrievedAt ?? new Date().toISOString();
  const now = new Date(retrievedAt);

  // 2. Judge each one against stock, cut-off and the mandate
  const judged = needs.map((need, i) => {
    const { start, products } = spans[i];
    const evals = products.map((p, j) => evaluate(mandate, need, p, quoted!.lines[start + j]));
    const reference = need.reference ? (need.referenceQuote ? evaluate(mandate, need, need.reference, need.referenceQuote) : evals.shift()!) : null;
    return { need, reference, candidates: evals };
  });

  // 3. Which products are worth asking about on a later date
  const latest = addDays(helsinkiDate(now), mandate.latestDeliveryDays);
  const pending = judged.flatMap((j, i) => {
    const referenceOk = j.reference?.full && j.reference.decision !== "blocked";
    const anyFull = j.candidates.some((e) => e.full && e.decision !== "blocked");
    const target = j.reference
      ? !referenceOk && j.reference.laterOnly && j.reference.decision !== "blocked"
        ? j.reference
        : null
      : !anyFull
        ? (j.candidates.find((e) => e.laterOnly && e.decision !== "blocked") ?? null)
        : null;
    return target ? [{ i, target, guess: firstDateGuess(deliveryDate, target.quote, now) }] : [];
  });

  // 4. Ask, with a hard cap on calls. Every call covers all products still waiting for a date.
  const laterHits = new Map<number, { target: Evaluated; hit: Later }>();
  // Products whose passed cut-off came back unchanged for a later date. Valio's mock API does this (seen Sat 14 Nov 2026):
  // it returns the same schedule whatever date is asked, so asking about more dates would only spend calls.
  const fixedCutoff = new Map<number, string>();
  let waiting = pending.filter((p) => p.guess <= latest);
  let date = waiting.map((p) => p.guess).sort()[0];
  for (let calls = 0; waiting.length && calls < MAX_LATER_DATE_CALLS && date <= latest; date = addDays(date, 1)) {
    const due = waiting.filter((p) => p.guess <= date);
    if (!due.length) continue;
    const { supply } = await checkSupply(due.map((p) => p.target.product.id), date);
    calls++;
    for (const p of due) {
      const s = supply(p.target.product.id);
      if (s.known && !s.cutoffPassed && !s.salesBlock && s.available >= p.target.quote.salesUnitsNeeded!) {
        laterHits.set(p.i, { target: p.target, hit: { date, orderCutoff: s.orderCutoff } });
      } else if (s.cutoffPassed && s.orderCutoff && s.orderCutoff === p.target.quote.orderCutoff) {
        fixedCutoff.set(p.i, `No later date can be offered for ${productName(p.target.product)}: Valio's data gives the same order cut-off (${fmtDateTime(s.orderCutoff)}) for ${fmtDay(date)} too.`);
      }
    }
    waiting = waiting.filter((p) => !laterHits.has(p.i) && !fixedCutoff.has(p.i));
  }

  // 5. Rank and word the options
  const results = judged.map((j, i) => {
    const r = compose(j.need, deliveryDate, j.reference, j.candidates, laterHits.get(i) ?? null, includeReference);
    const note = fixedCutoff.get(i);
    return note ? { ...r, message: `${r.message} ${note}` } : r;
  });
  return { results, retrievedAt };
}

export type FindOptionsInput = {
  query?: string;
  productId?: string;
  amount: number;
  unit: string;
  deliveryDate: string;
  requirements: Requirement[];
};

/** find_options: search words or a product code, an amount and a date in; up to three ranked, quoted options out. */
export async function findOptions(mandate: Mandate, input: FindOptionsInput) {
  const unit = normaliseUnit(input.unit);
  const requirements = [...new Set([...mandate.requiredProperties, ...input.requirements])];
  const base = {
    source: valioSource(),
    deliveryDate: input.deliveryDate,
    requested: { amount: input.amount, unit },
    requirements: requirements.map((r) => ({ id: r, name: REQUIREMENTS[r], from: mandate.requiredProperties.includes(r) ? "mandate" : "request" })),
  };
  const nothing = (message: string) => ({
    ...base,
    retrievedAt: new Date().toISOString(),
    reference: null,
    search: null,
    options: [],
    possible: false,
    message,
    notOffered: [],
    checked: 0,
  });

  const reference = input.productId ? getProduct(input.productId) : null;
  if (input.productId && !reference) return nothing(`No product ${input.productId} in the catalogue. Use search_products to find the code.`);
  if (!reference && !input.query?.trim()) return nothing("Give search words (query) or a product code (productId).");

  let candidates: Product[] = [];
  let search: { query: string; matches: number; checked: number } | null = null;
  if (input.query?.trim()) {
    const found = searchProducts({ query: input.query, requirements, includeUnknown: true, limit: MAX_SEARCH_CANDIDATES });
    candidates = found.hits.map((h) => h.product).filter((p) => p.id !== reference?.id);
    search = { query: input.query, matches: found.total, checked: found.hits.length };
    if (!reference && found.total === 0) {
      return nothing(`No product in the catalogue matches "${input.query}" with these requirements. Try other Finnish or English words. The gateway does not guess.`);
    }
  } else if (reference) {
    candidates = substituteCandidates(reference, mandate, requirements);
  }

  const need: Need = { amount: input.amount, unit, requirements: input.requirements, reference, referenceQuote: null, candidates };
  const { results, retrievedAt } = await buildOptions(mandate, [need], input.deliveryDate, true);
  const result = results[0];
  const narrowed = search && search.matches > search.checked ? ` Only the first ${search.checked} of ${search.matches} matches were checked; add search words to narrow it down.` : "";
  return {
    ...base,
    retrievedAt,
    reference: reference ? { productId: reference.id, name: productName(reference) } : null,
    search,
    ...result,
    message: result.message + narrowed,
  };
}
