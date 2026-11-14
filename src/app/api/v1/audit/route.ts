import { requireRole } from "@/lib/agents";
import { listAudit } from "@/lib/audit";
import { withCaller } from "@/lib/http";
import { RULES } from "@/lib/rules";

// GET /api/v1/audit?orderId=&limit=
// Every decision the gateway made: who, what, which rule and why. Newest first.
// The buyer's purchaser sees the buyer's entries; Valio Aimo sees all, including calls with unknown keys.
export const GET = (req: Request) =>
  withCaller(req, "read_audit", async (caller) => {
    const reader = await requireRole(caller, ["purchaser", "supplier"], "read_audit", "access", "The audit log is for the buyer's purchaser and Valio Aimo.");
    const sp = new URL(req.url).searchParams;
    const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), 500);
    const entries = await listAudit({ buyerId: reader.role === "purchaser" ? reader.buyerId : undefined, orderId: sp.get("orderId") ?? undefined, limit });
    return { total: entries.length, entries: entries.map((e) => ({ ...e, ruleName: e.rule ? RULES[e.rule] : null })) };
  });
