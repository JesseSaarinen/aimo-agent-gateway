// The tools as an agent calls them: by name, with plain JSON arguments. REST and MCP both go through runTool.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentCaller } from "@/lib/agents";
import { runTool, TOOLS } from "@/lib/tools";
import { agent, otherAgent } from "@/test/helpers";
import { MONDAY } from "@/test/setup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are plain JSON, as an agent sees them
const call = (name: string, args: unknown, caller = agent()) => runTool(name, args, caller as AgentCaller) as Promise<any>;

describe("agent tools", () => {
  it("are the six from the plan, each with a description and an object schema an MCP client can read", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["search_products", "find_options", "request_offer", "verify_offer", "place_order", "get_order_status"]);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(200);
      expect(z.toJSONSchema(t.input, { io: "input" })).toMatchObject({ type: "object" });
    }
  });

  it("milk run through the tools: search, options, offer, verify, order, status", async () => {
    const search = await call("search_products", { query: "maito laktoositon", requirements: ["lactose_free"], limit: 5 });
    expect(search.total).toBeGreaterThan(10);
    expect(search.products[0]).toHaveProperty("requirements.lactose_free", "yes");

    const found = await call("find_options", { query: "maito laktoositon", amount: 1000, unit: "L", deliveryDate: MONDAY });
    expect(found).toMatchObject({ possible: true, source: "FAKE Valio data (test fixtures, not the live API)" });
    const productId = found.options[0].parts[0].productId;

    const offered = await call("request_offer", { deliverySite: "helsinki", deliveryDate: MONDAY, lines: [{ productId, amount: 1000, unit: "L" }] });
    expect(offered).toMatchObject({ decision: "allowed", total: 1010, validMinutes: 30, summary: { allowed: 1 } });
    expect(offered.signature.token).toBeUndefined(); // only on request: it is a long string an agent doesn't need
    expect(offered.next).toContain(`place_order with offerId "${offered.offerId}"`);

    expect(await call("verify_offer", { offerId: offered.offerId })).toMatchObject({ valid: true, alreadyOrdered: null });

    const placed = await call("place_order", { offerId: offered.offerId });
    expect(placed).toMatchObject({ replayed: false, order: { status: "confirmed", totals: { confirmed: 1010 } } });

    expect(await call("verify_offer", { offerId: offered.offerId })).toMatchObject({ valid: true, alreadyOrdered: placed.order.id });
    expect(await call("get_order_status", { orderId: placed.order.id })).toMatchObject({ status: "confirmed", summary: { confirmed: 1 } });
    expect(await call("get_order_status", {})).toMatchObject({ total: 1, orders: [{ id: placed.order.id, status: "confirmed" }] });
    expect(await call("get_order_status", {}, otherAgent())).toMatchObject({ total: 0 });
  });

  it("returns the signed token when asked, and verifies it", async () => {
    const offered = await call("request_offer", { deliverySite: "helsinki", deliveryDate: MONDAY, lines: [{ productId: "465039", amount: 100, unit: "L" }], includeToken: true });
    expect(offered.signature.token.split(".")).toHaveLength(3);
    expect(await call("verify_offer", { offerToken: offered.signature.token })).toMatchObject({ valid: true });
    // Another agent can't look the offer up by id, but anyone holding the token can check it
    await expect(call("verify_offer", { offerId: offered.offerId }, otherAgent())).rejects.toMatchObject({ rule: "access" });
    expect(await call("verify_offer", { offerToken: offered.signature.token }, otherAgent())).toMatchObject({ valid: true });
  });

  it("rejects malformed input before anything happens", async () => {
    await expect(call("find_options", { query: "maito", amount: -5, unit: "L", deliveryDate: "next monday" })).rejects.toBeInstanceOf(z.ZodError);
    await expect(call("request_offer", { deliverySite: "helsinki", deliveryDate: MONDAY, lines: [] })).rejects.toBeInstanceOf(z.ZodError);
    await expect(call("no_such_tool", {})).rejects.toMatchObject({ rule: "invalid_request" });
  });
});
