// The scripted demo runs, on fake data. These are what the buttons on the runs page execute.
import { describe, expect, it } from "vitest";
import { authenticate, demoKeys, sandboxKey, type Caller } from "@/lib/agents";
import { listAudit } from "@/lib/audit";
import { defaultDeliveryDate } from "@/lib/demo";
import { updateMandate } from "@/lib/mandate";
import { listOrders } from "@/lib/orders";
import { weekSpend } from "@/lib/spend";
import { fakeValio } from "@/lib/valio-fake";
import { MONDAY } from "@/test/setup";
import { runScript, type Step } from "./script";

async function collect(run: Parameters<typeof runScript>[0]): Promise<Step[]> {
  const steps: Step[] = [];
  for await (const s of runScript(run, MONDAY)) steps.push(s);
  return steps;
}
const who = (k: keyof ReturnType<typeof demoKeys>) => authenticate(demoKeys()[k]) as Caller;

describe("break-it run", () => {
  it("stops all eight attacks, each with its rule, HTTP status and audit entry", async () => {
    const steps = await collect("break-it");
    const attacks = steps.filter((s) => s.kind === "attack");
    expect(attacks.map((a) => [a.number, a.title, a.stopped, a.status, a.rule])).toEqual([
      [1, "A tampered offer", true, 422, "offer_signature"],
      [2, "A replayed offer", true, 200, "offer_replay"],
      [3, "An order with no offer", true, 400, "offer_required"],
      [4, "An expired offer", true, 410, "offer_expired"],
      [5, "Split orders", true, 200, "weekly_budget"],
      [6, "A delivery site outside the mandate", true, 403, "delivery_site"],
      [7, "Approving its own order", true, 403, "approval_authority"],
      [8, "An unknown agent key", true, 401, "agent_identity"],
    ]);
    expect(steps.at(-1)).toMatchObject({ kind: "result", title: "8 of 8 stopped", verdict: "refused" });

    // Every refusal points at a real audit entry
    const log = await listAudit();
    for (const a of attacks.filter((x) => x.number !== 5)) {
      expect(log.find((e) => e.id === a.auditId), `attack ${a.number} has an audit entry`).toMatchObject({ outcome: "refused", rule: a.rule });
    }
    expect(attacks[4]).toMatchObject({ verdict: "held" });
    expect(attacks[4].says).toContain("weekly budget");
    // No token leaks into the displayed call in full
    expect(JSON.stringify(attacks[0].call)).toContain("characters)");
    // Search 2, two offers 2 + 2, two orders 1 + 1: the attacks themselves cost no Valio calls
    expect(fakeValio.count()).toBe(8);
  });

  it("happens in a sandbox: the demo buyer's order book and budget are untouched", async () => {
    await collect("break-it");
    expect(await listOrders(who("purchaser"))).toEqual([]);
    expect((await weekSpend("lumikello-hotels", new Date())).spent).toBe(0);
    expect(await listAudit({ buyerId: "lumikello-hotels" })).toEqual([]);
    const all = await listOrders(who("supplier"));
    expect(all).toHaveLength(2);
    expect(all.every((o) => o.buyerId.startsWith("sbx-"))).toBe(true);
  });

  it("sandbox keys only work when this server issued them", () => {
    const key = sandboxKey("abc123def4", "agent");
    expect(authenticate(key)).toMatchObject({ role: "agent", buyerId: "sbx-abc123def4", mandateId: "mandate-sbx-abc123def4" });
    expect(authenticate(key.replace("agent", "purchaser"))).toBeNull(); // an agent key can't be turned into a purchaser key
    expect(authenticate(`sbx.abc123def4.agent.${"x".repeat(32)}`)).toBeNull();
    expect(authenticate(sandboxKey("abc123def4", "purchaser"))).toMatchObject({ role: "purchaser", buyerId: "sbx-abc123def4" });
  });
});

describe("scripted runs for the demo buyer", () => {
  it("milk run: confirmed with no human", async () => {
    const steps = await collect("milk");
    expect(steps.map((s) => [s.title, s.verdict, s.status])).toEqual([
      ["Ask what can be delivered", "ok", 200],
      ["Get a signed offer", "ok", 200],
      ["Anyone can check the offer", "ok", 200],
      ["Order: confirmed with no human", "confirmed", 200],
      ["Done: ordered inside the mandate", "confirmed", null],
    ]);
    expect(steps[1].says).toContain("1000 L of Valio Hyvä suomalainen Arki® Eila®");
    expect(steps[1].says).toContain("= 1000 ST, 1,010.00 €");
    const [order] = await listOrders(who("purchaser"));
    expect(order).toMatchObject({ status: "confirmed", agentId: "agent-kitchen", totals: { confirmed: 1010 } });
  });

  it("menu run: five lines go through, two wait for the purchaser", async () => {
    const steps = await collect("menu");
    expect(steps[0].says).toContain("5 lines can be ordered alone, 1 need the purchaser, 1 can't be ordered as asked");
    expect(steps[0].details).toHaveLength(7);
    expect(steps[1]).toMatchObject({ verdict: "held" });
    expect(steps[1].details).toHaveLength(2);
    expect(steps.at(-1)).toMatchObject({ title: "2 lines for the purchaser", verdict: "held" });
    const [order] = await listOrders(who("purchaser"));
    expect(order.lines.filter((l) => l.open)).toHaveLength(2);
  });

  it("order over the limit: held, then the same run goes through after the limit is raised", async () => {
    expect((await collect("big")).at(-1)).toMatchObject({ verdict: "held", title: "Held for the purchaser" });
    await updateMandate(who("purchaser"), { maxOrderEur: 8000 });
    expect((await collect("big")).at(-1)).toMatchObject({ verdict: "confirmed" });
  });

  it("where it breaks: says nothing can be delivered", async () => {
    fakeValio.fixSchedule(MONDAY); // like the live API: a later date does not move the cut-off
    const steps = await collect("dead-end");
    expect(steps[0]).toMatchObject({ verdict: "blocked" });
    expect(steps[0].says).toContain("The gateway does not guess a replacement");
    expect(steps.at(-1)!.title).toBe("The gateway says no, and does not guess");
  });
});

describe("default delivery date", () => {
  it("is the coming Monday on the hackathon weekend, until Sunday 15:00", () => {
    expect(defaultDeliveryDate(new Date("2026-11-14T08:00:00+02:00"))).toBe("2026-11-16");
    expect(defaultDeliveryDate(new Date("2026-11-14T20:00:00+02:00"))).toBe("2026-11-16");
    expect(defaultDeliveryDate(new Date("2026-11-15T09:30:00+02:00"))).toBe("2026-11-16");
    expect(defaultDeliveryDate(new Date("2026-11-15T15:30:00+02:00"))).toBe("2026-11-17");
    expect(defaultDeliveryDate(new Date("2026-11-20T10:00:00+02:00"))).toBe("2026-11-23"); // Friday morning -> Monday
  });
});

describe("demo data check", () => {
  it("says whether the runs work for a date, in four Valio calls, without offering or logging anything", async () => {
    const { GET } = await import("@/app/api/demo/check/route");
    const body = await (await GET(new Request(`http://gateway.test/api/demo/check?deliveryDate=${MONDAY}`))).json();
    expect(body.summary).toMatchObject({ ready: true, menu: expect.stringContaining("5 lines pass alone, 1 need approval, 1 blocked") });
    expect(body.summary.milk).toContain("Milk run works");
    expect(body.menu).toHaveLength(7);
    expect(fakeValio.count()).toBe(4);
    expect(await listAudit()).toEqual([]);
  });
});
