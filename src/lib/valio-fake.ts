// FAKE price and availability data, shaped like Valio Aimo's mock API.
// Used by the tests and by `npm run dev:fake`. Never used in production (see valio.ts).
// Product codes are real ones from the static catalogue; prices, stock and cut-offs here are made up,
// loosely following what the live API said on Fri 13 Nov 2026.
// The shapes follow the live API as seen on Sat 14 Nov 2026: times as Helsinki wall time with a colon-less
// offset ("+0200"), and no closingTime or logisticModel on a product that can't be delivered.
// One thing differs on purpose: here the cut-off moves with the requested date, as a real order system's would.
// The live mock API returns the same schedule whatever date is asked; `fakeValio.fixSchedule` copies that.
import { addDays, helsinkiOffset, TZ } from "./dates";
import type { ProductAvailability, ProductPrice, ProductsRequest } from "./valio";

export const UNLIMITED = 999999;

type Row = {
  unit: string; // sales unit
  price: number | null; // EUR per sales unit, excl. VAT. null = the API has no price
  per?: [number, string]; // comparison price, e.g. [1.57, "L"]
  model: "Stock" | "Terminal";
  stock: number | null; // in sales units. null = empty schedule (can't be delivered at all)
};

// Fake cut-off rule: Terminal products close 4 days before delivery at 15:00, Stock products the day before at 17:00.
// With "now" on Sat 14 Nov, a Monday 16 Nov delivery is closed for Terminal and open for Stock.
const ROWS: Record<string, Row> = {
  // Lactose-free milk
  "463038": { unit: "KI", price: 31.31, per: [1.57, "L"], model: "Terminal", stock: UNLIMITED }, // Eila 10 l novobox, KI = 2 x 10 l. Past cut-off.
  "464179": { unit: "ST", price: 14.9, per: [1.49, "L"], model: "Terminal", stock: UNLIMITED }, // Arla 10 l novobox. Past cut-off.
  "465039": { unit: "KI", price: 8.45, per: [1.69, "L"], model: "Stock", stock: UNLIMITED }, // Eila 1 l, KI = 5 x 1 l
  "464398": { unit: "ST", price: 1.62, per: [1.62, "L"], model: "Stock", stock: UNLIMITED }, // Eila 1 l UHT
  "469363": { unit: "ST", price: 1.55, per: [1.55, "L"], model: "Stock", stock: 600 }, // Arla 1 l UHT. Too little stock for 1,000 l.
  "464201": { unit: "ST", price: null, model: "Stock", stock: UNLIMITED }, // Valio 1 l UHT. No price.
  // Chicken fillets (category 18750)
  "463232": { unit: "KG", price: 10.9, per: [10.9, "KG"], model: "Terminal", stock: UNLIMITED }, // Atria, lot 3 kg. Past cut-off.
  "464786": { unit: "KG", price: 12.4, per: [12.4, "KG"], model: "Terminal", stock: UNLIMITED }, // Naapurin Maalaiskana. Past cut-off.
  "472673": { unit: "KG", price: 9.8, per: [9.8, "KG"], model: "Stock", stock: UNLIMITED }, // Kariniemen, lot 2 kg, lactose-free claim
  "462281": { unit: "KG", price: 10.2, per: [10.2, "KG"], model: "Stock", stock: 198 }, // Kariniemen, lot 4.4 kg, 198 kg = 45 lots, no allergen data
  // Carrot and tomato
  "474984": { unit: "KI", price: 13.5, per: [1.35, "KG"], model: "Terminal", stock: UNLIMITED }, // Past cut-off.
  "467503": { unit: "ST", price: 1.45, per: [1.45, "KG"], model: "Stock", stock: null }, // Unavailable.
  "467366": { unit: "ST", price: 3.1, per: [3.1, "KG"], model: "Terminal", stock: UNLIMITED }, // Past cut-off.
  "474752": { unit: "KI", price: 26.1, per: [2.9, "KG"], model: "Terminal", stock: UNLIMITED }, // Past cut-off.
  // Parmesan
  "463968": { unit: "ST", price: 3.95, per: [31.6, "KG"], model: "Stock", stock: 137 }, // no allergen data
  "469671": { unit: "ST", price: 24.9, per: [24.9, "KG"], model: "Stock", stock: 289 },
  "469648": { unit: "ST", price: 5.9, per: [29.5, "KG"], model: "Stock", stock: UNLIMITED },
  "471365": { unit: "ST", price: 23.5, per: [23.5, "KG"], model: "Stock", stock: 80 },
  "475924": { unit: "RAS", price: 19.9, per: [19.9, "KG"], model: "Stock", stock: UNLIMITED },
  // Salmon: unavailable, and the catalogue lists no substitute
  "461814": { unit: "KG", price: 18.5, per: [18.5, "KG"], model: "Stock", stock: null },
  "461903": { unit: "KG", price: 21.9, per: [21.9, "KG"], model: "Stock", stock: null },
  // Staples that are simply available
  "472332": { unit: "ST", price: 11.9, per: [2.38, "KG"], model: "Stock", stock: UNLIMITED }, // basmati rice 5 kg
  "467239": { unit: "ST", price: 4.2, per: [4.2, "KG"], model: "Stock", stock: UNLIMITED }, // cucumber cubes 1 kg
  "475644": { unit: "ST", price: 3.83, per: [1.53, "KG"], model: "Stock", stock: UNLIMITED }, // baby carrots, frozen, 2.5 kg (menu run)
  "464306": { unit: "ST", price: 1.01, per: [1.01, "L"], model: "Stock", stock: UNLIMITED }, // Arki Eila 1 l (menu run)
  "473237": { unit: "ST", price: 2.95, per: [9.83, "KG"], model: "Stock", stock: UNLIMITED }, // salad mix 300 g
  "462080": { unit: "BOT", price: 6.4, per: [6.4, "L"], model: "Stock", stock: UNLIMITED }, // lemon vinaigrette 1 l
  "460453": { unit: "PAK", price: 1.85, per: [2.31, "KG"], model: "Stock", stock: UNLIMITED }, // sea salt 800 g
};

type Call = { kind: "price" | "availability"; requestedDate: string; products: string[] };
type State = { calls: Call[]; stock: Record<string, number | null>; price: Record<string, number | null>; schedule: string | null };

// Kept on globalThis so every route module on the dev server sees the same fake state.
const g = globalThis as unknown as { __aimoFakeValio?: State };
const state = (): State => (g.__aimoFakeValio ??= { calls: [], stock: {}, price: {}, schedule: null });

const VAT = 13.5;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The offset the way the live API writes it: "+0200", no colon. */
const liveOffset = (at: Date) => helsinkiOffset(at).replace(":", "");

/** A moment the way the live API writes it: Helsinki wall time, "2026-11-14T09:39:43+0200". */
function liveTime(at: Date): string {
  const wall = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short", timeStyle: "medium" }).format(at).replace(" ", "T");
  return `${wall}${liveOffset(at)}`;
}

function closingTime(model: Row["model"], deliveryDate: string): string {
  const [daysBefore, hour] = model === "Terminal" ? [4, "15"] : [1, "17"];
  const day = addDays(deliveryDate, -daysBefore);
  return `${day}T${hour}:00:00${liveOffset(new Date(`${day}T12:00:00Z`))}`;
}

const money = (value: number, date: string) => ({
  value,
  valueWithTax: round2(value * (1 + VAT / 100)),
  validFrom: addDays(date, -30),
  validTo: addDays(date, 30),
  currency: "EUR",
});

export async function getPrices(req: ProductsRequest) {
  const s = state();
  s.calls.push({ kind: "price", requestedDate: req.requestedDate, products: [...req.products] });
  const products: ProductPrice[] = req.products.map((id) => {
    const row = ROWS[id];
    const value = id in s.price ? s.price[id] : (row?.price ?? null);
    if (!row || value === null) {
      return { productId: id, quantity: 1, catalogPrice: null, comparisonPrice: null, comparisonUnit: null, listPrice: null, tax: null, netPriceFound: false, error: true };
    }
    // Keep the comparison price in step when a test changes the price
    const comparison = row.per && row.price ? round2((row.per[0] * value) / row.price) : null;
    return {
      productId: id,
      quantity: 1,
      catalogPrice: money(value, req.requestedDate),
      comparisonPrice: comparison === null ? null : money(comparison, req.requestedDate),
      comparisonUnit: row.per?.[1] ?? null,
      listPrice: money(value, req.requestedDate),
      tax: { taxRate: VAT, taxValue: round2((value * VAT) / 100) },
      netPriceFound: true,
      error: false,
    };
  });
  return { customerId: req.customer, currency: "EUR", pricingDate: req.requestedDate, products };
}

export async function getAvailability(req: ProductsRequest) {
  const s = state();
  s.calls.push({ kind: "availability", requestedDate: req.requestedDate, products: [...req.products] });
  const products: ProductAvailability[] = req.products.map((id) => {
    const row = ROWS[id];
    if (!row) return { productId: id, closingTime: null, salesBlock: false, logisticModel: null, scheduleLines: [] };
    const stock = id in s.stock ? s.stock[id] : row.stock;
    // The live API leaves closingTime and logisticModel out altogether when there is nothing to deliver
    if (stock === null) return { productId: id, salesBlock: false, scheduleLines: [] } as unknown as ProductAvailability;
    const slot = s.schedule ?? req.requestedDate;
    return {
      productId: id,
      closingTime: closingTime(row.model, slot),
      salesBlock: false,
      logisticModel: row.model,
      scheduleLines: [{ salesBlock: false, availableAmount: stock, availableDate: slot, salesUnit: row.unit }],
    };
  });
  return { timeNow: liveTime(new Date()), requestedDate: `${req.requestedDate}T00:00:00${liveOffset(new Date(`${req.requestedDate}T12:00:00Z`))}`, products };
}

export const ping = async () => ({ status: "ok (fake)" });

/** Controls for tests: count calls, change stock or a price between two steps. */
export const fakeValio = {
  reset() {
    g.__aimoFakeValio = { calls: [], stock: {}, price: {}, schedule: null };
  },
  /**
   * Behave like the live mock API: one delivery slot on this date, with its cut-off, whatever date is asked for.
   * null goes back to a cut-off that moves with the requested date.
   */
  fixSchedule(deliveryDate: string | null) {
    state().schedule = deliveryDate;
  },
  get calls(): Call[] {
    return state().calls;
  },
  count(kind?: Call["kind"]): number {
    return state().calls.filter((c) => !kind || c.kind === kind).length;
  },
  setStock(productId: string, amount: number | null) {
    state().stock[productId] = amount;
  },
  setPrice(productId: string, value: number | null) {
    state().price[productId] = value;
  },
  has: (productId: string) => productId in ROWS,
};
