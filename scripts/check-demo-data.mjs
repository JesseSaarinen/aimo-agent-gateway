// Demo data check: can the demo runs still work? Mock stock and cut-offs change, so run this before a demo
// (the plan: Sat 17:00 and Sun 08:00). It asks a running gateway, which makes four Valio calls.
//   node scripts/check-demo-data.mjs                                  (local dev server on port 3300)
//   node scripts/check-demo-data.mjs https://aimo-agent-gateway.vercel.app 2026-11-16
const origin = process.argv[2] ?? "http://localhost:3300";
const date = process.argv[3];

const res = await fetch(`${origin}/api/demo/check${date ? `?deliveryDate=${date}` : ""}`);
const body = await res.json();
if (!res.ok) {
  console.error(`Check failed: HTTP ${res.status}`, body.reason ?? body.detail ?? body);
  process.exit(1);
}

console.log(`Delivery ${body.deliveryDate}, checked ${body.checkedAt}`);
console.log(`Data: ${body.source}\n`);
console.table(
  body.menu.map((l) => ({
    ingredient: l.ingredient,
    product: l.productId,
    quantity: l.quantity ?? "?",
    total: l.total ?? "?",
    model: l.logisticModel ?? "?",
    decision: l.decision,
    why: (l.why[0] ?? "").slice(0, 70),
  })),
);
console.log(`Menu: ${body.summary.menu}`);
console.log(`Milk: ${body.summary.milk}`);
console.log(body.summary.ready ? "\nREADY: both runs work for this date." : "\nNOT READY: pick another delivery date or change the basket in src/lib/demo.ts.");
process.exit(body.summary.ready ? 0 : 2);
