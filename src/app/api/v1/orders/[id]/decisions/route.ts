import { requireRole } from "@/lib/agents";
import { readJson, withCaller } from "@/lib/http";
import { decideLine, getOrder, orderView } from "@/lib/orders";
import { decisionsSchema } from "@/lib/schemas";

// POST /api/v1/orders/{id}/decisions
//   {line, action: "approve" | "reject" | "pick_option", option?, note?}   or   {decisions: [ ...the same... ]}
// The purchaser's decisions on the open lines of an order. Purchaser key only: an agent key is refused.
// Decisions are applied in order; the first one that is refused stops the rest.
export const POST = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  withCaller(req, "order_decision", async (caller) => {
    const { id } = await ctx.params;
    // Authority first, so an agent's attempt is refused and logged whatever it sent
    await requireRole(
      caller,
      ["purchaser"],
      "order_decision",
      "approval_authority",
      "Only the buyer's purchaser can approve, reject or change an order line. An agent can't approve its own order.",
      { orderId: id },
    );
    for (const decision of decisionsSchema.parse(await readJson(req))) await decideLine(caller, id, decision);
    return orderView(await getOrder(caller, id));
  });
