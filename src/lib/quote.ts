// Combines Valio's live price and availability for a shortlist of products,
// converts each requested amount (e.g. 1000 L) into sales units, rounds up to the lot size, and flags problems.
// A whole basket costs one price call and one availability call.
import { getProduct, productName, type Product } from "./catalog";
import { fmtDateTime, fmtDay } from "./dates";
import { getAvailability, getPrices, valioSource, type ProductAvailability, type ProductPrice } from "./valio";

export const DEFAULT_CUSTOMER = "demo-hotel";
/** Valio reports 999999 when stock is not limited. */
export const UNLIMITED = 999999;

export type BasketLine = { productId: string; amount: number; unit: string };

export type ProblemCode = "unknown_product" | "unit_conversion" | "price" | "sales_block" | "cutoff" | "unavailable" | "stock";
export type Problem = { code: ProblemCode; text: string };

/** What Valio can supply for one product on one date. */
export type Supply = {
  known: boolean; // false when the API returned nothing for the product
  available: number; // sales units deliverable by the date, rounded down to whole lots
  salesUnit: string | null;
  logisticModel: string | null; // "Stock" | "Terminal"
  orderCutoff: string | null;
  cutoffPassed: boolean;
  salesBlock: boolean;
  nextAvailableDate: string | null; // first later date the schedule shows stock for, if any
};

export type QuoteLine = {
  productId: string;
  name: string | null;
  requested: { amount: number; unit: string };
  salesUnit: string;
  lotSize: number | null; // sold only in multiples of this many sales units; null = any whole number
  pricePerSalesUnit: number | null; // EUR, excl. VAT
  comparisonPrice: number | null; // EUR per comparisonUnit, excl. VAT
  comparisonUnit: string | null;
  priceValidTo: string | null;
  contentPerSalesUnit: number | null; // in the requested unit
  salesUnitsNeeded: number | null; // rounded up to whole sales units or whole lots
  deliveredAmount: number | null; // what that quantity holds, in the requested unit
  total: number | null; // EUR, excl. VAT
  availableOnDate: number; // in sales units
  logisticModel: string | null;
  orderCutoff: string | null;
  cutoffPassed: boolean;
  salesBlock: boolean;
  nextAvailableDate: string | null; // first later date the schedule shows stock for, if any
  deliveryReliability: number | null;
  deliverable: boolean;
  problems: Problem[];
  issues: string[]; // the problem texts
};

export type QuoteRequest = {
  productIds: string[]; // the shortlist, max 50
  deliveryDate: string; // YYYY-MM-DD
  amount: number; // how much the buyer needs
  unit: string; // "L", "KG", or a sales unit like "KI" / "ST"
  customer?: string;
};

const EPS = 1e-9;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

const UNIT_ALIASES: Record<string, string> = {
  LITRE: "L", LITRES: "L", LITER: "L", LITERS: "L", LTR: "L",
  KILO: "KG", KILOS: "KG", KGS: "KG", KILOGRAM: "KG", KILOGRAMS: "KG",
};
/** "litres" -> "L", "kg" -> "KG". Sales unit codes such as KI or ST pass through in upper case. */
export function normaliseUnit(unit: string): string {
  const u = unit.trim().toUpperCase();
  return UNIT_ALIASES[u] ?? u;
}

// Everyday words for one item of a product. People and agents say "60 bags of rice" for a product Valio sells by the
// piece (ST). When the product is sold one item at a time, such a word means the sales unit. It never means a box (KI)
// or a pallet: those hold several items, so a wrong guess would multiply the order.
const ITEM_WORDS = new Set(["PIECE", "PIECES", "PCS", "PC", "UNIT", "UNITS", "ITEM", "ITEMS", "BAG", "BAGS", "BOTTLE", "BOTTLES", "PACK", "PACKS", "PACKET", "PACKETS", "CAN", "CANS", "TIN", "TINS", "JAR", "JARS", "CARTON", "CARTONS", "TUB", "TUBS"]);
const ITEM_UNITS = new Set(["ST", "BAG", "BOT", "PAK", "PRK", "RAS"]);
/** True when `unit` is an everyday word for one item and the product is sold one item at a time. */
// The same goes for another item code: a model asked for rice in PAK when Valio sells that bag as ST (Sat 14 Nov 2026).
export const isItemWord = (unit: string, salesUnit: string) => (ITEM_WORDS.has(unit) || ITEM_UNITS.has(unit)) && ITEM_UNITS.has(salesUnit);

/** The data uses 0.01 to mean "no lot rule". Anything bigger is a real lot, e.g. 4.4 kg per bag. */
export const lotOf = (p: Product | null): number | null => (p && p.lotSize > 0.01 ? p.lotSize : null);

/** Round a quantity in sales units up to something that can be ordered: whole lots, or whole units. */
export function roundUpToLot(units: number, lot: number | null): number {
  if (lot) return round3(Math.ceil(units / lot - EPS) * lot);
  return Math.ceil(units - EPS);
}

const roundDownToLot = (units: number, lot: number | null) => (lot ? round3(Math.floor(units / lot + EPS) * lot) : Math.floor(units + EPS));

/** How much of `unit` one sales unit of the product holds. null = the data can't tell. */
export function contentPerSalesUnit(p: Product, salesUnit: string, unit: string, price?: ProductPrice): number | null {
  if (unit === salesUnit) return 1;
  if (isItemWord(unit, salesUnit) && !p.units.some((x) => x.unit === unit)) return 1;
  const unitPrice = price?.catalogPrice?.value;
  const comparison = price?.comparisonPrice?.value;
  if (unitPrice && comparison && price?.comparisonUnit?.toUpperCase() === unit) {
    // Comparison prices are rounded to cents, so 20 L can come out as 19.94. Snap to whole units within 2%.
    const raw = unitPrice / comparison;
    return Math.abs(raw - Math.round(raw)) / raw < 0.02 ? Math.round(raw) : round2(raw);
  }
  const baseUnits = (u: string) => p.units.find((x) => x.unit === u)?.baseUnits ?? null;
  const salesInBase = baseUnits(salesUnit) ?? (salesUnit === p.baseUnit ? 1 : null);
  if (salesInBase === null) return null;
  if (unit === "L" && p.litresPerBaseUnit) return round3(p.litresPerBaseUnit * salesInBase);
  if (unit === "KG" && p.kgPerBaseUnit && p.baseUnit !== "KG") return round3(p.kgPerBaseUnit * salesInBase);
  // Another packaging unit of the same product, e.g. asking in ST when it sells by the KI
  const unitInBase = baseUnits(unit);
  if (unitInBase) return round3(salesInBase / unitInBase);
  return null;
}

export function readSupply(av: ProductAvailability | undefined, deliveryDate: string, now: Date, lot: number | null): Supply {
  if (!av) {
    return { known: false, available: 0, salesUnit: null, logisticModel: null, orderCutoff: null, cutoffPassed: false, salesBlock: false, nextAvailableDate: null };
  }
  const open = av.scheduleLines.filter((l) => !l.salesBlock && l.availableAmount > 0);
  const lines = open.filter((l) => !l.availableDate || l.availableDate.slice(0, 10) <= deliveryDate);
  const raw = lines.reduce((s, l) => s + l.availableAmount, 0);
  const laterDates = open.flatMap((l) => (l.availableDate && l.availableDate.slice(0, 10) > deliveryDate ? [l.availableDate.slice(0, 10)] : [])).sort();
  return {
    known: true,
    available: raw >= UNLIMITED ? UNLIMITED : roundDownToLot(raw, lot),
    salesUnit: av.scheduleLines[0]?.salesUnit ?? null,
    logisticModel: av.logisticModel,
    orderCutoff: av.closingTime,
    cutoffPassed: !!av.closingTime && new Date(av.closingTime) < now,
    salesBlock: av.salesBlock,
    nextAvailableDate: laterDates[0] ?? null,
  };
}

/** Problems that stop a given quantity from being delivered. Shared by quotes and the re-check at order time. */
export function supplyProblems(s: Supply, quantity: number | null, salesUnit: string, deliveryDate: string): Problem[] {
  const out: Problem[] = [];
  if (!s.known) return [{ code: "unavailable", text: "Valio has no availability data for this product" }];
  if (s.salesBlock) out.push({ code: "sales_block", text: "Sales of this product are blocked" });
  if (s.cutoffPassed) {
    out.push({ code: "cutoff", text: `Order cut-off for ${fmtDay(deliveryDate)} passed on ${fmtDateTime(s.orderCutoff!)}` });
  }
  if (s.available <= 0) out.push({ code: "unavailable", text: `Not available for delivery on ${fmtDay(deliveryDate)}` });
  else if (quantity !== null && s.available + EPS < quantity) {
    out.push({ code: "stock", text: `Only ${s.available} ${salesUnit} in stock for ${fmtDay(deliveryDate)}, need ${quantity}` });
  }
  return out;
}

/** Sales units needed to cover an amount, given what one sales unit holds. */
export const quantityFor = (amount: number, content: number, lot: number | null) => roundUpToLot(amount / content, lot);

function toLine(req: BasketLine, deliveryDate: string, now: Date, price?: ProductPrice, av?: ProductAvailability): QuoteLine {
  const p = getProduct(req.productId);
  const unit = normaliseUnit(req.unit);
  const lot = lotOf(p);
  const supply = readSupply(av, deliveryDate, now, lot);
  const salesUnit = supply.salesUnit ?? p?.salesUnit ?? "?";
  const unitPrice = price && !price.error ? (price.catalogPrice?.value ?? null) : null;
  const problems: Problem[] = [];

  if (!p) problems.push({ code: "unknown_product", text: `No product ${req.productId} in the catalogue` });
  const content = p ? contentPerSalesUnit(p, salesUnit, unit, price) : null;
  if (p && content === null) problems.push({ code: "unit_conversion", text: `Can't convert ${unit} to ${salesUnit} for this product; ask in ${salesUnit}` });
  const needed = content ? quantityFor(req.amount, content, lot) : null;
  if (p && unitPrice === null) problems.push({ code: "price", text: "Valio has no price for this product" });
  if (p) problems.push(...supplyProblems(supply, needed, salesUnit, deliveryDate));

  return {
    productId: req.productId,
    name: p ? productName(p) : null,
    requested: { amount: req.amount, unit },
    salesUnit,
    lotSize: lot,
    pricePerSalesUnit: unitPrice,
    comparisonPrice: price?.comparisonPrice?.value ?? null,
    comparisonUnit: price?.comparisonUnit ?? null,
    priceValidTo: price?.catalogPrice?.validTo ?? null,
    contentPerSalesUnit: content,
    salesUnitsNeeded: needed,
    deliveredAmount: needed !== null && content ? round3(needed * content) : null,
    total: needed !== null && unitPrice !== null ? round2(needed * unitPrice) : null,
    availableOnDate: supply.available,
    logisticModel: supply.logisticModel,
    orderCutoff: supply.orderCutoff,
    cutoffPassed: supply.cutoffPassed,
    salesBlock: supply.salesBlock,
    nextAvailableDate: supply.nextAvailableDate,
    deliveryReliability: p?.deliveryReliability ?? null,
    deliverable: problems.length === 0,
    problems,
    issues: problems.map((x) => x.text),
  };
}

/** Product codes worth sending to Valio: known in the static catalogue, each once. */
const knownIds = (ids: string[]) => [...new Set(ids)].filter((id) => getProduct(id));

/**
 * Quote several lines, each with its own amount and unit, with one price call and one availability call.
 * Returns one quote line per basket line, in the same order.
 */
export async function quoteBasket(req: { lines: BasketLine[]; deliveryDate: string; customer?: string }) {
  const products = knownIds(req.lines.map((l) => l.productId));
  if (products.length > 1000) throw new Error("A quote can cover at most 1000 products");
  let retrievedAt = new Date().toISOString();
  let prices: ProductPrice[] = [];
  let avail: ProductAvailability[] = [];
  if (products.length) {
    const body = { customer: req.customer ?? DEFAULT_CUSTOMER, requestedDate: req.deliveryDate, products };
    const [p, a] = await Promise.all([getPrices(body), getAvailability(body)]);
    prices = p.products;
    avail = a.products;
    retrievedAt = a.timeNow;
  }
  const now = new Date(retrievedAt);
  const priceById = new Map(prices.map((x) => [x.productId, x]));
  const availById = new Map(avail.map((x) => [x.productId, x]));
  return {
    source: valioSource(),
    retrievedAt,
    deliveryDate: req.deliveryDate,
    lines: req.lines.map((l) => toLine(l, req.deliveryDate, now, priceById.get(l.productId), availById.get(l.productId))),
  };
}

/** Availability only, for the re-check when an order is placed or approved. One call. */
export async function checkSupply(productIds: string[], deliveryDate: string, customer?: string) {
  const products = knownIds(productIds);
  const byId = new Map<string, Supply>();
  let checkedAt = new Date().toISOString();
  if (products.length) {
    const res = await getAvailability({ customer: customer ?? DEFAULT_CUSTOMER, requestedDate: deliveryDate, products });
    checkedAt = res.timeNow;
    const now = new Date(checkedAt);
    for (const av of res.products) byId.set(av.productId, readSupply(av, deliveryDate, now, lotOf(getProduct(av.productId))));
  }
  const unknown = readSupply(undefined, deliveryDate, new Date(checkedAt), null);
  return { checkedAt, supply: (id: string) => byId.get(id) ?? unknown };
}

/** One amount and unit for a shortlist of products: the original quote endpoint. */
export async function quote(req: QuoteRequest) {
  const unit = normaliseUnit(req.unit);
  const res = await quoteBasket({
    lines: req.productIds.slice(0, 50).map((productId) => ({ productId, amount: req.amount, unit })),
    deliveryDate: req.deliveryDate,
    customer: req.customer,
  });
  // Deliverable first, then cheapest total
  const lines = [...res.lines].sort(
    (a, b) => Number(b.deliverable) - Number(a.deliverable) || (a.total ?? Infinity) - (b.total ?? Infinity),
  );
  return { source: res.source, retrievedAt: res.retrievedAt, deliveryDate: req.deliveryDate, requested: { amount: req.amount, unit }, lines };
}
