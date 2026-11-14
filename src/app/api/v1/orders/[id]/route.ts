import { withCaller } from "@/lib/http";
import { getOrder, orderView } from "@/lib/orders";

// GET /api/v1/orders/{id}
export const GET = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  withCaller(req, "read_order", async (caller) => orderView(await getOrder(caller, (await ctx.params).id)));
