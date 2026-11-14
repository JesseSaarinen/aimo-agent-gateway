import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { listAudit } from "@/lib/audit";
import { getOffer, verifyOffer } from "@/lib/offers";
import { jwks } from "@/lib/signing";
import { fakeValio } from "@/lib/valio-fake";
import { agent, expectRefusal, MILK, offerFor, otherAgent, purchaser } from "@/test/helpers";
import { MONDAY } from "@/test/setup";

describe("request_offer", () => {
  it("prices a line at a fixed price for 30 minutes and signs it", async () => {
    const { offer, token, summary } = await offerFor([MILK]);
    expect(offer).toMatchObject({ buyerId: "lumikello-hotels", agentId: "agent-kitchen", deliverySite: "helsinki", deliveryDate: MONDAY, total: 1690, decision: "allowed", currency: "EUR" });
    expect(Date.parse(offer.expiresAt) - Date.parse(offer.createdAt)).toBe(30 * 60_000);
    expect(offer.lines[0]).toMatchObject({ line: 1, quantity: 200, salesUnit: "KI", unitPrice: 8.45, total: 1690, delivers: 1000, decision: "allowed", findings: [], options: [] });
    expect(summary).toEqual({ allowed: 1, needsApproval: 0, blocked: 0 });
    expect(fakeValio.count()).toBe(2);

    expect(await verifyOffer(token)).toMatchObject({ valid: true, alreadyOrdered: null, offer: { id: offer.id } });
    expect((await listAudit())[0]).toMatchObject({ action: "offer_issued", outcome: "allowed", offerId: offer.id, actor: { role: "agent", id: "agent-kitchen" } });
  });

  it("puts origin, labels and whether allergen data exists inside the signed offer", async () => {
    const { offer } = await offerFor([{ productId: "462281", amount: 44, unit: "KG" }]);
    expect(offer.lines[0].claims).toEqual({
      origin: "fi",
      labels: ["FINNISH_HEART_SYMBOL", "GOODS_FROM_FINLAND_BLUE_SWAN"],
      nutritionClaims: ["HIGH_PROTEIN"],
      allergenDataKnown: false,
      requirements: { lactose_free: "unknown" },
      requirementNotes: ["Lactose-free: unknown (the product data can't confirm it; there is no allergen table). Unknown is not yes."],
    });
    expect(offer.lines[0]).toMatchObject({ decision: "needs_approval", findings: [{ rule: "missing_allergen_data" }] });
  });

  it("gives every exception line ranked options, within the cap on Valio calls", async () => {
    const { offer, summary } = await offerFor([
      { productId: "463232", amount: 225, unit: "KG" }, // past cut-off
      { productId: "462281", amount: 100, unit: "KG" }, // no allergen data
      MILK,
    ]);
    expect(summary).toEqual({ allowed: 1, needsApproval: 1, blocked: 1 });
    const [chicken, noData, milk] = offer.lines;
    expect(chicken).toMatchObject({ decision: "blocked", findings: [{ rule: "order_cutoff", reason: "Order cut-off for Mon 16 Nov passed on Thu 12 Nov 15:00" }] });
    expect(chicken.options.map((o) => [o.rank, o.kind, o.parts[0].productId, o.decision])).toEqual([
      [1, "product", "472673", "needs_approval"],
      [2, "later_date", "463232", "needs_approval"],
    ]);
    expect(noData.quantity).toBe(101.2); // 23 lots of 4.4 kg
    // Same brand and product group, but not a pair Valio lists: the purchaser decides
    expect(noData.options[0]).toMatchObject({ kind: "product", relation: "same_group_same_brand", decision: "needs_approval", parts: [{ productId: "472673" }] });
    expect(milk.options).toEqual([]);
    expect(offer.total).toBe(2722.24); // blocked lines are not in the total
    expect(offer.decision).toBe("needs_approval");
    // basket (2) + all candidates of both exception lines (2) + one later-date check (1)
    expect(fakeValio.count()).toBe(5);
  });

  it("a line with no price, an unknown product and a unit it can't convert are blocked, not guessed", async () => {
    const { offer } = await offerFor([
      { productId: "464201", amount: 100, unit: "L" },
      { productId: "000000", amount: 1, unit: "KG" },
      { productId: "463968", amount: 5, unit: "L" },
    ]);
    expect(offer.lines.map((l) => [l.decision, l.findings[0].rule, l.total])).toEqual([
      ["blocked", "price", null],
      ["blocked", "unknown_product", null],
      ["blocked", "unit_conversion", null],
    ]);
    expect(offer).toMatchObject({ total: 0, decision: "blocked" });
  });

  it("says plainly when an exception line has no option", async () => {
    const { offer } = await offerFor([{ productId: "461814", amount: 40, unit: "KG" }]); // salmon
    expect(offer.lines[0].options).toEqual([]);
    expect(offer.lines[0].optionsNote).toContain("The gateway does not guess a replacement");
  });

  it("shows the order limit as a finding on the offer", async () => {
    const { offer } = await offerFor([{ ...MILK, amount: 4000 }]);
    expect(offer.total).toBe(6760);
    expect(offer).toMatchObject({ decision: "needs_approval", findings: [{ rule: "order_limit", reason: "Order total 6,760.00 € is over the 5,000.00 € limit for one order" }] });
    expect(offer.lines[0].decision).toBe("allowed"); // the line itself is fine; it is the order that is too big
  });

  it("refuses a product on two lines", async () => {
    await expect(offerFor([MILK, MILK])).rejects.toMatchObject({ rule: "invalid_request", http: 400 });
  });

  it("is only made for agents", async () => {
    await expectRefusal(offerFor([MILK], {}, purchaser()), "access", 403);
  });
});

describe("signed offers", () => {
  it("serves a public key anyone can verify the offer with", async () => {
    const { token, offer } = await offerFor([MILK]);
    const set = await jwks();
    expect(set.keys).toHaveLength(1);
    expect(set.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(set.keys[0]).not.toHaveProperty("d"); // never the private part
    // An outside party with a standard JWT library and only the public key set:
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet({ keys: set.keys }));
    expect(protectedHeader).toMatchObject({ alg: "EdDSA", kid: set.keys[0].kid });
    expect(payload).toMatchObject({ iss: "aimo-agent-gateway", sub: "agent-kitchen", jti: offer.id });
    expect((payload.offer as typeof offer).lines[0].unitPrice).toBe(8.45);
  });

  it("change one character and it fails", async () => {
    const { token } = await offerFor([MILK]);
    const [h, p, s] = token.split(".");
    const flipped = p.slice(0, 20) + (p[20] === "A" ? "B" : "A") + p.slice(21);
    expect(await verifyOffer(`${h}.${flipped}.${s}`)).toMatchObject({ valid: false, problem: expect.stringMatching(/bad_signature|malformed/), rule: "offer_signature", offer: null });
    expect(await verifyOffer("not a token")).toMatchObject({ valid: false, problem: "malformed" });
    expect(await verifyOffer(token)).toMatchObject({ valid: true });
  });

  it("only the agent it was made for, the purchaser and Valio Aimo can read a stored offer", async () => {
    const { offer } = await offerFor([MILK]);
    expect((await getOffer(agent(), offer.id)).offer.id).toBe(offer.id);
    expect((await getOffer(purchaser(), offer.id)).offer.id).toBe(offer.id);
    await expectRefusal(getOffer(otherAgent(), offer.id), "access", 404);
  });
});
