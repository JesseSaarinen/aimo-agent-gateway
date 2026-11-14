// Starts the dev server on the real Postgres database (namespace "local") and the live Valio API.
// It reads DATABASE_URL from .env.vercel, which `vercel env pull .env.vercel --environment=development` writes.
// Run: npm run dev:db -- -p 3302        (.env.local is still loaded by Next.js for the Valio key and the signing key)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

let url;
try {
  const line = readFileSync(".env.vercel", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  url = line?.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
} catch {
  // handled below
}
if (!url) {
  console.error("No DATABASE_URL in .env.vercel. Run: vercel env pull .env.vercel --environment=development");
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => /^[\w.:-]+$/.test(a)); // flags and numbers only
const child = spawn(`npx next dev ${args.join(" ")}`, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
child.on("exit", (code) => process.exit(code ?? 0));
