// Is Valio Aimo still taking orders for the demo's delivery date? The demo page asks, so that a visitor who comes after
// the cut-off sees why every run is refused. Valio's mock API has a single delivery slot with fixed cut-offs
// (seen Sat 14 Nov 2026), so once the Stock products close, nothing can be ordered for any date.
import { defaultDeliveryDate } from "./demo";
import { checkSupply } from "./quote";

export type OrderWindow = { deliveryDate: string; open: boolean; closes: string | null; checkedAt: string };

/** A Stock product the milk run relies on (Arki Eila 1 l): when its cut-off has passed, the Stock products have closed. */
const PROBE = "464306";
const KEEP_MS = 5 * 60_000;

const g = globalThis as unknown as { __aimoOrderWindow?: { at: number; value: OrderWindow } };

/** One Valio availability call at most every five minutes per server instance. null when Valio can't be asked. */
export async function orderWindow(): Promise<OrderWindow | null> {
  const cached = g.__aimoOrderWindow;
  if (cached && Date.now() - cached.at < KEEP_MS) return cached.value;
  try {
    const deliveryDate = defaultDeliveryDate();
    const { supply, checkedAt } = await checkSupply([PROBE], deliveryDate);
    const s = supply(PROBE);
    const value: OrderWindow = { deliveryDate, open: s.known && !s.cutoffPassed && !s.salesBlock && s.available > 0, closes: s.orderCutoff, checkedAt };
    g.__aimoOrderWindow = { at: Date.now(), value };
    return value;
  } catch (e) {
    console.error(e);
    return null;
  }
}

/** Tests only. */
export function resetOrderWindow() {
  g.__aimoOrderWindow = undefined;
}
