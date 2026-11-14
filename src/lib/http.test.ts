// How a request proves who it is: a key, or (for the app's own pages) the demo sign-in cookie plus a header.
import { describe, expect, it } from "vitest";
import * as resetRoute from "@/app/api/demo/reset/route";
import * as sessionRoute from "@/app/api/demo/session/route";
import * as decisionsRoute from "@/app/api/v1/orders/[id]/decisions/route";
import * as ordersRoute from "@/app/api/v1/orders/route";
import { demoKeys } from "@/lib/agents";
import { listAudit } from "@/lib/audit";
import { keyFrom } from "@/lib/http";
import { placeOrder } from "@/lib/orders";
import { agent, MILK, offerFor } from "@/test/helpers";

const req = (headers: Record<string, string>, init: RequestInit = {}) => new Request("http://gateway.test/api/v1/orders", { ...init, headers });

describe("who is calling", () => {
  it("reads a bearer key or an X-API-Key header", () => {
    expect(keyFrom(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(keyFrom(req({ "x-api-key": "abc" }))).toBe("abc");
    expect(keyFrom(req({}))).toBeNull();
  });

  it("the demo sign-in needs both the cookie and the role header", () => {
    const cookie = "other=1; aimo_demo_purchaser=1";
    expect(keyFrom(req({ cookie, "x-demo-role": "purchaser" }))).toBe(demoKeys().purchaser);
    expect(keyFrom(req({ cookie }))).toBeNull(); // a cross-site request can send the cookie but not the header
    expect(keyFrom(req({ "x-demo-role": "purchaser" }))).toBeNull();
    expect(keyFrom(req({ cookie, "x-demo-role": "supplier" }))).toBeNull(); // signed in as purchaser, not as Valio Aimo
    expect(keyFrom(req({ cookie: "aimo_demo_purchaser=1", "x-demo-role": "agent" }))).toBeNull();
  });

  it("the sign-in route sets an http-only cookie and never returns a key", async () => {
    const res = await sessionRoute.POST(new Request("http://gateway.test/api/demo/session", { method: "POST", body: JSON.stringify({ role: "purchaser" }) }));
    expect(res.headers.get("set-cookie")).toMatch(/^aimo_demo_purchaser=1; Path=\/; HttpOnly; SameSite=Lax/);
    expect(await res.text()).not.toContain(demoKeys().purchaser);
    const bad = await sessionRoute.POST(new Request("http://gateway.test/api/demo/session", { method: "POST", body: JSON.stringify({ role: "agent" }) }));
    expect(bad.status).toBe(400);
  });

  it("an agent key is refused on the decisions route whatever it sends, and the attempt is logged", async () => {
    const res = await decisionsRoute.POST(
      new Request("http://gateway.test/api/v1/orders/ord_x/decisions", { method: "POST", headers: { authorization: `Bearer ${demoKeys().agent}` }, body: "not json" }),
      { params: Promise.resolve({ id: "ord_x" }) },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: "refused", rule: "approval_authority", final: true });
    expect((await listAudit())[0]).toMatchObject({ action: "order_decision", outcome: "refused", orderId: "ord_x" });
  });
});

describe("demo reset", () => {
  it("clears the order book for the purchaser, and only for the purchaser", async () => {
    const { offer } = await offerFor([MILK]);
    await placeOrder(agent(), { offerId: offer.id });
    const post = (key: string) => resetRoute.POST(new Request("http://gateway.test/api/demo/reset", { method: "POST", headers: { authorization: `Bearer ${key}` } }));

    expect((await post(demoKeys().agent)).status).toBe(403);
    const list = async () => (await (await ordersRoute.GET(req({ authorization: `Bearer ${demoKeys().supplier}` }))).json()).total;
    expect(await list()).toBe(1);

    expect((await post(demoKeys().purchaser)).status).toBe(200);
    expect(await list()).toBe(0);
    expect((await listAudit()).map((e) => e.action)).toEqual(["demo_reset"]);
  });
});
