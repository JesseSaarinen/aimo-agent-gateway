// The name of every rule the gateway can cite. No imports, so pages in the browser can use it too.
export const RULES = {
  // The buyer's mandate
  order_limit: "Mandate 1: maximum value of one order",
  weekly_budget: "Mandate 1: weekly budget",
  delivery_site: "Mandate 2: allowed delivery sites",
  delivery_date: "Mandate 2: latest delivery date",
  required_properties: "Mandate 3: required product properties",
  substitution: "Mandate 4: substitutions",
  missing_allergen_data: "Mandate 5: missing allergen data",
  order_cutoff: "Mandate 6: order cut-off",
  // What Valio Aimo can supply
  stock: "Supply: stock on the delivery date",
  price: "Supply: price",
  sales_block: "Supply: sales block",
  unit_conversion: "Supply: unit conversion",
  unknown_product: "Supply: product not in the catalogue",
  // The trust protocol
  agent_identity: "Identity: known agent key",
  approval_authority: "Identity: only the purchaser approves",
  mandate_authority: "Identity: only the purchaser changes the mandate",
  access: "Identity: access to this resource",
  offer_required: "Offer: an order needs an offer",
  offer_signature: "Offer: signature",
  offer_expired: "Offer: validity",
  offer_owner: "Offer: issued to this agent",
  offer_replay: "Offer: one order per offer",
  invalid_request: "Request: well-formed input",
} as const;

export type RuleId = keyof typeof RULES;
