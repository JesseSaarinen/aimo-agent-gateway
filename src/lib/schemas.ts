// Input schemas shared by the REST API and the MCP tools, so both expose the same contract.
import { z } from "zod";
import { REQUIREMENTS } from "./catalog";

export const requirementSchema = z.enum(Object.keys(REQUIREMENTS) as [keyof typeof REQUIREMENTS, ...(keyof typeof REQUIREMENTS)[]]);

const requirementsField = z
  .array(requirementSchema)
  .default([])
  .describe(`Properties every product must have, on top of the ones the buyer's mandate already requires. One or more of: ${Object.keys(REQUIREMENTS).join(", ")}`);
const amountField = z.number().positive().describe("How much is needed, as a number in the given unit, e.g. 1000");
const unitField = z
  .string()
  .min(1)
  .max(12)
  .describe("Unit of the amount: 'L' (litres), 'KG', or a sales unit code of the product such as 'ST' (piece), 'KI' (box), 'PAK', 'BAG', 'BOT', 'RAS'. The gateway converts to sales units and rounds up. Everyday words for one item ('bags', 'pieces', 'bottles') are accepted for products sold by the item, not for products sold by the box or by weight.");
const dateField = z.iso.date().describe("Delivery date, YYYY-MM-DD");
const productIdField = z.string().min(1).max(20);

export const searchSchema = z.object({
  query: z.string().min(2).describe("Words in the product name, Finnish or English, e.g. 'maito laktoositon' or 'milk lactose free'. Every word must match."),
  requirements: z.array(requirementSchema).default([]).describe("Properties every product must have"),
  includeUnknown: z.boolean().default(true).describe("Also return products where the data can't confirm a requirement (flagged as unknown)"),
  limit: z.number().int().min(1).max(50).default(20),
});

export const quoteSchema = z.object({
  productIds: z.array(z.string()).min(1).max(50).describe("Shortlist from search_products"),
  deliveryDate: z.iso.date().describe("Requested delivery date, YYYY-MM-DD"),
  amount: z.number().positive().describe("How much is needed, e.g. 1000"),
  unit: z.string().describe("'L', 'KG', or a sales unit such as 'KI' or 'ST'"),
});

export const findOptionsSchema = z.object({
  query: z
    .string()
    .min(2)
    .optional()
    .describe("Search words for what is needed, e.g. 'maito laktoositon' or 'kananpojan rintafilee'. Finnish words match best: product names are Finnish. Every word must be in the product name."),
  productId: productIdField.optional().describe("A product code, to get this product or the closest substitutes for it. Give query or productId (or both)."),
  amount: amountField,
  unit: unitField,
  deliveryDate: dateField,
  requirements: requirementsField,
});

export const requestOfferSchema = z.object({
  deliverySite: z.string().min(1).describe("Id of the delivery site, e.g. 'helsinki'. Must be one of the sites in the buyer's mandate."),
  deliveryDate: dateField,
  lines: z
    .array(
      z.object({
        productId: productIdField.describe("Product code from find_options or search_products"),
        amount: amountField,
        unit: unitField,
        substituteFor: productIdField.optional().describe("If this product replaces another one the buyer asked for, that product's code. The mandate's substitution rule is then applied."),
      }),
    )
    .min(1)
    .max(30)
    .describe("The basket: one line per product"),
  requirements: requirementsField,
  includeToken: z.boolean().optional().describe("Also return the signed offer as a token (a long string). Not needed to order: place_order takes the offerId."),
});

export const verifyOfferSchema = z.object({
  offerId: z.string().optional().describe("Id of an offer that was made for you"),
  offerToken: z.string().optional().describe("The signed offer token. Give this or offerId."),
});

export const placeOrderSchema = z.object({
  offerId: z.string().optional().describe("The offerId from request_offer"),
  offerToken: z.string().optional().describe("The signed offer token, instead of offerId"),
});

export const orderStatusSchema = z.object({
  orderId: z.string().optional().describe("The order id from place_order. Leave it out to list your latest orders."),
});

export const decisionSchema = z.object({
  line: z.number().int().positive(),
  action: z.enum(["approve", "reject", "pick_option"]),
  option: z.number().int().positive().optional().describe("Rank of the option to take, for pick_option"),
  note: z.string().max(500).optional(),
});
export const decisionsSchema = z.union([decisionSchema.transform((d) => [d]), z.object({ decisions: z.array(decisionSchema).min(1).max(30) }).transform((b) => b.decisions)]);

const decision = z.enum(["allowed", "needs_approval", "blocked"]);
export const mandatePatchSchema = z
  .object({
    maxOrderEur: z.number().positive().max(1_000_000),
    weeklyBudgetEur: z.number().positive().max(10_000_000),
    deliverySites: z.array(z.string().min(1)).min(1).max(50),
    latestDeliveryDays: z.number().int().min(1).max(60),
    requiredProperties: z.array(requirementSchema).max(11),
    substitutions: z.object({ sameTypeSameBrand: decision, otherBrand: decision, otherType: decision }),
  })
  .partial()
  .strict();
