export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4 py-16">
      <p className="text-sm uppercase tracking-wide text-zinc-500">Junction 2026 · Valio Aimo · Trusted Trade Agents</p>
      <h1 className="text-3xl font-semibold">Aimo Agent Gateway</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        An open interface that lets a buyer&apos;s purchasing agent find products, get prices and availability, and
        place orders within a mandate the buyer sets. Anything outside the mandate goes to a human for approval, and
        every decision is logged.
      </p>
      <p className="text-sm text-zinc-500">
        Status: work in progress. Health check: <a className="underline" href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
