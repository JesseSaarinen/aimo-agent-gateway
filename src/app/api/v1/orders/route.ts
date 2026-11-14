import { requireRole } from "@/lib/agents";
import { readJson, withCaller } from "@/lib/http";
import { listOrders, orderView } from "@/lib/orders";
import { runTool } from "@/lib/tools";

// POST /api/v1/orders  {offerId} or {offerToken}
// Place an order on a signed offer. Same as the place_order tool.
export const POST = (req: Request) =>
  withCaller(req, "place_order", async (caller) => {
    const agent = await requireRole(caller, ["agent"], "place_order", "access", "Orders are placed by agents. Use an agent key.");
    return runTool("place_order", (await readJson(req)) ?? {}, agent);
  });

// GET /api/v1/orders
// Newest first. An agent sees its own orders, the purchaser the buyer's (the approval inbox), Valio Aimo all.
export const GET = (req: Request) =>
  withCaller(req, "list_orders", async (caller) => {
    const orders = (await listOrders(caller)).map(orderView);
    return { total: orders.length, awaitingApproval: orders.filter((o) => o.status === "awaiting_approval").length, orders };
  });
