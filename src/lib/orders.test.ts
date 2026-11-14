import { describe, expect, it, vi } from "vitest";
import { DEMO_MANDATE_ID } from "@/lib/agents";
import { listAudit } from "@/lib/audit";
import { getMandate, updateMandate } from "@/lib/mandate";
import { findOptions } from "@/lib/options";
import { decideLine, getOrder, listOrders, placeOrder } from "@/lib/orders";
import { weekSpend } from "@/lib/spend";
import { fakeValio } from "@/lib/valio-fake";
import { agent, expectRefusal, MILK, offerFor, otherAgent, purchaser, supplier } from "@/test/helpers";
import { MONDAY } from "@/test/setup";

const order = async (lines: Parameters<typeof offerFor>[0]) => {
  const { offer } = await offerFor(lines);
  return (await placeOrder(agent(), { offerId: offer.id })).order;
};
const actions = async (orderId: string) => (await listAudit({ orderId })).map((e) => e.action).reverse();

describe("milk run: 1,000 l lactose-free milk by Monday", () => {
  it("goes from search words to a confirmed order without a human", async () => {
    // 1. The agent asks what can be delivered
    const found = await findOptions(await getMandate(DEMO_MANDATE_ID), { query: "maito laktoositon", amount: 1000, unit: "L", deliveryDate: MONDAY, requirements: ["lactose_free"] });
    const best = found.options[0];
    expect(best).toMatchObject({ decision: "allowed", parts: [{ productId: "464398", quantity: 1000, salesUnit: "ST" }] });

    // 2. It asks for a signed offer on the best option
    const { offer } = await offerFor([{ productId: best.parts[0].productId, amount: 1000, unit: "L" }]);
    expect(offer).toMatchObject({ decision: "allowed", total: 1620 });

    // 3. It orders. Inside the mandate and in stock, so nobody has to approve.
    const placed = await placeOrder(agent(), { offerId: offer.id });
    expect(placed.replayed).toBe(false);
    expect(placed.order).toMatchObject({
      status: "confirmed",
      deliveryDate: MONDAY,
      deliverySite: "helsinki",
      totals: { confirmed: 1620, awaitingApproval: 0 },
      summary: { confirmed: 1, awaitingApproval: 0, blocked: 0, rejected: 0 },
    });
    expect(placed.order.lines[0]).toMatchObject({
      status: "confirmed",
      open: false,
      fulfilment: [{ productId: "464398", quantity: 1000, unitPrice: 1.62, total: 1620, deliveryDate: MONDAY }],
      resolution: { action: "confirmed_alone", by: { role: "gateway" } },
    });
    expect(placed.order.message).toBe(`Order ${placed.order.id} for Mon 16 Nov to helsinki: 1 line confirmed (1,620.00 €).`);

    // Search (2 calls), offer (2), stock check at order time (1)
    expect(fakeValio.count()).toBe(5);
    expect(await actions(placed.order.id)).toEqual(["line_confirmed", "order_placed"]);
    const [entry] = (await listAudit({ orderId: placed.order.id })).reverse();
    expect(entry).toMatchObject({ actor: { role: "agent", id: "agent-kitchen" }, outcome: "allowed", line: 1 });
    expect(entry.reason).toContain("confirmed without a human");
  });

  it("the same order can be placed with the signed token instead of the offer id", async () => {
    const { token } = await offerFor([MILK]);
    expect((await placeOrder(agent(), { offerToken: token })).order.status).toBe("confirmed");
  });
});

describe("menu run: seven lines, two exceptions", () => {
  const BASKET = [
    { productId: "463232", amount: 225, unit: "KG" }, // chicken: past cut-off
    { productId: "463968", amount: 40, unit: "ST" }, // parmesan: no allergen data
    { productId: "472332", amount: 60, unit: "ST" }, // rice
    { productId: "467239", amount: 80, unit: "KG" }, // cucumber, 1 kg each
    { productId: "473237", amount: 100, unit: "ST" }, // salad mix
    { productId: "462080", amount: 30, unit: "L" }, // vinaigrette, 1 l bottles
    { productId: "465039", amount: 200, unit: "L" }, // milk
  ];

  it("confirms the five lines inside the mandate and holds the two exceptions for the purchaser", async () => {
    const placed = await order(BASKET);
    expect(placed.lines.map((l) => l.status)).toEqual(["blocked", "awaiting_approval", "confirmed", "confirmed", "confirmed", "confirmed", "confirmed"]);
    expect(placed.status).toBe("awaiting_approval");
    expect(placed.totals).toEqual({ confirmed: 1875, awaitingApproval: 158 });

    const [chicken, parmesan] = placed.lines;
    expect(chicken).toMatchObject({ open: true, findings: [{ rule: "order_cutoff" }], fulfilment: [] });
    expect(chicken.options.map((o) => o.kind)).toEqual(["product", "later_date"]);
    expect(parmesan).toMatchObject({ open: true, findings: [{ rule: "missing_allergen_data" }] });
    expect(parmesan.options).toEqual([]); // the listed substitute contains milk, so it is not offered: approve or reject

    // The purchaser approves the parmesan as it is, and takes Valio's listed substitute for the chicken
    await decideLine(purchaser(), placed.id, { line: 2, action: "approve", note: "Parmesan is fine for this menu" });
    const done = await decideLine(purchaser(), placed.id, { line: 1, action: "pick_option", option: 1 });
    expect(done.status).toBe("confirmed");
    expect(done.lines[0]).toMatchObject({
      status: "confirmed",
      fulfilment: [{ productId: "472673", quantity: 226, total: 2214.8 }],
      resolution: { action: "option_picked", option: 1, by: { role: "purchaser", id: "purchaser-lumikello" } },
    });
    expect(done.totals).toEqual({ confirmed: 4247.8, awaitingApproval: 0 });

    expect(await actions(placed.id)).toEqual([
      "line_blocked", "line_held", "line_confirmed", "line_confirmed", "line_confirmed", "line_confirmed", "line_confirmed", "order_placed",
      "line_approved", "option_picked",
    ]);
    const log = await listAudit({ orderId: placed.id });
    expect(log.find((e) => e.action === "line_approved")).toMatchObject({ actor: { role: "purchaser" }, rule: "missing_allergen_data", outcome: "approved", line: 2 });
    expect(log.find((e) => e.action === "line_approved")!.reason).toContain("Note: Parmesan is fine for this menu");
    expect(log.find((e) => e.action === "option_picked")).toMatchObject({ rule: "order_cutoff", line: 1 });
  });

  it("the purchaser can take the later date instead, or reject a line", async () => {
    const placed = await order(BASKET);
    const later = await decideLine(purchaser(), placed.id, { line: 1, action: "pick_option", option: 2 });
    expect(later.lines[0].fulfilment).toMatchObject([{ productId: "463232", quantity: 225, deliveryDate: "2026-11-18" }]);
    const rejected = await decideLine(purchaser(), placed.id, { line: 2, action: "reject" });
    expect(rejected.lines[1]).toMatchObject({ status: "rejected", open: false, total: 0 });
    expect(rejected.status).toBe("confirmed");
    // A closed line can't be decided twice
    await expect(decideLine(purchaser(), placed.id, { line: 2, action: "approve" })).rejects.toMatchObject({ rule: "invalid_request", http: 409 });
  });

  it("a blocked line can't be approved as it is, only replaced or rejected", async () => {
    const placed = await order(BASKET);
    const entry = await expectRefusal(decideLine(purchaser(), placed.id, { line: 1, action: "approve" }), "order_cutoff", 409);
    expect(entry.reason).toContain("Pick one of its options or reject it");
  });
});

describe("raising the limit", () => {
  const BIG = [{ ...MILK, amount: 4000 }]; // 6,760 EUR, over the 5,000 EUR order limit

  it("an order over the limit waits for the purchaser", async () => {
    const placed = await order(BIG);
    expect(placed).toMatchObject({ status: "awaiting_approval", findings: [{ rule: "order_limit" }], totals: { confirmed: 0, awaitingApproval: 6760 } });
    expect(placed.lines[0]).toMatchObject({ status: "awaiting_approval", decision: "needs_approval", findings: [{ rule: "order_limit" }] });
    const approved = await decideLine(purchaser(), placed.id, { line: 1, action: "approve" });
    expect(approved).toMatchObject({ status: "confirmed", totals: { confirmed: 6760 } });
  });

  it("after the purchaser raises the limit, the same request goes through alone", async () => {
    expect((await order(BIG)).status).toBe("awaiting_approval");
    await updateMandate(purchaser(), { maxOrderEur: 8000 });
    const again = await order(BIG);
    expect(again).toMatchObject({ status: "confirmed", findings: [], mandateVersion: 2, totals: { confirmed: 6760 } });
  });

  it("an offer made before the change is judged by the mandate as it is when the order is placed", async () => {
    const { offer } = await offerFor(BIG);
    expect(offer.findings).toMatchObject([{ rule: "order_limit" }]);
    await updateMandate(purchaser(), { maxOrderEur: 8000 });
    expect((await placeOrder(agent(), { offerId: offer.id })).order.status).toBe("confirmed");

    // And the other way round: lowering the limit holds back an offer that looked fine
    const second = await offerFor([MILK]);
    expect(second.offer.decision).toBe("allowed");
    await updateMandate(purchaser(), { maxOrderEur: 1000 });
    expect((await placeOrder(agent(), { offerId: second.offer.id })).order.status).toBe("awaiting_approval");
  });
});

describe("stock is checked again", () => {
  it("when the order is placed", async () => {
    const { offer } = await offerFor([{ productId: "472673", amount: 100, unit: "KG" }]);
    expect(offer.decision).toBe("allowed");
    fakeValio.setStock("472673", 10); // someone else bought it in the meantime
    const { order: placed } = await placeOrder(agent(), { offerId: offer.id });
    expect(placed).toMatchObject({ status: "rejected", totals: { confirmed: 0 } });
    expect(placed.lines[0]).toMatchObject({ status: "blocked", findings: [{ rule: "stock", reason: "Only 10 KG in stock for Mon 16 Nov, need 100" }] });
  });

  it("when the cut-off passes between the offer and the order", async () => {
    vi.setSystemTime(new Date("2026-11-15T16:50:00+02:00")); // Sunday, ten minutes before Stock products close for Monday
    const { offer } = await offerFor([MILK]);
    expect(offer.decision).toBe("allowed");
    vi.setSystemTime(new Date("2026-11-15T17:05:00+02:00")); // the offer is still valid, the cut-off is not
    const { order: placed } = await placeOrder(agent(), { offerId: offer.id });
    expect(placed.lines[0]).toMatchObject({ status: "blocked", findings: [{ rule: "order_cutoff", reason: "Order cut-off for Mon 16 Nov passed on Sun 15 Nov 17:00" }] });
  });

  it("when the purchaser approves", async () => {
    const placed = await order([{ productId: "462281", amount: 100, unit: "KG" }]); // no allergen data
    expect(placed.lines[0].status).toBe("awaiting_approval");
    fakeValio.setStock("462281", 44);
    await expectRefusal(decideLine(purchaser(), placed.id, { line: 1, action: "approve" }), "stock", 409);
    const after = await getOrder(purchaser(), placed.id);
    expect(after.lines[0]).toMatchObject({ status: "blocked", open: true }); // still open: it has options to pick from
    const picked = await decideLine(purchaser(), placed.id, { line: 1, action: "pick_option", option: 1 });
    expect(picked.lines[0].fulfilment[0].productId).toBe("472673");
  });
});

describe("who can see and do what", () => {
  it("an offer made for one agent can't be ordered by another", async () => {
    const { offer, token } = await offerFor([MILK]);
    await expectRefusal(placeOrder(otherAgent(), { offerToken: token }), "offer_owner", 403);
    await expectRefusal(placeOrder(otherAgent(), { offerId: offer.id }), "offer_owner", 403);
    expect(await listOrders(supplier())).toEqual([]);
  });

  it("an agent sees its own orders, the purchaser the buyer's, Valio Aimo all", async () => {
    const mine = await order([MILK]);
    expect((await listOrders(agent())).map((o) => o.id)).toEqual([mine.id]);
    expect(await listOrders(otherAgent())).toEqual([]);
    expect((await listOrders(purchaser())).map((o) => o.id)).toEqual([mine.id]);
    expect((await listOrders(supplier())).map((o) => o.id)).toEqual([mine.id]);
    await expectRefusal(getOrder(otherAgent(), mine.id), "access", 404);
  });

  it("only confirmed lines count towards the week", async () => {
    await order([MILK]); // 1,690 confirmed
    await order([{ productId: "462281", amount: 100, unit: "KG" }]); // waits for approval
    expect(await weekSpend("lumikello-hotels", new Date())).toEqual({ spent: 1690, weekFrom: "2026-11-09" });
  });
});
