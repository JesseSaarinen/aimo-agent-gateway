import { describe, expect, it, vi } from "vitest";
import { quote, quoteBasket, roundUpToLot } from "@/lib/quote";
import { isoTime } from "@/lib/valio";
import * as fake from "@/lib/valio-fake";
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

// What the live API turned out to send on Sat 14 Nov 2026. The fake sends the same shapes.
describe("live API shapes", () => {
  it("times arrive as +0200 and leave as +02:00, which every browser can read", async () => {
    const raw = await fake.getAvailability({ customer: "x", requestedDate: MONDAY, products: ["463038"] });
    expect(raw.timeNow).toBe("2026-11-14T08:00:00+0200");
    expect(raw.products[0].closingTime).toBe("2026-11-12T15:00:00+0200");

    const res = await quoteBasket({ lines: [{ productId: "463038", amount: 1000, unit: "L" }], deliveryDate: MONDAY });
    expect(res.retrievedAt).toBe("2026-11-14T08:00:00+02:00");
    expect(res.lines[0].orderCutoff).toBe("2026-11-12T15:00:00+02:00");
    expect(isoTime("9999-12-31T00:00:00+0200")).toBe("9999-12-31T00:00:00+02:00");
    expect(isoTime("2026-11-14T07:39:43.000Z")).toBe("2026-11-14T07:39:43.000Z");
    expect(isoTime("2026-11-16")).toBe("2026-11-16");
  });

  it("the cut-off is compared as a moment in time, not as text: 16:59 is open, 17:01 is closed", async () => {
    vi.setSystemTime(new Date("2026-11-15T14:59:00Z")); // Sun 15 Nov 16:59 in Helsinki
    expect((await line("472673", 10, "KG")).cutoffPassed).toBe(false);
    vi.setSystemTime(new Date("2026-11-15T15:01:00Z")); // 17:01 in Helsinki
    const late = await line("472673", 10, "KG");
    expect(late.cutoffPassed).toBe(true);
    expect(late.issues[0]).toBe("Order cut-off for Mon 16 Nov passed on Sun 15 Nov 17:00");
  });

  it("a product that can't be delivered comes with no cut-off and no logistic model, and is unavailable, not unknown", async () => {
    const raw = await fake.getAvailability({ customer: "x", requestedDate: MONDAY, products: ["461814"] });
    expect(raw.products[0]).toEqual({ productId: "461814", salesBlock: false, scheduleLines: [] });

    const l = await line("461814", 20, "KG");
    expect(l).toMatchObject({ orderCutoff: null, logisticModel: null, cutoffPassed: false, availableOnDate: 0 });
    expect(l.issues).toEqual(["Not available for delivery on Mon 16 Nov"]);
  });

  it("unlimited also arrives as 9999999999", async () => {
    fakeValio.setStock("472673", 9999999999);
    const l = await line("472673", 225, "KG");
    expect(l.availableOnDate).toBe(999999);
    expect(l.deliverable).toBe(true);
  });

  it("the live schedule is the same whatever date is asked: an earlier date gets nothing, a later one keeps the old cut-off", async () => {
    fakeValio.fixSchedule(MONDAY);
    const early = (await quoteBasket({ lines: [{ productId: "472673", amount: 10, unit: "KG" }], deliveryDate: "2026-11-15" })).lines[0];
    expect(early.issues).toEqual(["Not available for delivery on Sun 15 Nov"]);
    expect(early.nextAvailableDate).toBe(MONDAY);

    const later = (await quoteBasket({ lines: [{ productId: "463232", amount: 10, unit: "KG" }], deliveryDate: "2026-11-18" })).lines[0];
    expect(later.issues).toEqual(["Order cut-off for Wed 18 Nov passed on Thu 12 Nov 15:00"]);
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

  it("an everyday word for one item means the sales unit when the product is sold by the item", async () => {
    // Rice 472332 is sold by the piece (ST), one 5 kg bag each. A real agent asked for "60 bags" and was refused.
    for (const unit of ["bags", "BAG", "pieces", "pcs", "PAK"]) {
      const l = await line("472332", 60, unit);
      expect(l).toMatchObject({ salesUnit: "ST", salesUnitsNeeded: 60, total: 714, deliverable: true });
    }
    expect((await line("462080", 30, "bottles")).salesUnitsNeeded).toBe(30); // vinaigrette, sold by the bottle (BOT)
  });

  it("an everyday word is not guessed for a product sold by the box or by weight", async () => {
    // Eila 1 l is sold by the box of 5 (KI): "100 cartons" could mean 100 boxes or 100 litres, so the gateway asks
    expect((await line("465039", 100, "cartons")).problems.map((p) => p.code)).toEqual(["unit_conversion"]);
    expect((await line("472673", 100, "pieces")).problems.map((p) => p.code)).toEqual(["unit_conversion"]); // chicken, sold by the kg
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
