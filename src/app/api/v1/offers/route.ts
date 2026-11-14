import { requireRole } from "@/lib/agents";
import { readJson, withCaller } from "@/lib/http";
import { runTool } from "@/lib/tools";

// POST /api/v1/offers  {deliverySite, deliveryDate, lines: [{productId, amount, unit, substituteFor?}], requirements?}
// A signed offer at fixed prices, valid 30 minutes. Same as the request_offer tool; the signed token is included by default.
export const POST = (req: Request) =>
  withCaller(req, "request_offer", async (caller) => {
    const agent = await requireRole(caller, ["agent"], "request_offer", "access", "Offers are made to agents. Use an agent key.");
    const body = await readJson(req);
    return runTool("request_offer", body && typeof body === "object" ? { includeToken: true, ...body } : body, agent);
  });
