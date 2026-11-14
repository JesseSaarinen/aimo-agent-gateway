import { describe, expect, it } from "vitest";
import { DEMO_MANDATE_ID } from "@/lib/agents";
import { getMandate } from "@/lib/mandate";
import { findOptions, MAX_LATER_DATE_CALLS } from "@/lib/options";
import { fakeValio } from "@/lib/valio-fake";
import { MONDAY } from "@/test/setup";

const find = async (input: { query?: string; productId?: string; amount: number; unit: string }) =>
  findOptions(await getMandate(DEMO_MANDATE_ID), { deliveryDate: MONDAY, requirements: [], ...input });

const ids = (r: Awaited<ReturnType<typeof find>>) => r.options.map((o) => `${o.kind}:${o.parts.map((p) => p.productId).join("+")}`);

describe("find_options from search words", () => {
  it("milk run: 1,000 l lactose-free milk for Monday gets Stock products, cheapest per litre first", async () => {
    const r = await find({ query: "maito laktoositon", amount: 1000, unit: "litres" });
    expect(ids(r)).toEqual(["product:464398", "product:465039"]);
    expect(r.options[0]).toMatchObject({ rank: 1, decision: "allowed", pricePerUnit: 1.62, total: 1620, relation: "search_match" });
    expect(r.options[1].parts[0]).toMatchObject({ quantity: 200, salesUnit: "KI", covers: 1000, deliveryDate: MONDAY });
    // The Terminal products are named with the reason, not silently dropped
    expect(r.notOffered.find((n) => n.productId === "463038")?.reason).toBe("Order cut-off for Mon 16 Nov passed on Thu 12 Nov 15:00");
    expect(fakeValio.count()).toBe(2); // one price call, one availability call
  });

  it("says so when the search finds nothing", async () => {
    const r = await find({ query: "yksisarvisen maito", amount: 10, unit: "L" });
    expect(r.possible).toBe(false);
    expect(r.options).toEqual([]);
    expect(r.message).toContain("The gateway does not guess");
    expect(fakeValio.count()).toBe(0);
  });
});

describe("options for a named product", () => {
  it("cut-off passed: Valio's listed substitute first, then the same product on its first possible date", async () => {
    const r = await find({ productId: "463232", amount: 225, unit: "KG" }); // Atria chicken, Terminal
    expect(ids(r)).toEqual(["product:472673", "later_date:463232"]);
    const [substitute, later] = r.options;
    expect(substitute).toMatchObject({ relation: "listed_substitute", decision: "needs_approval", total: 2214.8 });
    expect(substitute.parts[0].quantity).toBe(226); // 2 kg lots
    expect(substitute.findings).toMatchObject([{ rule: "substitution", decision: "needs_approval" }]);
    expect(substitute.reason).toContain("another brand (Kariniemen)");
    expect(later.parts[0].deliveryDate).toBe("2026-11-18");
    expect(later.reason).toBe("The same product on its first possible date, Wed 18 Nov (order by Sat 14 Nov 15:00).");
    expect(later.findings).toMatchObject([{ rule: "delivery_date", decision: "needs_approval" }]);
    expect(fakeValio.count()).toBe(3); // price + availability, and one more availability call for the later date
  });

  it("a closer match with too little stock becomes a split: 198 kg in stock, the rest from the best substitute", async () => {
    const r = await find({ productId: "464786", amount: 225, unit: "KG" }); // Naapurin Maalaiskana, lists 462281
    expect(ids(r)).toEqual(["product:472673", "split:462281+472673", "later_date:464786"]);
    const split = r.options[1];
    expect(split.parts.map((p) => [p.quantity, p.covers])).toEqual([[198, 198], [28, 28]]);
    expect(split.total).toBe(2294);
    expect(split.decision).toBe("needs_approval");
    // 462281 has no allergen data; both products are another brand than the one asked for; and it is a split
    expect(split.findings.map((f) => f.rule)).toEqual(["missing_allergen_data", "substitution", "substitution", "substitution"]);
    expect(split.reason).toContain("198 KG of Kariniemen Chicken breastfillet natural");
  });

  it("too little stock of the asked-for product: same-brand substitute alone, or a split", async () => {
    const r = await find({ productId: "462281", amount: 225, unit: "KG" });
    expect(ids(r)).toEqual(["product:472673", "split:462281+472673"]);
    expect(r.options[0]).toMatchObject({ relation: "same_type_same_brand", decision: "allowed" });
    expect(r.notOffered[0]).toMatchObject({ productId: "462281", reason: "Only 198 KG in stock for Mon 16 Nov, need 228.8" });
  });

  it("the product itself is option 1 when it can simply be ordered", async () => {
    const r = await find({ productId: "465039", amount: 1000, unit: "L" });
    expect(r.options[0]).toMatchObject({ kind: "product", relation: "requested", decision: "allowed", total: 1690 });
  });

  it("salmon: nothing in stock and no substitute, and it says so instead of guessing", async () => {
    const r = await find({ productId: "461814", amount: 40, unit: "KG" });
    expect(r.possible).toBe(false);
    expect(r.options).toEqual([]);
    expect(r.message).toMatch(/^Nothing can be delivered for 40 KG on Mon 16 Nov: \d+ products checked, .*not in stock.*The gateway does not guess a replacement\.$/);
  });

  it("carrot: the substitute is dead too, so the only honest option is a later date", async () => {
    const r = await find({ productId: "474984", amount: 12, unit: "KI" });
    expect(ids(r)).toEqual(["later_date:474984"]);
    expect(r.options[0].decision).toBe("needs_approval");
  });

  it("an unknown product code is not sent to Valio", async () => {
    const r = await find({ productId: "999999", amount: 1, unit: "KG" });
    expect(r.possible).toBe(false);
    expect(fakeValio.count()).toBe(0);
  });

  it("never makes more than the capped number of extra Valio calls", async () => {
    fakeValio.setStock("463232", 10); // past cut-off and never enough in stock: every later date fails
    const r = await find({ productId: "463232", amount: 225, unit: "KG" });
    expect(ids(r)).toEqual(["product:472673"]);
    expect(fakeValio.count()).toBe(2 + MAX_LATER_DATE_CALLS);
    expect(fakeValio.calls.slice(2).map((c) => c.requestedDate)).toEqual(["2026-11-18", "2026-11-19", "2026-11-20"]);
  });

  it("live API: the cut-off does not move with the date, so it asks once, offers no later date and says why", async () => {
    fakeValio.fixSchedule(MONDAY);
    const r = await find({ productId: "463232", amount: 225, unit: "KG" });
    expect(ids(r)).toEqual(["product:472673"]); // the Stock substitute still works
    expect(fakeValio.count()).toBe(3); // price + availability, and one later-date check, not three
    expect(r.message).toBe(
      "1 option for 225 KG on Mon 16 Nov, best first. 107 products checked. " +
        "No later date can be offered for Atria Chicken Fillet Lightly Salted ca3kg/ca150g: Valio's data gives the same order cut-off (Thu 12 Nov 15:00) for Wed 18 Nov too.",
    );
  });

  it("live API: a product with nothing to deliver has no cut-off, so no later date is looked for", async () => {
    fakeValio.setStock("463232", null);
    const r = await find({ productId: "463232", amount: 225, unit: "KG" });
    expect(ids(r)).toEqual(["product:472673"]);
    expect(fakeValio.count()).toBe(2);
  });
});
