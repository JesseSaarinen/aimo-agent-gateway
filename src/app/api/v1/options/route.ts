import { requireRole } from "@/lib/agents";
import { readJson, withCaller } from "@/lib/http";
import { runTool } from "@/lib/tools";

// POST /api/v1/options  {query | productId, amount, unit, deliveryDate, requirements?}
// Up to three ranked, quoted options for something the buyer needs. Same as the find_options tool.
export const POST = (req: Request) =>
  withCaller(req, "find_options", async (caller) => {
    const agent = await requireRole(caller, ["agent"], "find_options", "access", "This endpoint is for agents. Use an agent key.");
    return runTool("find_options", await readJson(req), agent);
  });
