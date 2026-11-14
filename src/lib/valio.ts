// Thin client for Valio Aimo's mock pricing and availability APIs.
// Their rule: narrow down with static product data first, then query only the shortlist.
import * as fake from "./valio-fake";

const BASE = process.env.VALIO_API_BASE ?? "https://junction26.valioaimo.fi/api";

// VALIO_FAKE=1 swaps the live API for the fixtures in valio-fake.ts (tests, `npm run dev:fake`).
// It is ignored in production builds, so a deployed demo can never serve fake data by accident.
export const usingFakeValio = () => process.env.VALIO_FAKE === "1" && process.env.NODE_ENV !== "production";

export const valioSource = () =>
  usingFakeValio() ? "FAKE Valio data (test fixtures, not the live API)" : "Valio Aimo mock API (price + availability)";

function key(): string {
  const k = process.env.VALIO_API_KEY;
  if (!k) throw new Error("VALIO_API_KEY is not set");
  return k;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-API-Key": key(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Valio API ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type ProductsRequest = {
  customer: string;
  requestedDate: string; // YYYY-MM-DD, desired delivery date
  products: string[]; // 1–1000 product codes
};

export type ScheduleLine = {
  salesBlock: boolean;
  availableAmount: number;
  availableDate: string | null;
  salesUnit: string;
};

export type ProductAvailability = {
  productId: string;
  closingTime: string | null; // order cut-off for the requested date
  salesBlock: boolean;
  logisticModel: string | null; // "Stock" | "Terminal"
  scheduleLines: ScheduleLine[];
};

export type Price = {
  value: number;
  valueWithTax: number;
  validFrom: string;
  validTo: string;
  currency: string;
};

export type ProductPrice = {
  productId: string;
  quantity: number;
  catalogPrice: Price | null;
  comparisonPrice: Price | null;
  comparisonUnit: string | null; // e.g. "L", "KG"
  listPrice: Price | null;
  tax: { taxRate: number; taxValue: number } | null;
  netPriceFound: boolean;
  error: boolean;
};

export type AvailabilityResponse = { timeNow: string; requestedDate: string; products: ProductAvailability[] };
export type PriceResponse = { customerId: string; currency: string; pricingDate: string; products: ProductPrice[] };

export const ping = (): Promise<{ status: string }> => (usingFakeValio() ? fake.ping() : call("/ping"));

// What the live API sends (seen Sat 14 Nov 2026) and this file tidies before anything else reads it:
//   - times carry the Helsinki offset without a colon ("2026-11-12T15:00:00+0200"). Node reads that,
//     Safari does not, and offers pass these strings on to browsers, so they become "+02:00";
//   - a product that can't be delivered has an empty `scheduleLines` and no `closingTime` or `logisticModel` at all.

/** "2026-11-12T15:00:00+0200" → "2026-11-12T15:00:00+02:00". Anything else is returned as it is. */
export const isoTime = <T extends string | null | undefined>(t: T): T => (t ? (t.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") as T) : t);

const tidyPrice = (p: Price | null | undefined): Price | null => (p ? { ...p, validFrom: isoTime(p.validFrom), validTo: isoTime(p.validTo) } : null);

export async function getAvailability(req: ProductsRequest): Promise<AvailabilityResponse> {
  const res: AvailabilityResponse = await (usingFakeValio() ? fake.getAvailability(req) : call("/availability", req));
  return {
    ...res,
    timeNow: isoTime(res.timeNow),
    requestedDate: isoTime(res.requestedDate),
    products: (res.products ?? []).map((p) => ({
      ...p,
      closingTime: isoTime(p.closingTime) ?? null,
      salesBlock: !!p.salesBlock,
      logisticModel: p.logisticModel ?? null,
      scheduleLines: p.scheduleLines ?? [],
    })),
  };
}

export async function getPrices(req: ProductsRequest): Promise<PriceResponse> {
  const res: PriceResponse = await (usingFakeValio() ? fake.getPrices(req) : call("/price", req));
  return {
    ...res,
    pricingDate: isoTime(res.pricingDate),
    products: (res.products ?? []).map((p) => ({
      ...p,
      catalogPrice: tidyPrice(p.catalogPrice),
      comparisonPrice: tidyPrice(p.comparisonPrice),
      listPrice: tidyPrice(p.listPrice),
    })),
  };
}
