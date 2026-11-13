// Product search over the static catalog (no API calls).
// Valio's rule: narrow down here first, then call price/availability only for the shortlist.
import rawIndex from "@/generated/products-index.json";

export type Product = {
  id: string;
  nameFi: string | null;
  nameEn: string | null;
  nameSv: string | null;
  brand: string | null;
  vendor: string;
  category: string;
  salesUnit: string;
  baseUnit: string;
  units: { unit: string; baseUnits: number }[];
  lotSize: number;
  origin: string | null;
  temperature: number | null;
  litresPerBaseUnit: number | null;
  kgPerBaseUnit: number | null;
  allergenDataKnown: boolean;
  contains: string[];
  mayContain: string[];
  freeFrom: string[];
  claims: string[];
  labels: string[];
  substitutes: string[];
  deliveryReliability: number | null;
  co2PerKg: number | null;
};

const products = rawIndex as Product[];
const byId = new Map(products.map((p) => [p.id, p]));

export const getProduct = (id: string) => byId.get(id) ?? null;
export const productCount = products.length;

// GS1 allergen codes used in the data
export const ALLERGENS: Record<string, string> = {
  AC: "crustaceans", AE: "egg", AF: "fish", AM: "milk", AN: "tree nuts", AP: "peanuts",
  AS: "sesame", AU: "sulphites", AW: "gluten cereals", AY: "soy", BC: "celery", BM: "mustard",
  ML: "lactose", NL: "lupin", UM: "molluscs", UW: "wheat", GB: "barley", GO: "oats", NR: "rye",
};

export type Verdict = "yes" | "no" | "unknown";

/** A requirement the buyer can set, e.g. "lactose_free". Unknown means the data can't tell. */
export const REQUIREMENTS = {
  lactose_free: "Lactose-free",
  gluten_free: "Gluten-free",
  milk_free: "No milk",
  egg_free: "No egg",
  nut_free: "No tree nuts or peanuts",
  fish_free: "No fish",
  soy_free: "No soy",
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  organic: "EU organic",
  finnish: "Finnish origin",
} as const;
export type Requirement = keyof typeof REQUIREMENTS;

function allergenFree(p: Product, codes: string[]): Verdict {
  if (codes.some((c) => p.contains.includes(c) || p.mayContain.includes(c))) return "no";
  if (codes.every((c) => p.freeFrom.includes(c))) return "yes";
  return p.allergenDataKnown ? "yes" : "unknown";
}

export function checkRequirement(p: Product, r: Requirement): Verdict {
  switch (r) {
    case "lactose_free":
      if (p.claims.includes("FREE_FROM_LACTOSE") || p.freeFrom.includes("ML")) return "yes";
      return allergenFree(p, ["ML", "AM"]);
    case "gluten_free":
      if (p.claims.includes("FREE_FROM_GLUTEN")) return "yes";
      return allergenFree(p, ["AW", "UW", "GB", "NR"]);
    case "milk_free":
      return allergenFree(p, ["AM"]);
    case "egg_free":
      return p.claims.includes("FREE_FROM_EGGS") ? "yes" : allergenFree(p, ["AE"]);
    case "nut_free":
      return allergenFree(p, ["AN", "AP"]);
    case "fish_free":
      return allergenFree(p, ["AF"]);
    case "soy_free":
      return p.claims.includes("FREE_FROM_SOY") ? "yes" : allergenFree(p, ["AY"]);
    case "vegan":
      if (p.claims.includes("VEGAN")) return "yes";
      return ["AM", "AE", "AF", "AC", "UM"].some((c) => p.contains.includes(c)) ? "no" : "unknown";
    case "vegetarian":
      if (p.claims.includes("VEGETARIAN") || p.claims.includes("VEGAN")) return "yes";
      return ["AF", "AC", "UM"].some((c) => p.contains.includes(c)) ? "no" : "unknown";
    case "organic":
      return p.labels.includes("EU_ORGANIC_FARMING") ? "yes" : "no";
    case "finnish":
      return p.origin === "fi" ||
        p.labels.includes("GOODS_FROM_FINLAND_BLUE_SWAN") ||
        p.labels.includes("MADE_IN_FINLAND_FLAG_WITH_KEY")
        ? "yes"
        : "no";
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[®™]/g, "");
const haystack = new Map(
  products.map((p) => [p.id, norm([p.nameFi, p.nameEn, p.nameSv, p.brand, p.vendor].filter(Boolean).join(" "))]),
);

export type SearchInput = {
  query: string;
  requirements?: Requirement[];
  /** Also return products where a requirement is "unknown" (flagged). Default true. */
  includeUnknown?: boolean;
  limit?: number;
};

export type SearchHit = {
  product: Product;
  name: string;
  requirements: Record<string, Verdict>;
  matchedTerms: number;
};

export function searchProducts({ query, requirements = [], includeUnknown = true, limit = 20 }: SearchInput) {
  const terms = norm(query).split(/\s+/).filter((t) => t.length > 1);
  const hits: SearchHit[] = [];
  for (const p of products) {
    const text = haystack.get(p.id)!;
    const matched = terms.filter((t) => text.includes(t)).length;
    if (terms.length && matched < terms.length) continue; // every term must match
    const verdicts: Record<string, Verdict> = {};
    let excluded = false;
    for (const r of requirements) {
      const v = checkRequirement(p, r);
      verdicts[r] = v;
      if (v === "no" || (v === "unknown" && !includeUnknown)) excluded = true;
    }
    if (excluded) continue;
    hits.push({ product: p, name: p.nameEn ?? p.nameFi ?? p.id, requirements: verdicts, matchedTerms: matched });
  }
  // Fully confirmed first, then more reliable delivery
  const unknowns = (h: SearchHit) => Object.values(h.requirements).filter((v) => v === "unknown").length;
  hits.sort(
    (a, b) => unknowns(a) - unknowns(b) || (b.product.deliveryReliability ?? 0.9) - (a.product.deliveryReliability ?? 0.9),
  );
  return { total: hits.length, hits: hits.slice(0, limit) };
}
