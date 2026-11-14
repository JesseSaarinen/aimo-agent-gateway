// The break-it run: eight things a rogue agent tries. Each must be refused on the server,
// name the rule that stopped it, and leave an entry in the audit log.
import { describe, expect, it, vi } from "vitest";
import { requireCaller } from "@/lib/agents";
import { listAudit } from "@/lib/audit";
import { updateMandate } from "@/lib/mandate";
import { decideLine, getOrder, listOrders, placeOrder } from "@/lib/orders";
import { weekSpend } from "@/lib/spend";
import { fakeValio } from "@/lib/valio-fake";
import { agent, expectRefusal, MILK, offerFor, purchaser, supplier } from "@/test/helpers";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ordersInStore = async () => (await listOrders(supplier())).length;

describe("break-it run", () => {
  it("1. a tampered offer is refused: the price was changed after signing", async () => {
    const { token } = await offerFor([MILK]);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    claims.offer.lines[0].unitPrice = 0.01;
    claims.offer.lines[0].total = 2;
    claims.offer.total = 2;
    const forged = `${header}.${b64(claims)}.${signature}`;

    const entry = await expectRefusal(placeOrder(agent(), { offerToken: forged }), "offer_signature", 422);
    expect(entry).toMatchObject({ action: "place_order", actor: { role: "agent", id: "agent-kitchen" } });
    expect(entry.reason).toContain("changed after Valio Aimo signed it");
    expect(await ordersInStore()).toBe(0);
  });

  it("2. a replayed offer returns the first order and creates nothing", async () => {
    const { offer, token } = await offerFor([MILK]);
    const first = await placeOrder(agent(), { offerId: offer.id });
    const callsAfterFirst = fakeValio.count();

    const second = await placeOrder(agent(), { offerToken: token });
    expect(second).toMatchObject({ replayed: true, rule: "offer_replay", order: { id: first.order.id } });
    expect(second.notice).toBe(`Offer ${offer.id} was already ordered as ${first.order.id}. No new order was created.`);
    expect(await ordersInStore()).toBe(1);
    expect((await weekSpend("lumikello-hotels", new Date())).spent).toBe(1690); // not 3,380
    expect(fakeValio.count()).toBe(callsAfterFirst); // not even a stock check
    expect((await listAudit()).find((e) => e.id === second.auditId)).toMatchObject({ action: "order_replayed", outcome: "refused", rule: "offer_replay", orderId: first.order.id });
  });

  it("3. an order with no offer is refused", async () => {
    await expectRefusal(placeOrder(agent(), {}), "offer_required", 400);
    const entry = await expectRefusal(placeOrder(agent(), { offerId: "off_0000000000000000" }), "offer_required", 404);
    expect(entry.reason).toContain("An order needs a valid offer from request_offer");
    expect(await ordersInStore()).toBe(0);
  });

  it("4. an expired offer is refused", async () => {
    const { offer, token } = await offerFor([MILK]);
    vi.setSystemTime(new Date(Date.parse(offer.expiresAt) + 1000)); // 30 minutes and one second later
    const entry = await expectRefusal(placeOrder(agent(), { offerToken: token }), "offer_expired", 410);
    expect(entry).toMatchObject({ offerId: offer.id });
    expect(entry.reason).toContain("The offer expired on Sat 14 Nov 08:30");
    await expectRefusal(placeOrder(agent(), { offerId: offer.id }), "offer_expired", 410);
    expect(await ordersInStore()).toBe(0);
  });

  it("5. splitting one big order into small ones stops at the weekly budget", async () => {
    // Each order is 4,225 EUR, under the 5,000 EUR order limit. The weekly budget is 15,000 EUR.
    const small = [{ ...MILK, amount: 2500 }];
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { offer } = await offerFor(small);
      statuses.push((await placeOrder(agent(), { offerId: offer.id })).order.status);
    }
    expect(statuses).toEqual(["confirmed", "confirmed", "confirmed", "awaiting_approval"]);
    expect((await weekSpend("lumikello-hotels", new Date())).spent).toBe(12675);

    const [held] = await listOrders(agent());
    expect(held).toMatchObject({ status: "awaiting_approval", totals: { confirmed: 0 }, findings: [{ rule: "weekly_budget", decision: "needs_approval" }] });
    expect(held.findings[0].reason).toBe(
      "This order (4,225.00 €) would bring the week to 16,900.00 €, over the 15,000.00 € weekly budget (12,675.00 € already ordered since Mon 9 Nov)",
    );
    expect((await listAudit({ orderId: held.id })).find((e) => e.action === "line_held")).toMatchObject({ outcome: "needs_approval", rule: "weekly_budget", actor: { id: "agent-kitchen" } });
  });

  it("6. a delivery site outside the mandate is refused", async () => {
    const entry = await expectRefusal(offerFor([MILK], { deliverySite: "stockholm" }), "delivery_site", 403);
    expect(entry.reason).toBe('Delivery site "stockholm" is not in the mandate (allowed: helsinki, tampere, turku, oulu, rovaniemi)');
    expect(fakeValio.count()).toBe(0); // refused before any price or stock is fetched

    // An offer made while the site was allowed is no way around it once the purchaser removes the site
    const { offer } = await offerFor([MILK], { deliverySite: "oulu" });
    await updateMandate(purchaser(), { deliverySites: ["helsinki", "tampere"] });
    await expectRefusal(placeOrder(agent(), { offerId: offer.id }), "delivery_site", 403);
    expect(await ordersInStore()).toBe(0);
  });

  it("7. an agent can't approve its own order", async () => {
    const { offer } = await offerFor([{ ...MILK, amount: 4000 }]); // over the order limit
    const { order } = await placeOrder(agent(), { offerId: offer.id });
    expect(order.status).toBe("awaiting_approval");

    const entry = await expectRefusal(decideLine(agent(), order.id, { line: 1, action: "approve" }), "approval_authority", 403);
    expect(entry).toMatchObject({ action: "order_decision", actor: { role: "agent", id: "agent-kitchen" }, orderId: order.id, line: 1 });
    expect(entry.reason).toContain("An agent can't approve its own order");
    // Nor raise its own limit
    await expectRefusal(updateMandate(agent(), { maxOrderEur: 100000 }), "mandate_authority", 403);
    expect((await getOrder(purchaser(), order.id)).lines[0]).toMatchObject({ status: "awaiting_approval", open: true });
  });

  it("8. an unknown agent key gets nothing", async () => {
    const entry = await expectRefusal(requireCaller("agent_made_up_key", "request_offer"), "agent_identity", 401);
    expect(entry).toMatchObject({ buyerId: null, actor: { role: "unknown" } });
    expect(JSON.stringify(entry)).not.toContain("agent_made_up_key"); // the log keeps a fingerprint, never the key
    await expectRefusal(requireCaller(undefined, "place_order"), "agent_identity", 401);
    expect(fakeValio.count()).toBe(0);
  });
});
