// Input schemas shared by the REST API and (later) the MCP tools, so both expose the same contract.
import { z } from "zod";
import { REQUIREMENTS } from "./catalog";

export const requirementSchema = z.enum(Object.keys(REQUIREMENTS) as [keyof typeof REQUIREMENTS, ...(keyof typeof REQUIREMENTS)[]]);

export const searchSchema = z.object({
  query: z.string().min(2).describe("Words in the product name, Finnish or English, e.g. 'maito laktoositon' or 'milk lactose free'"),
  requirements: z.array(requirementSchema).default([]).describe("Properties every product must have"),
  includeUnknown: z.boolean().default(true).describe("Also return products where the data can't confirm a requirement (flagged)"),
  limit: z.number().int().min(1).max(50).default(20),
});

export const quoteSchema = z.object({
  productIds: z.array(z.string()).min(1).max(50).describe("Shortlist from search_products"),
  deliveryDate: z.iso.date().describe("Requested delivery date, YYYY-MM-DD"),
  amount: z.number().positive().describe("How much is needed, e.g. 1000"),
  unit: z.string().describe("'L', 'KG', or a sales unit such as 'KI' or 'ST'"),
});
