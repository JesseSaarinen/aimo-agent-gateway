// The REST API as an OpenAPI 3.1 document. It is built from the same zod schemas the routes parse with and the
// same tool texts the MCP server shows, so the three can't drift apart. Served at /api/v1/openapi.json.
// `openapi.test.ts` fails when a route under src/app/api/v1 is missing here.
import { z } from "zod";
import { RULES } from "./rule-names";
import { decisionSchema, findOptionsSchema, mandatePatchSchema, placeOrderSchema, quoteSchema, requestOfferSchema, requirementSchema, verifyOfferSchema } from "./schemas";
import { TOOLS } from "./tools";

type Json = Record<string, unknown>;

/** A zod input schema as JSON Schema (OpenAPI 3.1 uses JSON Schema 2020-12 as it is). */
function jsonSchema(schema: z.ZodType): Json {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Json;
  void $schema;
  return rest;
}

const toolText = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`No tool ${name}`);
  return { summary: t.title, description: `${t.description}\n\nThe same as the MCP tool \`${t.name}\`.` };
};

const AGENT = "An agent key.";
const READERS = "An agent key (sees only its own buyer's data), the purchaser's key or Valio Aimo's read-only key.";
const PURCHASER = "The purchaser's key only. An agent key is refused with rule `approval_authority` or `mandate_authority`.";

const keyed = [{ bearerKey: [] }];
const body = (schema: Json) => ({ required: true, content: { "application/json": { schema } } });
const ok = (description: string) => ({ "200": { description, content: { "application/json": { schema: { type: "object" } } } } });
const refusal = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Refusal" } } } });
const refusals = (...codes: number[]) => {
  const text: Record<number, string> = {
    400: "The input is not well-formed (rule `invalid_request`), or an order was sent with no offer.",
    401: "Unknown or missing key (rule `agent_identity`).",
    403: "The key is known but may not do this, or the request is outside the mandate (for example the delivery site).",
    404: "No such offer or order for this buyer.",
    410: "The offer has expired (rule `offer_expired`).",
    422: "The offer's signature does not match (rule `offer_signature`).",
    502: "Valio Aimo's price or availability API did not answer.",
  };
  return Object.fromEntries(codes.map((c) => [String(c), c === 502 ? { description: text[c] } : refusal(text[c])]));
};
const idParam = (what: string) => ({ name: "id", in: "path", required: true, schema: { type: "string" }, description: `The ${what} id` });

export function openapi(origin: string): Json {
  const decision = jsonSchema(decisionSchema);
  return {
    openapi: "3.1.0",
    info: {
      title: "Aimo Agent Gateway",
      version: "0.1.0",
      summary: "Valio Aimo's ordering interface for buying agents: search, signed fixed-price offers, and orders checked against the buyer's mandate.",
      description: [
        "A Junction 2026 demo on Valio Aimo's mock price and availability data. The buyer, Lumikello Hotels, is made up.",
        "The flow: `find_options` (what can be delivered, for how much) → `request_offer` (a signed offer, prices fixed for 30 minutes) → `place_order`.",
        "Every order is checked on the server against the buyer's mandate. A line inside the mandate is confirmed alone; a line that hits a rule waits for the buyer's purchaser, with up to three ranked options.",
        'A refusal is final and always has the same shape: `status: "refused"`, the rule, a one-line reason and the id of its audit log entry.',
        "The same six tools are also served over MCP at `/api/mcp`. Offers are JWTs signed with Ed25519 (alg EdDSA); the public key is at `/.well-known/jwks.json`.",
      ].join("\n\n"),
    },
    servers: [{ url: origin }],
    tags: [
      { name: "Agent tools", description: "The six tools, the same over REST and MCP." },
      { name: "Purchaser", description: "What only the buyer's purchaser may do." },
      { name: "Reading", description: "Mandate, audit log and keys." },
    ],
    paths: {
      "/api/v1/products/search": {
        get: {
          operationId: "search_products",
          tags: ["Agent tools"],
          ...toolText("search_products"),
          parameters: [
            { name: "query", in: "query", required: true, schema: { type: "string", minLength: 2 }, description: "Words in the product name, Finnish or English. Every word must match." },
            { name: "requirements", in: "query", schema: { type: "string" }, description: `Comma-separated properties every product must have. Any of: ${requirementSchema.options.join(", ")}` },
            { name: "includeUnknown", in: "query", schema: { type: "boolean", default: true }, description: "Also return products where the data can't confirm a requirement (flagged as unknown)" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
          ],
          responses: { ...ok("Matching products. No prices and no stock."), ...refusals(400) },
        },
      },
      "/api/v1/quote": {
        post: {
          operationId: "quote",
          tags: ["Agent tools"],
          summary: "Price and stock for a shortlist of product codes",
          description: `Live price and availability for up to 50 product codes, converted to the asked amount and rounded up to the lot size. Deliverable products first, cheapest first. Prefer \`find_options\`, which also applies the mandate and ranks substitutes.\n\nKey: ${AGENT}`,
          security: keyed,
          requestBody: body(jsonSchema(quoteSchema)),
          responses: { ...ok("One quote line per product."), ...refusals(400, 401, 403, 502) },
        },
      },
      "/api/v1/options": {
        post: {
          operationId: "find_options",
          tags: ["Agent tools"],
          ...toolText("find_options"),
          security: keyed,
          requestBody: body(jsonSchema(findOptionsSchema)),
          responses: { ...ok("Up to three ranked options, or `possible: false` with the reason. The gateway never guesses a replacement."), ...refusals(400, 401, 403, 502) },
        },
      },
      "/api/v1/offers": {
        post: {
          operationId: "request_offer",
          tags: ["Agent tools"],
          ...toolText("request_offer"),
          security: keyed,
          requestBody: body(jsonSchema(requestOfferSchema)),
          responses: { ...ok("The offer: every line with its decision (allowed, needs_approval or blocked), the rule and reason, and options for lines that can't be ordered as asked."), ...refusals(400, 401, 403, 502) },
        },
      },
      "/api/v1/offers/{id}": {
        get: {
          operationId: "get_offer",
          tags: ["Reading"],
          summary: "A stored offer with its signed token",
          description: `Key: ${READERS}`,
          security: keyed,
          parameters: [idParam("offer")],
          responses: { ...ok("The offer and its token."), ...refusals(401, 403, 404) },
        },
      },
      "/api/v1/offers/verify": {
        post: {
          operationId: "verify_offer",
          tags: ["Agent tools"],
          ...toolText("verify_offer"),
          // Over REST this is public and takes the token only; the MCP tool also takes an offerId, because it knows the caller.
          requestBody: body({
            type: "object",
            required: ["offerToken"],
            properties: { offerToken: (jsonSchema(verifyOfferSchema).properties as Json).offerToken },
          }),
          responses: { ...ok("`valid: true` or `false` with the reason. No key is needed: anyone holding the token may check it."), ...refusals(400) },
        },
      },
      "/api/v1/orders": {
        post: {
          operationId: "place_order",
          tags: ["Agent tools"],
          ...toolText("place_order"),
          security: keyed,
          requestBody: body(jsonSchema(placeOrderSchema)),
          responses: {
            ...ok("The order. `status` is confirmed, awaiting_approval or blocked. Sending the same offer again returns the first order with `replayed: true`: one offer, one order."),
            ...refusals(400, 401, 403, 404, 410, 422, 502),
          },
        },
        get: {
          operationId: "list_orders",
          tags: ["Agent tools"],
          summary: "Orders, newest first",
          description: `An agent sees only its own orders. The same as the MCP tool \`get_order_status\` with no order id.\n\nKey: ${READERS}`,
          security: keyed,
          responses: { ...ok("`total`, `awaitingApproval` and the orders."), ...refusals(401) },
        },
      },
      "/api/v1/orders/{id}": {
        get: {
          operationId: "get_order_status",
          tags: ["Agent tools"],
          ...toolText("get_order_status"),
          security: keyed,
          parameters: [idParam("order")],
          responses: { ...ok("One order with every line's status and who decided it."), ...refusals(401, 403, 404) },
        },
      },
      "/api/v1/orders/{id}/decisions": {
        post: {
          operationId: "decide_lines",
          tags: ["Purchaser"],
          summary: "Approve, reject or pick an option for a line",
          description: `A blocked line can't be approved as asked: pick one of its options or reject it. Stock is checked again before anything is confirmed.\n\nKey: ${PURCHASER}`,
          security: keyed,
          parameters: [idParam("order")],
          requestBody: body({
            oneOf: [decision, { type: "object", required: ["decisions"], properties: { decisions: { type: "array", minItems: 1, maxItems: 30, items: decision } } }],
          }),
          responses: { ...ok("The order after the decisions."), ...refusals(400, 401, 403, 404, 502) },
        },
      },
      "/api/v1/mandate": {
        get: {
          operationId: "get_mandate",
          tags: ["Reading"],
          summary: "The mandate as data and as sentences",
          description: `What the agent may order alone, what needs the purchaser and what is never allowed, with this week's spend.\n\nKey: ${READERS}`,
          security: keyed,
          responses: { ...ok("The buyer, the mandate, its rules as sentences and the week's spend."), ...refusals(401) },
        },
        patch: {
          operationId: "update_mandate",
          tags: ["Purchaser"],
          summary: "Change the mandate",
          description: `Any subset of the fields. Every change is a new mandate version in the audit log.\n\nKey: ${PURCHASER}`,
          security: keyed,
          requestBody: body(jsonSchema(mandatePatchSchema)),
          responses: { ...ok("The new mandate."), ...refusals(400, 401, 403) },
        },
      },
      "/api/v1/audit": {
        get: {
          operationId: "list_audit",
          tags: ["Reading"],
          summary: "The log: who, what, which rule, why",
          description: "Every decision and every refusal, newest first. The purchaser sees the buyer's entries; Valio Aimo sees all.\n\nKey: the purchaser's key or Valio Aimo's read-only key.",
          security: keyed,
          parameters: [
            { name: "orderId", in: "query", schema: { type: "string" }, description: "Only entries about this order" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
          ],
          responses: { ...ok("The entries."), ...refusals(401, 403) },
        },
      },
      "/api/v1/openapi.json": {
        get: { operationId: "openapi", tags: ["Reading"], summary: "This document", responses: ok("OpenAPI 3.1") },
      },
      "/.well-known/jwks.json": {
        get: {
          operationId: "jwks",
          tags: ["Reading"],
          summary: "The public key that verifies offers",
          description: "A JWK set with one Ed25519 key. Any JWT library can check an offer token with it (alg EdDSA).",
          responses: ok("JWK set"),
        },
      },
    },
    components: {
      securitySchemes: {
        bearerKey: {
          type: "http",
          scheme: "bearer",
          description: "`Authorization: Bearer <key>`. A key belongs to one agent of one buyer, to the buyer's purchaser, or to Valio Aimo's read-only view. The demo agent's key is shown on /connect. A production gateway would use OAuth 2.1.",
        },
      },
      schemas: {
        Refusal: {
          type: "object",
          description: "A request the gateway refuses outright. Final: asking again with the same input gets the same answer.",
          required: ["status", "rule", "ruleName", "reason", "final", "auditId"],
          properties: {
            status: { const: "refused" },
            rule: { type: "string", enum: Object.keys(RULES) },
            ruleName: { type: "string", enum: Object.values(RULES) },
            reason: { type: "string", description: "One line a person can read" },
            final: { const: true },
            auditId: { type: ["string", "null"], description: "Id of the audit log entry, when the refusal was logged" },
          },
        },
      },
    },
  };
}
