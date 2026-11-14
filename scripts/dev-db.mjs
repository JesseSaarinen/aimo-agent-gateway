// Starts the dev server on the real Postgres database (namespace "local") and the live Valio API.
// It reads DATABASE_URL from .env.vercel, which `vercel env pull .env.vercel --environment=development` writes.
// Run: npm run dev:db -- -p 3302        (.env.local is still loaded by Next.js for the Valio key and the signing key)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** One variable from .env.vercel, or undefined. Never printed. */
function pulled(name) {
  try {
    const line = readFileSync(".env.vercel", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).replace(/^"|"$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

const url = pulled("DATABASE_URL");
if (!url) {
  console.error("No DATABASE_URL in .env.vercel. Run: vercel env pull .env.vercel --environment=development");
  process.exit(1);
}
// The in-app agent reaches the AI Gateway with this token. The one in .env.vercel is fresher than any in .env.local,
// and it runs out after some hours: pull again when the agent console says it can't sign in.
const oidc = pulled("VERCEL_OIDC_TOKEN");

const args = process.argv.slice(2).filter((a) => /^[\w.:-]+$/.test(a)); // flags and numbers only
const child = spawn(`npx next dev ${args.join(" ")}`, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: url, ...(oidc ? { VERCEL_OIDC_TOKEN: oidc } : {}) },
});
child.on("exit", (code) => process.exit(code ?? 0));
