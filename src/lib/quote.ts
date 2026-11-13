// Combines Valio's live price and availability for a shortlist of products,
// converts the requested amount (e.g. 1000 L) into sales units, and flags problems.
import { getProduct } from "./catalog";
import { getAvailability, getPrices } from "./valio";

export type QuoteRequest = {
  productIds: string[]; // the shortlist, max 50
  deliveryDate: string; // YYYY-MM-DD
  amount: number; // how much the buyer needs
  unit: string; // "L", "KG", or a sales unit like "KI" / "ST"
  customer?: string;
};

export type QuoteLine = {
  productId: string;
  name: string | null;
  salesUnit: string;
  pricePerSalesUnit: number | null; // EUR, excl. VAT
  comparisonPrice: number | null; // EUR per comparisonUnit, excl. VAT
  comparisonUnit: string | null;
  contentPerSalesUnit: number | null; // in the requested unit
  salesUnitsNeeded: number | null;
  total: number | null; // EUR, excl. VAT
  availableOnDate: number; // in sales units
  orderCutoff: string | null;
  cutoffPassed: boolean;
  salesBlock: boolean;
  deliveryReliability: number | null;
  deliverable: boolean;
  issues: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function quote(req: QuoteRequest) {
  const products = req.productIds.slice(0, 50);
  const body = { customer: req.customer ?? "demo-hotel", requestedDate: req.deliveryDate, products };
  const [prices, avail] = await Promise.all([getPrices(body), getAvailability(body)]);
  const now = new Date(avail.timeNow);
  const unit = req.unit.toUpperCase();

  const lines: QuoteLine[] = products.map((id) => {
    const p = getProduct(id);
    const price = prices.products.find((x) => x.productId === id);
    const av = avail.products.find((x) => x.productId === id);
    const issues: string[] = [];
    const salesUnit = av?.scheduleLines[0]?.salesUnit ?? p?.salesUnit ?? "?";
    const unitPrice = price?.catalogPrice?.value ?? null;
    const comp = price?.comparisonPrice?.value ?? null;
    const compUnit = price?.comparisonUnit ?? null;

    // How much of the requested unit one sales unit holds
    let content: number | null = null;
    if (unit === salesUnit) content = 1;
    else if (unitPrice && comp && compUnit?.toUpperCase() === unit) {
      // Comparison prices are rounded to cents, so 20 L can come out as 19.94. Snap to whole units within 2%.
      const raw = unitPrice / comp;
      content = Math.abs(raw - Math.round(raw)) / raw < 0.02 ? Math.round(raw) : round2(raw);
    }
    else if (p && unit === "L" && p.litresPerBaseUnit) {
      const baseUnits = p.units.find((u) => u.unit === salesUnit)?.baseUnits ?? 1;
      content = p.litresPerBaseUnit * baseUnits;
    }
    if (content === null) issues.push(`Can't convert ${unit} to ${salesUnit}; ask in sales units`);

    const needed = content ? Math.ceil(req.amount / content) : null;
    const total = needed !== null && unitPrice !== null ? round2(needed * unitPrice) : null;
    if (!price || price.error || unitPrice === null) issues.push("No price available");

    const lines = (av?.scheduleLines ?? []).filter(
      (l) => !l.salesBlock && (!l.availableDate || l.availableDate <= req.deliveryDate),
    );
    const available = lines.reduce((s, l) => s + l.availableAmount, 0);
    const cutoffPassed = !!av?.closingTime && new Date(av.closingTime) < now;
    const salesBlock = !!av?.salesBlock;
    if (!av) issues.push("No availability data");
    if (salesBlock) issues.push("Sales blocked");
    if (cutoffPassed) issues.push(`Order cut-off for ${req.deliveryDate} passed at ${av!.closingTime}`);
    if (needed !== null && available < needed)
      issues.push(`Only ${available} ${salesUnit} available by ${req.deliveryDate}, need ${needed}`);

    return {
      productId: id,
      name: p?.nameEn ?? p?.nameFi ?? null,
      salesUnit,
      pricePerSalesUnit: unitPrice,
      comparisonPrice: comp,
      comparisonUnit: compUnit,
      contentPerSalesUnit: content,
      salesUnitsNeeded: needed,
      total,
      availableOnDate: available,
      orderCutoff: av?.closingTime ?? null,
      cutoffPassed,
      salesBlock,
      deliveryReliability: p?.deliveryReliability ?? null,
      deliverable: issues.length === 0,
      issues,
    };
  });

  // Deliverable first, then cheapest total
  lines.sort((a, b) => Number(b.deliverable) - Number(a.deliverable) || (a.total ?? Infinity) - (b.total ?? Infinity));
  return {
    source: "Valio Aimo mock API (price + availability)",
    retrievedAt: avail.timeNow,
    deliveryDate: req.deliveryDate,
    requested: { amount: req.amount, unit },
    lines,
  };
}
