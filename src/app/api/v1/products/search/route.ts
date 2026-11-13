import { productCount, searchProducts, REQUIREMENTS, ALLERGENS } from "@/lib/catalog";
import { searchSchema } from "@/lib/schemas";

// GET /api/v1/products/search?query=maito+laktoositon&requirements=lactose_free,finnish&limit=10
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = searchSchema.safeParse({
    query: sp.get("query") ?? sp.get("q") ?? "",
    requirements: sp.get("requirements")?.split(",").filter(Boolean) ?? [],
    includeUnknown: sp.get("includeUnknown") !== "false",
    limit: sp.has("limit") ? Number(sp.get("limit")) : undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", detail: parsed.error.issues, requirements: REQUIREMENTS }, { status: 400 });
  }
  const { total, hits } = searchProducts(parsed.data);
  return Response.json({
    source: `Valio Aimo static product data (${productCount} products)`,
    retrievedAt: new Date().toISOString(),
    total,
    products: hits.map(({ product: p, name, requirements }) => ({
      id: p.id,
      name,
      nameFi: p.nameFi,
      brand: p.brand,
      salesUnit: p.salesUnit,
      requirements,
      contains: p.contains.map((c) => ALLERGENS[c] ?? c),
      allergenDataKnown: p.allergenDataKnown,
      labels: p.labels,
      deliveryReliability: p.deliveryReliability,
      co2PerKg: p.co2PerKg,
      substitutes: p.substitutes,
    })),
  });
}
