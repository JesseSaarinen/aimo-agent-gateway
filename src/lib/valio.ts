// Thin client for Valio Aimo's mock pricing and availability APIs.
// Their rule: narrow down with static product data first, then query only the shortlist.

const BASE = process.env.VALIO_API_BASE ?? "https://junction26.valioaimo.fi/api";

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

export const ping = () => call<{ status: string }>("/ping");

export const getAvailability = (req: ProductsRequest) =>
  call<{ timeNow: string; requestedDate: string; products: ProductAvailability[] }>("/availability", req);

export const getPrices = (req: ProductsRequest) =>
  call<{ customerId: string; currency: string; pricingDate: string; products: ProductPrice[] }>("/price", req);
