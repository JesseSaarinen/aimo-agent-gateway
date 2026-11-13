import { quote } from "@/lib/quote";
import { quoteSchema } from "@/lib/schemas";

// POST /api/v1/quote  {productIds, deliveryDate, amount, unit}
// Live price + availability for a shortlist, converted to the requested amount.
export async function POST(req: Request) {
  const parsed = quoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", detail: parsed.error.issues }, { status: 400 });
  }
  try {
    return Response.json(await quote(parsed.data));
  } catch (e) {
    return Response.json({ error: "upstream_error", detail: String(e) }, { status: 502 });
  }
}
