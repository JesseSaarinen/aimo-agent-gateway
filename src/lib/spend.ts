// What a buyer has already ordered this week, for the weekly budget (mandate rule 1).
// Only confirmed lines count: a line waiting for the purchaser is not spent until they approve it.
import { helsinkiDate, weekStart } from "./dates";
import { store } from "./store";

type StoredOrder = { buyerId: string; placedAt: string; lines: { status: string; total: number }[] };

export async function weekSpend(buyerId: string, at: Date): Promise<{ spent: number; weekFrom: string }> {
  const weekFrom = weekStart(helsinkiDate(at));
  const orders = await store.list<StoredOrder>("orders", 5000);
  const cents = orders
    .filter((o) => o.buyerId === buyerId && weekStart(helsinkiDate(new Date(o.placedAt))) === weekFrom)
    .flatMap((o) => o.lines)
    .filter((l) => l.status === "confirmed")
    .reduce((sum, l) => sum + Math.round(l.total * 100), 0);
  return { spent: cents / 100, weekFrom };
}
