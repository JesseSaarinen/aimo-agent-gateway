// Runs before every test file. Tests use fake Valio data, a fixed clock and no network.
import { beforeEach, vi } from "vitest";
import { resetStore } from "@/lib/store";
import { fakeValio } from "@/lib/valio-fake";

/** "Now" in every test: Saturday 14 Nov 2026, 08:00 in Helsinki. Monday 16 Nov is the delivery date. */
export const NOW = "2026-11-14T08:00:00+02:00";
export const MONDAY = "2026-11-16";

vi.stubGlobal("fetch", () => {
  throw new Error("Network is disabled in tests: use the fake in src/lib/valio-fake.ts");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  fakeValio.reset();
  resetStore();
});
