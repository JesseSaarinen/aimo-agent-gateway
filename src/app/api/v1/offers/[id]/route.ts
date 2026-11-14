import { withCaller } from "@/lib/http";
import { getOffer } from "@/lib/offers";

// GET /api/v1/offers/{id}
// The stored offer with its signed token. For the agent it was made for, the buyer's purchaser and Valio Aimo.
export const GET = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  withCaller(req, "read_offer", async (caller) => getOffer(caller, (await ctx.params).id));
