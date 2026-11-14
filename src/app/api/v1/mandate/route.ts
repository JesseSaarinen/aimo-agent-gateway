import { buyerIdOf, DEMO_BUYER, DEMO_MANDATE_ID, requireRole } from "@/lib/agents";
import { readJson, withCaller } from "@/lib/http";
import { updateMandate } from "@/lib/mandate";
import { mandatePatchSchema } from "@/lib/schemas";
import { weekSpend } from "@/lib/spend";
import { mandateView } from "@/lib/tools";

// The demo has one buyer and one mandate, so Valio Aimo's read-only view shows that one.
async function view(buyerId: string | null, mandateId?: string) {
  const buyer = buyerId ?? DEMO_BUYER.id;
  return mandateView(mandateId ?? DEMO_MANDATE_ID, buyer, await weekSpend(buyer, new Date()));
}

// GET /api/v1/mandate
// The mandate as data and as sentences, the buyer's delivery sites and this week's spend.
export const GET = (req: Request) =>
  withCaller(req, "read_mandate", (caller) => view(buyerIdOf(caller), caller.role === "supplier" ? undefined : caller.mandateId));

// PATCH /api/v1/mandate  {maxOrderEur?, weeklyBudgetEur?, deliverySites?, latestDeliveryDays?, requiredProperties?, substitutions?}
// Purchaser key only. The change applies from the next order on, including orders on offers made earlier.
const update = (req: Request) =>
  withCaller(req, "mandate_update", async (caller) => {
    const purchaser = await requireRole(caller, ["purchaser"], "mandate_update", "mandate_authority", "Only the buyer's purchaser can change the mandate.");
    await updateMandate(purchaser, mandatePatchSchema.parse(await readJson(req)));
    return view(purchaser.buyerId, purchaser.mandateId);
  });
export { update as PATCH, update as PUT };
