"use client";
// The frame around every page: who you can be in this demo, and a plain warning when the data is fake.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "./client";

const NAV = [
  { href: "/", label: "Demo runs" },
  { href: "/agent", label: "Live agent" },
  { href: "/purchaser", label: "Purchaser" },
  { href: "/aimo", label: "Valio Aimo's view" },
  { href: "/verify", label: "Verify an offer" },
  { href: "/connect", label: "Connect an agent" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [data, setData] = useState<{ fake: boolean; store: string } | null>(null);
  useEffect(() => {
    api("/api/demo/info").then((r) => r.ok && setData(r.json.data));
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-sheet">
        <div className="mx-auto flex max-w-6xl flex-wrap items-baseline gap-x-8 gap-y-2 px-5 py-4">
          <Link href="/" className="text-lg font-extrabold tracking-tight">
            Aimo Agent Gateway
          </Link>
          <nav aria-label="Main" className="flex flex-wrap gap-x-5 gap-y-1 text-[15px]">
            {NAV.map((n) => {
              const here = n.href === "/" ? path === "/" : path.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={here ? "page" : undefined}
                  className={here ? "border-b-2 border-teal pb-0.5 font-semibold text-ink" : "border-b-2 border-transparent pb-0.5 text-soft hover:text-ink"}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
        </div>
        {data?.fake && (
          <p className="border-t border-wait bg-wait-bg px-5 py-1.5 text-center text-sm font-medium text-wait">
            Running on fake Valio data (test fixtures). Prices, stock and cut-offs on this server are made up.
          </p>
        )}
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      <footer className="border-t border-line px-5 py-4 text-sm text-soft">
        <div className="mx-auto max-w-6xl">
          A Junction 2026 entry for Valio Aimo&apos;s Trusted Trade Agents challenge, built on their mock price and stock API. The buyer, Lumikello
          Hotels, is made up. Orders land in this gateway&apos;s own order book{data ? ` (${data.store})` : ""}: the mock API has no order endpoint.
        </div>
      </footer>
    </div>
  );
}
