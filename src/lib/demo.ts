// What the demo runs ask for. Tune the products here when live data changes; nothing else depends on them.
import type { Requirement } from "./catalog";
import { addDays, helsinkiDate, TZ } from "./dates";

/**
 * The delivery date a demo run asks for when none is given: tomorrow before 15:00 Helsinki time, otherwise
 * the day after, moved past the weekend. On Sat 14 and Sun 15 Nov (before 15:00) that is Mon 16 Nov.
 */
export function defaultDeliveryDate(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now));
  let date = addDays(helsinkiDate(now), hour < 15 ? 1 : 2);
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addDays(date, 1);
  return date;
}

export const DEMO_SITE = "helsinki";

/** The brief's own example: "1,000 l lactose-free milk by Monday". */
export const MILK_REQUEST = { query: "maito laktoositon", amount: 1000, unit: "L", requirements: ["lactose_free"] as Requirement[] };

/** Big enough to cross the seeded 5,000 EUR order limit, for the raise-the-limit moment: about 6,060 EUR at the live 1.01 EUR per litre. */
export const BIG_MILK_AMOUNT = 6000;

/**
 * "Where it breaks": grated carrot in 10 kg boxes. On live data (Sat 14 Nov 2026) it is past its cut-off, its listed
 * substitute is not in stock, and nothing else of its type makes the date. Salmon was the first pick, but other fish is in stock.
 */
export const DEAD_END_REQUEST = { productId: "474984", amount: 12, unit: "KI" };

/**
 * The menu run's draft basket: weekly lunch for 5 hotels, about 1,500 portions.
 * In the real flow the buyer's agent breaks the menu down and the purchaser can edit this draft;
 * the gateway only ever sees the basket. Each line carries the assumption the agent would list.
 * Tuned on live data on Sat 14 Nov 2026 for delivery Mon 16 Nov: five lines pass alone and two stop.
 *   - the chicken (a Terminal product) is past its cut-off, and Valio's listed substitute is another brand;
 *   - the Parmesan has no allergen data, so "lactose-free" can't be confirmed.
 * The other five are Stock products with allergen data and enough stock. Mock stock changes: `/api/demo/check` re-checks this.
 */
export const MENU = {
  title: "Weekly lunch for 5 hotels, about 1,500 portions",
  dish: "Chicken breast with rice, baby carrots, a green salad and Parmesan",
  lines: [
    { ingredient: "Chicken breast fillet", assumption: "150 g per portion", productId: "463232", amount: 225, unit: "KG" },
    { ingredient: "Parmesan", assumption: "about 3 g per portion, 125 g pieces", productId: "463968", amount: 40, unit: "ST" },
    { ingredient: "Basmati rice", assumption: "200 g per portion, 5 kg bags", productId: "472332", amount: 60, unit: "ST" },
    { ingredient: "Baby carrots", assumption: "100 g per portion, frozen, 2.5 kg bags", productId: "475644", amount: 150, unit: "KG" },
    { ingredient: "Salad mix", assumption: "20 g per portion, 300 g bags", productId: "473237", amount: 100, unit: "ST" },
    { ingredient: "Lemon vinaigrette", assumption: "20 ml per portion", productId: "462080", amount: 30, unit: "L" },
    { ingredient: "Lactose-free milk for coffee", assumption: "200 l for the week", productId: "464306", amount: 200, unit: "L" },
  ],
};

export const RUNS = {
  milk: { title: "Milk run", ask: "1,000 l of lactose-free milk by the delivery date", human: false },
  menu: { title: "Menu run", ask: `${MENU.title}: ${MENU.dish[0].toLowerCase()}${MENU.dish.slice(1)}`, human: true },
  big: { title: "Order over the limit", ask: `${BIG_MILK_AMOUNT.toLocaleString("en-US")} l of lactose-free milk, more than one order may cost`, human: true },
  "dead-end": { title: "Where it breaks", ask: "12 boxes of grated carrot, past its cut-off and with no substitute that makes the date", human: false },
  "break-it": { title: "Break-it run", ask: "A rogue agent tries eight ways around the rules", human: false },
} as const;
export type RunId = keyof typeof RUNS;
