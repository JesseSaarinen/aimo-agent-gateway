import { describe, expect, it } from "vitest";
import { authenticate, demoKeys, DEMO_MANDATE_ID, requireCaller, type Caller } from "@/lib/agents";
import { listAudit } from "@/lib/audit";
import { getProduct } from "@/lib/catalog";
import { checkDelivery, checkProperties, checkSpend, checkSubstitution, getMandate, updateMandate } from "@/lib/mandate";
import { Refusal } from "@/lib/rules";
import { store } from "@/lib/store";

const who = (k: keyof ReturnType<typeof demoKeys>) => authenticate(demoKeys()[k]) as Caller;
const product = (id: string) => getProduct(id)!;

describe("store", () => {
  it("lists newest first, and putIfAbsent never overwrites", async () => {
    await store.put("t", "a", { n: 1 });
    await store.put("t", "b", { n: 2 });
    expect(await store.putIfAbsent("t", "a", { n: 99 })).toBe(false);
    expect(await store.putIfAbsent("t", "c", { n: 3 })).toBe(true);
    await store.put("t", "a", { n: 4 }); // replacing keeps its place
    expect(await store.list("t")).toEqual([{ n: 3 }, { n: 2 }, { n: 4 }]);
    expect(await store.get("t", "missing")).toBeNull();
  });

  it("hands out copies, so stored data can't be changed by accident", async () => {
    const doc = { tags: ["x"] };
    await store.put("t", "a", doc);
    doc.tags.push("y");
    (await store.get<typeof doc>("t", "a"))!.tags.push("z");
    expect(await store.get("t", "a")).toEqual({ tags: ["x"] });
  });
});

describe("agent keys", () => {
  it("ties each key to one identity", () => {
    expect(who("agent")).toMatchObject({ role: "agent", id: "agent-kitchen", buyerId: "lumikello-hotels", mandateId: DEMO_MANDATE_ID });
    expect(who("purchaser").role).toBe("purchaser");
    expect(who("supplier").role).toBe("supplier");
  });

  it("an unknown key gets nothing, and the attempt is logged without the key", async () => {
    expect(authenticate("agent_lumikello_kitchen_dem0")).toBeNull();
    await expect(requireCaller("not-a-real-key", "search_products")).rejects.toMatchObject({ rule: "agent_identity", http: 401 });
    const [entry] = await listAudit();
    expect(entry).toMatchObject({ action: "search_products", outcome: "refused", rule: "agent_identity", buyerId: null });
    expect(JSON.stringify(entry)).not.toContain("not-a-real-key");
  });
});

describe("mandate rules", () => {
  it("rule 1: over the order limit or the weekly budget needs approval", async () => {
    const m = await getMandate(DEMO_MANDATE_ID);
    expect(checkSpend(m, 4999, 0, "2026-11-09")).toEqual([]);
    expect(checkSpend(m, 5001, 0, "2026-11-09")).toMatchObject([{ rule: "order_limit", decision: "needs_approval" }]);
    const [f] = checkSpend(m, 2000, 14000, "2026-11-09");
    expect(f).toMatchObject({ rule: "weekly_budget", decision: "needs_approval" });
    expect(f.reason).toBe("This order (2,000.00 €) would bring the week to 16,000.00 €, over the 15,000.00 € weekly budget (14,000.00 € already ordered since Mon 9 Nov)");
  });

  it("rule 2: a site outside the mandate or a date too far ahead is blocked", async () => {
    const m = await getMandate(DEMO_MANDATE_ID);
    expect(checkDelivery(m, "helsinki", "2026-11-16", "2026-11-14")).toEqual([]);
    expect(checkDelivery(m, "stockholm", "2026-11-16", "2026-11-14")).toMatchObject([{ rule: "delivery_site", decision: "blocked" }]);
    expect(checkDelivery(m, "helsinki", "2026-12-24", "2026-11-14")).toMatchObject([{ rule: "delivery_date", decision: "blocked" }]);
    expect(checkDelivery(m, "helsinki", "2026-11-13", "2026-11-14")).toMatchObject([{ rule: "delivery_date", decision: "blocked" }]);
  });

  it("rules 3 and 5: a claim is yes, milk is no, and missing data is unknown and goes to approval", async () => {
    const m = await getMandate(DEMO_MANDATE_ID); // requires lactose_free
    expect(checkProperties(m, product("472673"))).toEqual({ requirements: { lactose_free: "yes" }, findings: [] });
    expect(checkProperties(m, product("462281")).findings).toMatchObject([{ rule: "missing_allergen_data", decision: "needs_approval" }]);
    expect(checkProperties(m, product("469648")).findings).toMatchObject([{ rule: "required_properties", decision: "blocked" }]);
    // The agent can ask for more than the mandate does
    expect(checkProperties(m, product("472673"), ["organic"]).findings).toMatchObject([{ rule: "required_properties", decision: "blocked" }]);
  });

  it("rule 4: a listed substitute of the same brand passes alone, another brand asks, another type is never allowed", async () => {
    const m = await getMandate(DEMO_MANDATE_ID);
    expect(checkSubstitution(m, product("467366"), product("474752"))).toEqual([]); // SallaCarte diced tomato 1 kg -> 9 x 1 kg, listed by Valio
    const [brand] = checkSubstitution(m, product("463232"), product("472673")); // Atria -> Kariniemen, Valio's listed substitute
    expect(brand).toMatchObject({ rule: "substitution", decision: "needs_approval" });
    expect(brand.reason).toContain("another brand (Kariniemen)");
    expect(checkSubstitution(m, product("463232"), product("465039"))).toMatchObject([{ rule: "substitution", decision: "blocked" }]); // chicken -> milk
  });

  // Seen on live stock on Sat 14 Nov 2026: one category code holds diced tomato and shredded cabbage.
  it("rule 4: sharing the product group is not enough to pass alone, even for the same brand", async () => {
    const m = await getMandate(DEMO_MANDATE_ID);
    const cabbage = checkSubstitution(m, product("467366"), product("467530")); // SallaCarte diced tomato -> SallaCarte shredded cabbage
    expect(cabbage).toEqual([
      {
        rule: "substitution",
        decision: "needs_approval",
        reason: "SallaCarte Cabbage shredded 1 kg is in the same product group as SallaCarte Tomato diced 1 kg, but Valio Aimo does not list it as a substitute",
      },
    ]);
    const [fillet] = checkSubstitution(m, product("462281"), product("472673")); // two Kariniemen chicken fillets, not a listed pair
    expect(fillet).toMatchObject({ rule: "substitution", decision: "needs_approval" });
    const [thigh] = checkSubstitution(m, product("464786"), product("472673")); // another brand as well
    expect(thigh.reason).toContain("does not list it as a substitute, and it is another brand (Kariniemen)");
    // A mandate can be stricter than "ask", never looser
    const strict = { ...m, substitutions: { ...m.substitutions, sameTypeSameBrand: "blocked" as const } };
    expect(checkSubstitution(strict, product("467366"), product("467530"))).toMatchObject([{ decision: "blocked" }]);
  });
});

describe("changing the mandate", () => {
  it("the purchaser can raise the limit, and the change is logged", async () => {
    const next = await updateMandate(who("purchaser"), { maxOrderEur: 8000 });
    expect(next).toMatchObject({ maxOrderEur: 8000, version: 2, updatedBy: "purchaser-lumikello" });
    expect((await getMandate(DEMO_MANDATE_ID)).maxOrderEur).toBe(8000);
    const [entry] = await listAudit({ buyerId: "lumikello-hotels" });
    expect(entry).toMatchObject({ action: "mandate_updated", actor: { role: "purchaser" } });
    expect(entry.reason).toContain("maxOrderEur 5000 -> 8000");
  });

  it("an agent can't change its own mandate", async () => {
    const attempt = updateMandate(who("agent"), { maxOrderEur: 1_000_000 });
    await expect(attempt).rejects.toBeInstanceOf(Refusal);
    await expect(attempt).rejects.toMatchObject({ rule: "mandate_authority", http: 403 });
    expect((await getMandate(DEMO_MANDATE_ID)).maxOrderEur).toBe(5000);
    expect((await listAudit())[0]).toMatchObject({ action: "mandate_update", outcome: "refused", actor: { role: "agent", id: "agent-kitchen" } });
  });

  it("a delivery site the buyer doesn't have is rejected", async () => {
    await expect(updateMandate(who("purchaser"), { deliverySites: ["helsinki", "stockholm"] })).rejects.toMatchObject({ rule: "invalid_request" });
  });
});
