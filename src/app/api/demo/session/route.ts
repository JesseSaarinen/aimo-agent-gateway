import { z } from "zod";
import { DEMO_COOKIES, errorResponse, readJson } from "@/lib/http";

const schema = z.object({ role: z.enum(["purchaser", "supplier"]) });

// POST /api/demo/session  {role: "purchaser" | "supplier"}
// DEMO ONLY. Signs this browser in as the demo buyer's purchaser, or as Valio Aimo's read-only viewer.
// It stands in for a real login, which is out of scope: anyone who opens the demo can be the purchaser.
// What it does not change: an agent key can never approve, whoever holds it.
export async function POST(req: Request) {
  try {
    const { role } = schema.parse(await readJson(req));
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return Response.json(
      { signedInAs: role },
      { headers: { "Set-Cookie": `${DEMO_COOKIES[role]}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}` } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
