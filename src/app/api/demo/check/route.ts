import { DEMO_MANDATE_ID } from "@/lib/agents";
import { getProduct } from "@/lib/catalog";
import { defaultDeliveryDate, MENU, MILK_REQUEST } from "@/lib/demo";
import { errorResponse } from "@/lib/http";
import { checkProperties, getMandate, supplyFindings } from "@/lib/mandate";
import { findOptions } from "@/lib/options";
import { quoteBasket } from "@/lib/quote";
import { worst } from "@/lib/rules";
import { valioSource } from "@/lib/valio";

// GET /api/demo/check?deliveryDate=YYYY-MM-DD
// The demo data check: can the demo runs still work for this delivery date?
// Quotes the menu basket (one price call, one availability call) and looks for the milk run's product
// (one more of each). Nothing is offered, ordered or logged. Run it before a demo: mock stock and cut-offs change.
export async function GET(req: Request) {
  const asked = new URL(req.url).searchParams.get("deliveryDate");
  try {
    const deliveryDate = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : defaultDeliveryDate();
    const mandate = await getMandate(DEMO_MANDATE_ID);
    const quoted = await quoteBasket({ lines: MENU.lines.map(({ productId, amount, unit }) => ({ productId, amount, unit })), deliveryDate });
    const menu = quoted.lines.map((q, i) => {
      const product = getProduct(q.productId);
      const findings = [...supplyFindings(q.problems), ...(product ? checkProperties(mandate, product).findings : [])];
      return {
        ingredient: MENU.lines[i].ingredient,
        productId: q.productId,
        name: q.name,
        asked: `${q.requested.amount} ${q.requested.unit}`,
        quantity: q.salesUnitsNeeded === null ? null : `${q.salesUnitsNeeded} ${q.salesUnit}`,
        total: q.total,
        logisticModel: q.logisticModel,
        orderCutoff: q.orderCutoff,
        available: q.availableOnDate,
        decision: worst(findings),
        why: findings.map((f) => f.reason),
      };
    });
    const milk = await findOptions(mandate, { ...MILK_REQUEST, deliveryDate });
    const count = (d: string) => menu.filter((l) => l.decision === d).length;
    const milkOk = milk.options.some((o) => o.decision === "allowed");
    return Response.json({
      deliveryDate,
      source: valioSource(),
      checkedAt: quoted.retrievedAt,
      summary: {
        menu: `${count("allowed")} lines pass alone, ${count("needs_approval")} need approval, ${count("blocked")} blocked (the plan wants most to pass and 2 to stop)`,
        milk: milkOk ? `Milk run works: ${milk.options[0].parts[0].name}, ${milk.options[0].total} EUR` : `Milk run has no option that can be ordered alone: ${milk.message}`,
        ready: milkOk && count("allowed") >= 4 && count("needs_approval") + count("blocked") >= 1,
      },
      menu,
      milk: { message: milk.message, options: milk.options.map((o) => ({ rank: o.rank, product: o.parts[0].name, total: o.total, decision: o.decision })), notOffered: milk.notOffered.slice(0, 5) },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
