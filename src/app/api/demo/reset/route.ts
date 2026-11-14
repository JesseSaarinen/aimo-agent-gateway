import { requireRole } from "@/lib/agents";
import { audit } from "@/lib/audit";
import { withCaller } from "@/lib/http";
import { store, storeKind } from "@/lib/store";

// POST /api/demo/reset
// DEMO ONLY, purchaser sign-in needed. Empties the order book, the offers, the audit log and the mandate,
// so the next demo run starts from the seeded state (a real audit log would never have this button).
export const POST = (req: Request) =>
  withCaller(req, "demo_reset", async (caller) => {
    const purchaser = await requireRole(caller, ["purchaser"], "demo_reset", "access", "Only the demo purchaser can reset the demo data.");
    await store.clear();
    await audit({
      buyerId: purchaser.buyerId,
      actor: { role: "purchaser", id: purchaser.id },
      action: "demo_reset",
      outcome: "info",
      rule: null,
      reason: "The demo data was reset: orders, offers, the earlier log and the mandate were cleared.",
    });
    return { reset: true, store: storeKind() };
  });
