import { requireRole } from "@/lib/agents";
import { readJson, withCaller } from "@/lib/http";
import { quote } from "@/lib/quote";
import { quoteSchema } from "@/lib/schemas";

// POST /api/v1/quote  {productIds, deliveryDate, amount, unit}
// Live price + availability for a shortlist, converted to the requested amount.
// It makes two Valio calls, so it needs an agent key like every other route that reaches Valio:
// without one, anyone could spend the gateway's share of Valio's rate limit.
export const POST = (req: Request) =>
  withCaller(req, "quote", async (caller) => {
    await requireRole(caller, ["agent"], "quote", "access", "This endpoint is for agents. Use an agent key.");
    return quote(quoteSchema.parse(await readJson(req)));
  });
