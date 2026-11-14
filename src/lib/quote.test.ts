import { describe, expect, it } from "vitest";
import { quote, quoteBasket, roundUpToLot } from "@/lib/quote";
import { fakeValio } from "@/lib/valio-fake";
import { MONDAY } from "@/test/setup";

const line = async (productId: string, amount: number, unit: string) =>
  (await quoteBasket({ lines: [{ productId, amount, unit }], deliveryDate: MONDAY })).lines[0];

describe("fake Valio data covers the traps", () => {
  it("a Terminal product is past its cut-off for Monday", async () => {
    const l = await line("463038", 1000, "L");
    expect(l.cutoffPassed).toBe(true);
    expect(l.problems.map((p) => p.code)).toEqual(["cutoff"]);
    expect(l.issues[0]).toBe("Order cut-off for Mon 16 Nov passed on Thu 12 Nov 15:00");
  });

  it("chicken 462281 has 198 kg, too little for 225 kg", async () => {
    const l = await line("462281", 225, "KG");
    expect(l.availableOnDate).toBe(198);
    expect(l.problems.map((p) => p.code)).toEqual(["stock"]);
  });

  it("999999 means unlimited", async () => {
    const l = await line("472673", 225, "KG");
    expect(l.availableOnDate).toBe(999999);
    expect(l.deliverable).toBe(true);
  });

  it("a product with no price is flagged, not priced at zero", async () => {
    const l = await line("464201", 100, "L");
    expect(l.pricePerSalesUnit).toBeNull();
    expect(l.total).toBeNull();
    expect(l.problems.map((p) => p.code)).toContain("price");
  });

  it("an unavailable product has an empty schedule", async () => {
    const l = await line("461814", 20, "KG");
    expect(l.problems.map((p) => p.code)).toEqual(["unavailable"]);
  });
});

describe("unit conversion and lot rounding", () => {
  it("1,000 l of Eila 10 l is 50 boxes of 2 x 10 l", async () => {
    const l = await line("463038", 1000, "L");
    expect(l.salesUnit).toBe("KI");
    expect(l.contentPerSalesUnit).toBe(20);
    expect(l.salesUnitsNeeded).toBe(50);
    expect(l.total).toBe(1565.5);
  });

  it("1,000 l of Eila 1 l (box of 5) is 200 boxes", async () => {
    const l = await line("465039", 1000, "L");
    expect(l.salesUnitsNeeded).toBe(200);
    expect(l.deliveredAmount).toBe(1000);
    expect(l.deliverable).toBe(true);
  });

  it("225 kg of chicken sold in 4.4 kg lots rounds up to 52 lots", async () => {
    const l = await line("462281", 225, "KG");
    expect(l.lotSize).toBe(4.4);
    expect(l.salesUnitsNeeded).toBe(228.8);
  });

  it("an exact multiple of the lot is not rounded up", () => {
    expect(roundUpToLot(198, 4.4)).toBe(198); // 45 lots, despite 198 / 4.4 = 45.00000000000001
    expect(roundUpToLot(225, 2)).toBe(226);
    expect(roundUpToLot(12.2, null)).toBe(13);
  });

  it("a unit the data can't convert is a problem, not a guess", async () => {
    const l = await line("463968", 5, "L");
    expect(l.salesUnitsNeeded).toBeNull();
    expect(l.problems.map((p) => p.code)).toContain("unit_conversion");
  });

  it("an unknown product code never reaches Valio", async () => {
    const l = await line("000000", 1, "KG");
    expect(l.problems.map((p) => p.code)).toEqual(["unknown_product"]);
    expect(fakeValio.count()).toBe(0);
  });
});

describe("basket quoting", () => {
  it("quotes several lines with one price call and one availability call", async () => {
    const res = await quoteBasket({
      deliveryDate: MONDAY,
      lines: [
        { productId: "465039", amount: 1000, unit: "L" },
        { productId: "472673", amount: 225, unit: "KG" },
        { productId: "463968", amount: 40, unit: "ST" },
        { productId: "472673", amount: 10, unit: "KG" },
      ],
    });
    expect(res.lines.map((l) => l.salesUnitsNeeded)).toEqual([200, 226, 40, 10]);
    expect(fakeValio.count("price")).toBe(1);
    expect(fakeValio.count("availability")).toBe(1);
    expect(fakeValio.calls[0].products).toEqual(["465039", "472673", "463968"]);
  });

  it("the original quote() still sorts deliverable products first", async () => {
    const res = await quote({ productIds: ["463038", "465039", "464398"], deliveryDate: MONDAY, amount: 1000, unit: "l" });
    expect(res.requested).toEqual({ amount: 1000, unit: "L" });
    expect(res.lines.map((l) => l.productId)).toEqual(["464398", "465039", "463038"]);
    expect(res.lines[2].deliverable).toBe(false);
  });
});
