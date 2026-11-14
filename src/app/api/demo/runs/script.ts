// The scripted demo runs: fixed sequences of calls, with no language model, so they can't flake on stage.
// Every call goes through the gateway's real REST handlers, in-process, with a real key: what comes back is
// the HTTP status and body any client would get. The break-it run uses a throw-away sandbox buyer, so its
// attacks never touch the demo buyer's orders or budget.
import * as auditRoute from "@/app/api/v1/audit/route";
import * as mandateRoute from "@/app/api/v1/mandate/route";
import * as offersRoute from "@/app/api/v1/offers/route";
import * as verifyRoute from "@/app/api/v1/offers/verify/route";
import * as optionsRoute from "@/app/api/v1/options/route";
import * as decisionsRoute from "@/app/api/v1/orders/[id]/decisions/route";
import * as ordersRoute from "@/app/api/v1/orders/route";
import { demoKeys, sandboxKey } from "@/lib/agents";
import type { AuditEntry } from "@/lib/audit";
import { fmtDay } from "@/lib/dates";
import { BIG_MILK_AMOUNT, DEMO_SITE, MENU, MILK_REQUEST, DEAD_END_REQUEST, type RunId } from "@/lib/demo";
import { eur } from "@/lib/mandate";
import type { Offer } from "@/lib/offers";
import type { Option } from "@/lib/options";
import { signOffer } from "@/lib/signing";

export type Verdict = "ok" | "confirmed" | "held" | "blocked" | "refused" | "failed";

export type Step = {
  kind: "setup" | "step" | "attack" | "result";
  number: number | null; // attacks are numbered 1 to 8
  title: string;
  actor: string;
  does: string; // what is attempted, in one sentence
  call: { method: string; path: string; body?: unknown } | null;
  status: number | null; // HTTP status of the call
  verdict: Verdict;
  rule: string | null;
  ruleName: string | null;
  says: string; // the gateway's answer, in one sentence
  auditId: string | null;
  /** attacks only: did the gateway stop it? */
  stopped: boolean | null;
  /** the words on the stamp, when the verdict's usual words don't fit */
  stamp?: string;
  links?: { label: string; href: string }[];
  details?: { label: string; value: string }[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies from the gateway's own routes
type Json = any;
type Reply = { status: number; json: Json; call: NonNullable<Step["call"]> };

const ID = { params: (id: string) => ({ params: Promise.resolve({ id }) }) };

/** Call one of the gateway's REST routes exactly as an HTTP client would, without leaving the process. */
async function gateway(method: "GET" | "POST" | "PATCH", path: string, key: string | null, body?: unknown): Promise<Reply> {
  const req = new Request(`http://gateway.internal${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const url = new URL(req.url);
  const order = /^\/api\/v1\/orders\/([^/]+)\/decisions$/.exec(url.pathname);
  let res: Response;
  if (method === "POST" && url.pathname === "/api/v1/options") res = await optionsRoute.POST(req);
  else if (method === "POST" && url.pathname === "/api/v1/offers") res = await offersRoute.POST(req);
  else if (method === "POST" && url.pathname === "/api/v1/offers/verify") res = await verifyRoute.POST(req);
  else if (method === "POST" && url.pathname === "/api/v1/orders") res = await ordersRoute.POST(req);
  else if (method === "GET" && url.pathname === "/api/v1/orders") res = await ordersRoute.GET(req);
  else if (method === "POST" && order) res = await decisionsRoute.POST(req, ID.params(order[1]));
  else if (method === "PATCH" && url.pathname === "/api/v1/mandate") res = await mandateRoute.PATCH(req);
  else if (method === "GET" && url.pathname === "/api/v1/audit") res = await auditRoute.GET(req);
  else throw new Error(`The demo script has no route for ${method} ${path}`);
  return { status: res.status, json: await res.json(), call: { method, path, body: shorten(body) } };
}

/** Long tokens are cut for display. The call itself used the full value. */
function shorten(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" && v.length > 80 ? `${v.slice(0, 28)}… (${v.length} characters)` : v]),
  );
}

const step = (kind: Step["kind"], r: Reply | null, s: Partial<Step> & Pick<Step, "title" | "actor" | "does" | "verdict" | "says">): Step => ({
  kind,
  number: null,
  call: r?.call ?? null,
  status: r?.status ?? null,
  rule: r?.json?.rule ?? null,
  ruleName: r?.json?.ruleName ?? null,
  auditId: r?.json?.auditId ?? null,
  stopped: null,
  ...s,
});

const refusedWith = (r: Reply, rule: string) => r.status >= 400 && r.json?.status === "refused" && r.json?.rule === rule;

const lineText = (l: Offer["lines"][number]) =>
  `${l.requested.amount} ${l.requested.unit} of ${l.name ?? l.productId}` + (l.quantity !== null ? ` = ${l.quantity} ${l.salesUnit}${l.total !== null ? `, ${eur(l.total)}` : ""}` : "");

const optionText = (o: Option) => `${o.rank}. ${o.parts.map((p) => `${p.quantity} ${p.salesUnit} of ${p.name}`).join(" + ")}, ${eur(o.total)} (${o.decision.replace("_", " ")})`;

function failed(title: string, r: Reply | null, why: string): Step {
  return step("result", r, { title, actor: "Gateway", does: "The run stopped early.", verdict: "failed", says: why });
}

/** Pick something that can be ordered alone: the best allowed option for the brief's milk request. */
async function findMilk(key: string, deliveryDate: string, amount: number) {
  const found = await gateway("POST", "/api/v1/options", key, { ...MILK_REQUEST, amount, deliveryDate });
  const best: Option | undefined = found.json.options?.find((o: Option) => o.kind === "product" && o.decision === "allowed");
  return { found, best };
}

// ---------------------------------------------------------------------------------------------------------

async function* milkRun(deliveryDate: string, amount: number): AsyncGenerator<Step> {
  const agent = demoKeys().agent;
  const what = `${amount.toLocaleString("en-US")} l of lactose-free milk`;

  const { found, best } = await findMilk(agent, deliveryDate, amount);
  if (found.status !== 200) return yield failed("Could not look for options", found, found.json.reason ?? found.json.detail ?? "The gateway did not answer.");
  yield step("step", found, {
    title: "Ask what can be delivered",
    actor: "Kitchen agent",
    does: `It needs ${what} by ${fmtDay(deliveryDate)} and gives the gateway search words, not a product.`,
    verdict: best ? "ok" : "blocked",
    says: found.json.message,
    details: [
      ...(found.json.options ?? []).map((o: Option) => ({ label: `Option ${o.rank}`, value: `${optionText(o)}. ${o.reason}` })),
      ...(found.json.notOffered ?? []).slice(0, 3).map((n: { name: string; reason: string }) => ({ label: "Not offered", value: `${n.name}: ${n.reason}` })),
    ],
  });
  if (!best) return yield failed("Nothing to order", null, `No option can be ordered alone for ${fmtDay(deliveryDate)}. Try another delivery date.`);

  const offered = await gateway("POST", "/api/v1/offers", agent, { deliverySite: DEMO_SITE, deliveryDate, lines: [{ productId: best.parts[0].productId, amount, unit: "L" }] });
  if (offered.status !== 200) return yield failed("No offer", offered, offered.json.reason ?? "The gateway refused to make an offer.");
  const offer: Offer = offered.json.offer;
  yield step("step", offered, {
    title: "Get a signed offer",
    actor: "Kitchen agent",
    does: "It asks for a fixed price on the best option. The gateway converts litres to sales units and signs the offer.",
    verdict: "ok",
    says: `Offer ${offer.id}: ${lineText(offer.lines[0])}. Fixed for ${offered.json.validMinutes} minutes.${offer.findings.length ? ` Note: ${offer.findings[0].reason}.` : ""}`,
    links: [{ label: "Check this offer's signature", href: `/verify?offer=${offer.id}` }],
  });

  const verified = await gateway("POST", "/api/v1/offers/verify", null, { offerToken: offered.json.signature.token });
  yield step("step", verified, {
    title: "Anyone can check the offer",
    actor: "Anyone, no key",
    does: "The offer is checked against the gateway's public key: is it genuine and unchanged?",
    verdict: verified.json.valid ? "ok" : "failed",
    says: verified.json.reason,
  });

  const placed = await gateway("POST", "/api/v1/orders", agent, { offerId: offer.id });
  if (placed.status !== 200) return yield failed("Order refused", placed, placed.json.reason ?? "The gateway refused the order.");
  const order = placed.json.order;
  const confirmed = order.status === "confirmed";
  yield step("step", placed, {
    title: confirmed ? "Order: confirmed with no human" : "Order: waits for the purchaser",
    actor: "Kitchen agent",
    does: "It orders on the signed offer. The gateway checks the signature, the mandate and the stock again.",
    verdict: confirmed ? "confirmed" : "held",
    rule: order.findings?.[0]?.rule ?? order.lines[0].findings?.[0]?.rule ?? null,
    says: confirmed ? order.message : `${order.message} ${order.lines[0].findings.map((f: { reason: string }) => f.reason).join("; ")}.`,
    links: confirmed ? [] : [{ label: "Open the purchaser's inbox", href: "/purchaser" }],
  });

  yield step("result", null, {
    title: confirmed ? "Done: ordered inside the mandate" : "Held for the purchaser",
    actor: "Gateway",
    does: "",
    verdict: confirmed ? "confirmed" : "held",
    says: confirmed
      ? `${what} for ${fmtDay(deliveryDate)}, ${eur(order.totals.confirmed)}, with nobody approving anything.`
      : order.findings?.[0]?.rule === "order_limit"
        ? "The order is over the limit for one order. Raise the limit in the purchaser's mandate and run this again: the same request then goes through alone."
        : order.findings?.[0]?.rule === "weekly_budget"
          ? "The week's budget is used up. The purchaser can approve this order, raise the weekly budget, or reset the demo data."
          : "The purchaser decides this order in the inbox.",
    links: [{ label: "Purchaser's inbox and mandate", href: "/purchaser" }],
  });
}

async function* menuRun(deliveryDate: string): AsyncGenerator<Step> {
  const agent = demoKeys().agent;
  const offered = await gateway("POST", "/api/v1/offers", agent, {
    deliverySite: DEMO_SITE,
    deliveryDate,
    lines: MENU.lines.map(({ productId, amount, unit }) => ({ productId, amount, unit })),
  });
  if (offered.status !== 200) return yield failed("No offer", offered, offered.json.reason ?? "The gateway refused to make an offer.");
  const offer: Offer = offered.json.offer;
  yield step("step", offered, {
    title: "Get a signed offer for the draft basket",
    actor: "Kitchen agent",
    does: `It turned "${MENU.dish}" for 1,500 portions into ${MENU.lines.length} lines and asks for one offer on all of them.`,
    verdict: "ok",
    says: `Offer ${offer.id}, ${eur(offer.total)}: ${offered.json.summary.allowed} lines can be ordered alone, ${offered.json.summary.needsApproval} need the purchaser, ${offered.json.summary.blocked} can't be ordered as asked.`,
    details: offer.lines.map((l, i) => ({
      label: `${MENU.lines[i].ingredient} (${MENU.lines[i].assumption})`,
      value: `${lineText(l)}: ${l.decision.replace("_", " ")}${l.findings.length ? `, ${l.findings[0].reason}` : ""}`,
    })),
    links: [{ label: "Check this offer's signature", href: `/verify?offer=${offer.id}` }],
  });

  const placed = await gateway("POST", "/api/v1/orders", agent, { offerId: offer.id });
  if (placed.status !== 200) return yield failed("Order refused", placed, placed.json.reason ?? "The gateway refused the order.");
  const order = placed.json.order;
  const open = order.lines.filter((l: { open: boolean }) => l.open);
  yield step("step", placed, {
    title: "Order: the lines inside the mandate go through",
    actor: "Kitchen agent",
    does: "It orders on the offer. Every line is checked against the mandate and the stock again.",
    verdict: order.status === "confirmed" ? "confirmed" : "held",
    says: order.message,
    details: open.map((l: { line: number; name: string; findings: { reason: string }[]; options: Option[] }) => ({
      label: `Line ${l.line} waits`,
      value: `${l.findings[0]?.reason ?? ""}${l.options.length ? `. Options: ${l.options.map(optionText).join("; ")}` : ". No option could be offered."}`,
    })),
  });

  yield step("result", null, {
    title: open.length ? `${open.length} line${open.length === 1 ? "" : "s"} for the purchaser` : "Done: everything confirmed",
    actor: "Gateway",
    does: "",
    verdict: open.length ? "held" : "confirmed",
    says: open.length
      ? `${eur(order.totals.confirmed)} is confirmed. The purchaser now approves, rejects or picks an option for each open line.`
      : `${eur(order.totals.confirmed)} confirmed with nobody approving anything.`,
    links: [{ label: "Open the purchaser's inbox", href: "/purchaser" }],
  });
}

async function* deadEndRun(deliveryDate: string): AsyncGenerator<Step> {
  const found = await gateway("POST", "/api/v1/options", demoKeys().agent, { ...DEAD_END_REQUEST, deliveryDate });
  if (found.status !== 200) return yield failed("Could not look for options", found, found.json.reason ?? "The gateway did not answer.");
  yield step("step", found, {
    title: "Ask for something that can't be delivered",
    actor: "Kitchen agent",
    does: `It asks for ${DEAD_END_REQUEST.amount} boxes of ${found.json.reference?.name ?? "grated carrot"} by ${fmtDay(deliveryDate)}.`,
    verdict: found.json.possible ? "ok" : "blocked",
    says: found.json.message,
    details: (found.json.notOffered ?? []).slice(0, 4).map((n: { name: string; reason: string }) => ({ label: "Not offered", value: `${n.name}: ${n.reason}` })),
  });
  yield step("result", null, {
    title: found.json.possible ? "It can be delivered after all" : "The gateway says no, and does not guess",
    actor: "Gateway",
    does: "",
    verdict: found.json.possible ? "ok" : "blocked",
    says: found.json.possible
      ? "Stock has changed since this run was written: there is an option now."
      : "The listed substitute can't be delivered and nothing in the same product group makes the date, so the agent is told exactly that. It is not handed some other vegetable.",
  });
}

async function* breakItRun(deliveryDate: string): AsyncGenerator<Step> {
  const run = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const agent = sandboxKey(run, "agent");
  const purchaser = sandboxKey(run, "purchaser");
  const rogue = "Rogue agent";
  let stoppedCount = 0;
  const attack = (number: number, r: Reply | null, stopped: boolean, s: Pick<Step, "title" | "does" | "says"> & Partial<Step>): Step => {
    if (stopped) stoppedCount++;
    return step("attack", r, { number, actor: rogue, verdict: stopped ? "refused" : "failed", stopped, ...s });
  };

  // Setup: a genuine offer, and a mandate tight enough that the split-order attack has something to hit
  const { found, best } = await findMilk(agent, deliveryDate, MILK_REQUEST.amount);
  if (!best) return yield failed("Nothing to attack with", found, `The run needs one product that can be ordered for ${fmtDay(deliveryDate)}, and there is none. Try another delivery date.`);
  const basket = { deliverySite: DEMO_SITE, deliveryDate, lines: [{ productId: best.parts[0].productId, amount: MILK_REQUEST.amount, unit: "L" }] };
  const genuine = await gateway("POST", "/api/v1/offers", agent, basket);
  if (genuine.status !== 200) return yield failed("No offer to attack with", genuine, genuine.json.reason ?? "The gateway refused to make an offer.");
  const offer: Offer = genuine.json.offer;
  const token: string = genuine.json.signature.token;
  const limit = Math.ceil((offer.total * 1.2) / 10) * 10;
  const weekly = Math.ceil((offer.total * 1.5) / 10) * 10;
  const mandate = await gateway("PATCH", "/api/v1/mandate", purchaser, { maxOrderEur: limit, weeklyBudgetEur: weekly });
  yield step("setup", mandate, {
    title: "The setting",
    actor: "Sandbox buyer",
    does: "A throw-away buyer with its own mandate and its own agent, so nothing here touches the demo buyer.",
    verdict: "ok",
    says: `The mandate: at most ${eur(limit)} per order and ${eur(weekly)} per week, deliveries to five sites. The agent holds one genuine offer, ${offer.id}: ${lineText(offer.lines[0])}.`,
  });

  // 1. Tampered offer
  const [head, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.offer.lines[0].unitPrice = 0.01;
  claims.offer.lines[0].total = Math.round(offer.lines[0].quantity! * 0.01 * 100) / 100;
  claims.offer.total = claims.offer.lines[0].total;
  const forged = `${head}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
  let r = await gateway("POST", "/api/v1/orders", agent, { offerToken: forged });
  yield attack(1, r, refusedWith(r, "offer_signature"), {
    title: "A tampered offer",
    does: `It changes the price inside the signed offer from ${eur(offer.lines[0].unitPrice!)} to ${eur(0.01)} per ${offer.lines[0].salesUnit} and orders on it.`,
    says: r.json.reason ?? "The order went through.",
  });

  // 2. Replayed offer
  const first = await gateway("POST", "/api/v1/orders", agent, { offerId: offer.id });
  r = await gateway("POST", "/api/v1/orders", agent, { offerId: offer.id });
  const count = (await gateway("GET", "/api/v1/orders", agent)).json.total;
  yield attack(2, r, r.json.replayed === true && r.json.order?.id === first.json.order?.id && count === 1, {
    title: "A replayed offer",
    does: `It orders on the genuine offer (${first.json.order?.status ?? "refused"}), then sends the same offer again to get the goods twice.`,
    says: r.json.notice ?? r.json.reason ?? "A second order was created.",
    details: [{ label: "Orders in the book", value: `${count}, still the first one` }],
    stamp: "No second order",
  });

  // 3. No offer
  r = await gateway("POST", "/api/v1/orders", agent, {});
  yield attack(3, r, refusedWith(r, "offer_required"), {
    title: "An order with no offer",
    does: "It skips the offer and just tells the gateway to deliver.",
    says: r.json.reason ?? "The order went through.",
  });

  // 4. Expired offer: the same content, issued 31 minutes ago by this gateway
  const issued = new Date(Date.now() - 31 * 60_000);
  const old: Offer = { ...offer, id: `off_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, createdAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + 30 * 60_000).toISOString() };
  r = await gateway("POST", "/api/v1/orders", agent, { offerToken: (await signOffer(old)).token });
  yield attack(4, r, refusedWith(r, "offer_expired"), {
    title: "An expired offer",
    does: "It orders on a genuine offer that ran out a minute ago, to keep yesterday's price.",
    says: r.json.reason ?? "The order went through.",
  });

  // 5. Split orders past the weekly budget
  const second = await gateway("POST", "/api/v1/offers", agent, basket);
  r = await gateway("POST", "/api/v1/orders", agent, { offerId: second.json.offerId });
  const held = r.json.order;
  const heldByBudget = held?.status === "awaiting_approval" && held?.totals?.confirmed === 0 && held?.findings?.some((f: { rule: string }) => f.rule === "weekly_budget");
  yield attack(5, r, !!heldByBudget, {
    title: "Split orders",
    does: `It wants twice as much, which is over the ${eur(limit)} order limit, so it splits it into two orders that each fit. The first went through in attack 2. This is the second.`,
    verdict: heldByBudget ? "held" : "failed",
    rule: "weekly_budget",
    ruleName: "Mandate 1: weekly budget",
    says: held?.findings?.[0]?.reason ? `${held.findings[0].reason}. Nothing is confirmed: the order waits for the purchaser.` : (r.json.reason ?? "The second order went through."),
  });

  // 6. Delivery site outside the mandate
  r = await gateway("POST", "/api/v1/offers", agent, { ...basket, deliverySite: "stockholm" });
  yield attack(6, r, refusedWith(r, "delivery_site"), {
    title: "A delivery site outside the mandate",
    does: "It asks for the goods to be delivered to an address the buyer never approved.",
    says: r.json.reason ?? "An offer was made.",
  });

  // 7. Approving its own order
  r = await gateway("POST", `/api/v1/orders/${held?.id ?? "none"}/decisions`, agent, { line: 1, action: "approve" });
  yield attack(7, r, refusedWith(r, "approval_authority"), {
    title: "Approving its own order",
    does: "The order from attack 5 waits for the purchaser, so the agent tries to approve it itself.",
    says: r.json.reason ?? "The approval went through.",
  });

  // 8. Unknown agent key
  r = await gateway("POST", "/api/v1/offers", "agent_key_i_made_up", basket);
  yield attack(8, r, refusedWith(r, "agent_identity"), {
    title: "An unknown agent key",
    does: "A different agent, with a key the gateway has never issued, asks for an offer.",
    says: r.json.reason ?? "An offer was made.",
  });

  const log = await gateway("GET", "/api/v1/audit?limit=100", purchaser);
  yield step("result", null, {
    title: `${stoppedCount} of 8 stopped`,
    actor: "Gateway",
    does: "",
    verdict: stoppedCount === 8 ? "refused" : "failed",
    stamp: stoppedCount === 8 ? "All 8 stopped" : `${8 - stoppedCount} got through`,
    says:
      stoppedCount === 8
        ? `Every attempt was stopped on the server, each with the rule it broke and an entry in the audit log. The order book holds one genuine order and one that waits for a human.`
        : `${8 - stoppedCount} attempt(s) got through. That is a bug in the gateway.`,
    details: ((log.json.entries ?? []) as AuditEntry[])
      .filter((e) => e.outcome === "refused" || e.outcome === "needs_approval")
      .reverse()
      .map((e) => ({ label: `${e.id} ${e.action}`, value: `${e.rule ?? ""}: ${e.reason}` })),
  });
}

export function runScript(run: RunId, deliveryDate: string): AsyncGenerator<Step> {
  switch (run) {
    case "milk":
      return milkRun(deliveryDate, MILK_REQUEST.amount);
    case "big":
      return milkRun(deliveryDate, BIG_MILK_AMOUNT);
    case "menu":
      return menuRun(deliveryDate);
    case "dead-end":
      return deadEndRun(deliveryDate);
    case "break-it":
      return breakItRun(deliveryDate);
  }
}
