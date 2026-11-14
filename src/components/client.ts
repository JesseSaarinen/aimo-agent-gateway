"use client";
// What the pages share: calling the gateway's own REST API from the browser, polling, and formatting.
import { useCallback, useEffect, useRef, useState } from "react";

export type DemoRole = "purchaser" | "supplier";

// The pages have no key. They sign this browser in once per role (a cookie) and name the role on every call.
const signedIn: Partial<Record<DemoRole, Promise<void>>> = {};
const signIn = (role: DemoRole) =>
  (signedIn[role] ??= fetch("/api/demo/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) }).then(() => undefined));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the gateway; each caller knows its shape
export type Reply<T = any> = { status: number; ok: boolean; json: T };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, opts: { role?: DemoRole; method?: string; body?: unknown } = {}): Promise<Reply<T>> {
  if (opts.role) await signIn(opts.role);
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { ...(opts.role ? { "x-demo-role": opts.role } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401 && opts.role) delete signedIn[opts.role]; // the sign-in ran out: the next call signs in again
  return { status: res.status, ok: res.ok, json: (await res.json().catch(() => ({}))) as T };
}

/** Load something now and then every few seconds while the tab is visible. `refresh()` loads at once. */
export function usePoll<T>(load: () => Promise<T>, everyMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const refresh = useCallback(async () => {
    try {
      setData(await loader.current());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    tick();
    const timer = setInterval(tick, everyMs);
    return () => clearInterval(timer);
  }, [refresh, everyMs]);
  return { data, error, refresh };
}

export const money = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const SALES_UNITS: Record<string, string> = { ST: "pcs", KI: "boxes", KG: "kg", L: "l", PAK: "packs", BAG: "bags", BOT: "bottles", RAS: "trays", PRK: "tubs" };
/** "200 KI" -> "200 boxes (KI)". The code stays visible because it is what the order says. */
export const qty = (n: number, unit: string) => (SALES_UNITS[unit] && !["KG", "L"].includes(unit) ? `${n} ${SALES_UNITS[unit]} (${unit})` : `${n} ${SALES_UNITS[unit] ?? unit}`);

export type Tone = "go" | "wait" | "stop" | "ink";
export const TONE: Record<Tone, string> = {
  go: "border-go text-go bg-go-bg",
  wait: "border-wait text-wait bg-wait-bg",
  stop: "border-stop text-stop bg-stop-bg",
  ink: "border-line text-soft bg-paper",
};
