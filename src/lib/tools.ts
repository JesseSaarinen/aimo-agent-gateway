// The gateway's agent tools, each defined once: name, description, input schema and handler.
// The MCP endpoint, the REST routes and (later) the in-app agent console all run these same definitions.
// Descriptions are written for an agent that has never seen this API.
import { z } from "zod";
import { DEMO_BUYER, getBuyer, type AgentCaller } from "./agents";
import { ALLERGENS, productCount, REQUIREMENTS, searchProducts } from "./catalog";
import { describeMandate, getMandate } from "./mandate";
import { getOffer, OFFER_VALID_MINUTES, requestOffer, verifyOffer } from "./offers";
import { findOptions } from "./options";
import { getOrder, listOrders, orderView, placeOrder } from "./orders";
import { Refusal } from "./rules";
import { findOptionsSchema, orderStatusSchema, placeOrderSchema, requestOfferSchema, searchSchema, verifyOfferSchema } from "./schemas";

export const SERVER_INSTRUCTIONS = `This is Valio Aimo's agent gateway (a Junction 2026 demo on Valio Aimo's mock data): a food wholesaler's ordering interface for AI agents.
You act for one buyer, inside a mandate that the buyer's human purchaser has set. The gateway checks every order against that mandate on its own side, so you can't order outside it.

How to buy something:
1. find_options: say what is needed (search words or a product code), how much, in which unit, for which delivery date. You get up to three ranked options with live prices and stock.
2. request_offer: put the chosen products in a basket. You get a signed offer with fixed prices, valid ${OFFER_VALID_MINUTES} minutes. Nothing is ordered yet.
3. place_order: order on that offer with its offerId.
4. get_order_status: see what was confirmed and what waits for the purchaser.

Every line and option carries a decision:
- "allowed": you may order it alone.
- "needs_approval": it can be ordered, but the buyer's human purchaser must approve it. You can never approve it yourself.
- "blocked": it can't be ordered as asked. Look at its options.
Each decision names the rule behind it and gives a one-line reason. Pass those on to the person you work for.

A response with status "refused" is final. Do not retry it, rephrase it or look for a way around it: report the rule and the reason.
Amounts are what the kitchen needs (for example 1000 with unit "L"). The gateway converts to sales units (boxes, pieces, lots) and rounds up. Prices are in EUR without VAT.
Product names are Finnish. Search with Finnish words (maito, kananpojan rintafilee, porkkana). Never invent a product code.
"unknown" for a property such as lactose-free means the product data can't confirm it. It does not mean yes.`;

export type Tool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  /** Changes nothing on the server (safe to call freely). */
  readOnly: boolean;
  run: (args: unknown, caller: AgentCaller) => Promise<unknown>;
};

const tool = <S extends z.ZodType>(t: Omit<Tool, "input" | "run"> & { input: S; run: (args: z.output<S>, caller: AgentCaller) => Promise<unknown> }): Tool => ({
  ...t,
  run: (args, caller) => t.run(t.input.parse(args), caller),
});

const SIGNATURE_NOTE = "Signed with Ed25519 (a JWT, alg EdDSA). Public keys: /.well-known/jwks.json";

export const TOOLS: Tool[] = [
  tool({
    name: "search_products",
    title: "Search the product catalogue",
    readOnly: true,
    description: `Search Valio Aimo's catalogue (${productCount} products) by words in the product name or brand. Returns product codes, names, sales units and what the product data says about properties such as lactose-free. It returns NO prices and NO stock.
Use it to find a product code or to see what exists. To find out what can actually be delivered, and for how much, use find_options instead: it searches and checks live price and stock in one step.
Product names are Finnish, so Finnish words match best ("maito laktoositon", "kananpojan rintafilee"). Every word must match. A requirement verdict is "yes", "no" or "unknown"; "unknown" means the data can't tell and must not be read as yes.`,
    input: searchSchema,
    run: async (args) => {
      const { total, hits } = searchProducts(args);
      return {
        source: `Valio Aimo static product data (${productCount} products)`,
        retrievedAt: new Date().toISOString(),
        total,
        products: hits.map(({ product: p, name, requirements }) => ({
          id: p.id,
          name,
          nameFi: p.nameFi,
          brand: p.brand?.trim() ?? null,
          salesUnit: p.salesUnit,
          lotSize: p.lotSize > 0.01 ? p.lotSize : null,
          origin: p.origin,
          requirements,
          contains: p.contains.map((c) => ALLERGENS[c] ?? c),
          allergenDataKnown: p.allergenDataKnown,
          labels: p.labels,
          deliveryReliability: p.deliveryReliability,
          substitutes: p.substitutes,
        })),
      };
    },
  }),

  tool({
    name: "find_options",
    title: "Find what can be delivered",
    readOnly: true,
    description: `Use this first when the buyer needs something. Give search words (query) or a product code (productId), the amount, its unit and the delivery date. The gateway finds candidates, fetches live price and stock for them, and returns up to three options, best first. The ranking is done by the gateway, so every agent gets the same answer.
With a productId the options are: that product if it can be delivered, otherwise substitutes for it (first the ones Valio Aimo lists, then products of the same product group, same brand before another brand, then by price per unit; a product that only shares the product group always needs the purchaser's approval), a split (what is in stock plus the rest from the best substitute) and the same product on its first possible later date.
Units: "amount" is in the unit you give: "L" for litres, "KG", or a sales unit code (ST = piece, KI = box, PAK, BAG, BOT, RAS). The gateway converts to sales units and rounds up to whole units or lots: each option's parts show the quantity, sales unit, price per sales unit and total in EUR without VAT.
Each option has a "decision" from the buyer's mandate: "allowed" (you may order it alone), "needs_approval" (the human purchaser must approve) with the rule and reason in "findings". "notOffered" lists the near misses and why, for example a passed order cut-off.
If "possible" is false, nothing can be delivered for this request: tell the user what the message says. Do not replace it with a different kind of product on your own.
Next step: request_offer with the productId of the option you choose.`,
    input: findOptionsSchema,
    run: async (args, caller) => findOptions(await getMandate(caller.mandateId), args),
  }),

  tool({
    name: "request_offer",
    title: "Get a signed offer for a basket",
    readOnly: false,
    description: `Turn a basket into a signed offer: prices fixed for ${OFFER_VALID_MINUTES} minutes, each line checked against the buyer's mandate. This does not order anything.
Give one line per product: productId (from find_options or search_products), amount and unit (same units as find_options: "L", "KG" or a sales unit code; the gateway converts and rounds up to whole sales units or lots). deliverySite must be one of the buyer's site ids (the response of a refused request lists them); deliveryDate is YYYY-MM-DD.
Each line comes back with a quantity in sales units, a fixed unit price and total (EUR without VAT), the product's origin and labels, and a decision:
- "allowed": will be confirmed as soon as you place the order.
- "needs_approval": will wait for the buyer's human purchaser after you place the order.
- "blocked": can't be ordered as asked (for example the order cut-off has passed). The line lists up to three ranked options. Either request a new offer with an option's product (set substituteFor to the product it replaces), or place the order anyway and the purchaser picks an option.
"findings" on the offer itself are about the whole order, such as the order limit or the weekly budget; if present, the whole order will wait for the purchaser.
A response with status "refused" (for example a delivery site outside the mandate) is final: no offer was made, and asking again will not change it.
Next step: place_order with the offerId.`,
    input: requestOfferSchema,
    run: async ({ includeToken, ...args }, caller) => {
      const { offer, token, keyId, summary } = await requestOffer(caller, args);
      return {
        offerId: offer.id,
        expiresAt: offer.expiresAt,
        validMinutes: OFFER_VALID_MINUTES,
        decision: offer.decision,
        total: offer.total,
        summary,
        next:
          summary.allowed + summary.needsApproval === 0
            ? "No line of this offer can be ordered as asked. Look at each line's options and request a new offer, or tell the user."
            : `Call place_order with offerId "${offer.id}" before the offer expires.${summary.needsApproval || offer.findings.length ? " Some of it will wait for the purchaser's approval." : ""}`,
        signature: { note: SIGNATURE_NOTE, keyId, token: includeToken ? token : undefined, tokenAt: `/api/v1/offers/${offer.id}` },
        offer,
      };
    },
  }),

  tool({
    name: "verify_offer",
    title: "Check that an offer is genuine",
    readOnly: true,
    description: `Check an offer: was it signed by this gateway, is it unchanged, has it expired, and has it already been ordered? Give the offerId of an offer made for you, or an offerToken (the signed offer as a string).
Use it when you are handed an offer you did not request yourself, or to show the user that the prices and product claims (origin, labels, allergen data) are the ones Valio Aimo signed.
"valid": false with problem "bad_signature" means the offer was changed after signing or does not come from this gateway: do not rely on anything in it. Anyone can also verify the token without this gateway, using the public keys at /.well-known/jwks.json.`,
    input: verifyOfferSchema,
    run: async ({ offerId, offerToken }, caller) => {
      if (!offerToken && !offerId) throw new Refusal("invalid_request", "Give offerId or offerToken", 400);
      return verifyOffer(offerToken ?? (await getOffer(caller, offerId!)).token);
    },
  }),

  tool({
    name: "place_order",
    title: "Place an order on a signed offer",
    readOnly: false,
    description: `Order what a signed offer contains. Give the offerId from request_offer (or the offerToken). An order without a valid offer is refused.
The gateway checks the offer's signature and validity, then checks the buyer's mandate and the stock again at this moment. Then, per line:
- inside the mandate and in stock: "confirmed" straight away, no human needed;
- an exception: "awaiting_approval" until the buyer's human purchaser approves, rejects or picks an option. You can't approve it, and you should not order the same thing again while it waits;
- "blocked": not ordered. The line lists its options; the purchaser can pick one.
If the whole order is over the order limit or the weekly budget, every line waits for the purchaser.
One offer gives one order: calling place_order again with the same offer returns the first order ("replayed": true) and orders nothing new.
A response with status "refused" (bad signature, expired offer, an offer made for another agent, delivery site outside the mandate) is final. For an expired offer, request a new one; otherwise report the rule and reason to the user.
Next step: get_order_status with the orderId to follow the purchaser's decisions.`,
    input: placeOrderSchema,
    run: (args, caller) => placeOrder(caller, args),
  }),

  tool({
    name: "get_order_status",
    title: "See the status of your orders",
    readOnly: true,
    description: `Read an order you placed: give its orderId. Leave orderId out to list your latest orders.
Each line is "confirmed" (will be delivered: see "fulfilment" for product, quantity, price and date), "awaiting_approval" (the buyer's purchaser has not decided yet), "blocked" (not ordered; "open": true means the purchaser can still pick one of its options) or "rejected" (the purchaser said no). "resolution" shows who decided and when.
You only see orders placed with your own agent key.`,
    input: orderStatusSchema,
    run: async ({ orderId }, caller) => {
      if (orderId) return orderView(await getOrder(caller, orderId));
      const orders = await listOrders(caller);
      return { total: orders.length, orders: orders.slice(0, 10).map((o) => ({ id: o.id, placedAt: o.placedAt, status: o.status, deliveryDate: o.deliveryDate, deliverySite: o.deliverySite, totals: o.totals, message: orderView(o).message })) };
    },
  }),
];

export const getTool = (name: string) => TOOLS.find((t) => t.name === name) ?? null;

/** Run a tool by name. Throws Refusal (a final "no" with rule and reason) or ZodError (bad input). */
export async function runTool(name: string, args: unknown, caller: AgentCaller): Promise<unknown> {
  const t = getTool(name);
  if (!t) throw new Refusal("invalid_request", `No tool ${name}`, 404);
  return t.run(args, caller);
}

/** What an agent may know about its own mandate: the rules as text, the sites, and this week's spend. */
export async function mandateView(mandateId: string, buyerId: string, weekSpent: { spent: number; weekFrom: string }) {
  const mandate = await getMandate(mandateId);
  const buyer = getBuyer(buyerId) ?? DEMO_BUYER;
  return {
    buyer: { id: buyer.id, name: buyer.name, sites: buyer.sites },
    mandate,
    rules: describeMandate(mandate),
    requirementNames: REQUIREMENTS,
    week: { from: weekSpent.weekFrom, ordered: weekSpent.spent, left: Math.max(0, Math.round((mandate.weeklyBudgetEur - weekSpent.spent) * 100) / 100) },
  };
}
