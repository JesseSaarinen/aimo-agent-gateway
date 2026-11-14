import { beforeEach, describe, expect, it, vi } from "vitest";
import { orderWindow, resetOrderWindow } from "@/lib/order-window";
import { fakeValio } from "@/lib/valio-fake";
import { MONDAY } from "@/test/setup";

beforeEach(() => {
  resetOrderWindow();
  fakeValio.fixSchedule(MONDAY); // like the live API: one delivery slot, whatever date is asked
});

describe("order window for the demo page", () => {
  it("is open on Saturday, and says when it closes", async () => {
    expect(await orderWindow()).toMatchObject({ deliveryDate: MONDAY, open: true, closes: "2026-11-15T17:00:00+02:00" });
  });

  it("asks Valio once and keeps the answer for five minutes", async () => {
    await orderWindow();
    await orderWindow();
    expect(fakeValio.count()).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1000));
    await orderWindow();
    expect(fakeValio.count()).toBe(2);
  });

  it("is closed after Sunday 17:00, even though the page then asks about Tuesday", async () => {
    vi.setSystemTime(new Date("2026-11-15T17:30:00+02:00"));
    expect(await orderWindow()).toMatchObject({ deliveryDate: "2026-11-17", open: false, closes: "2026-11-15T17:00:00+02:00" });
  });
});
