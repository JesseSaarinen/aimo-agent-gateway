// Starts the dev server on FAKE Valio data (src/lib/valio-fake.ts), so the whole flow can be tried
// without calling the Valio API. Run: npm run dev:fake -- -p 3301
// Every response then says its source is fake data. The switch is ignored in production builds.
import { spawn } from "node:child_process";

const args = process.argv.slice(2).filter((a) => /^[\w.:-]+$/.test(a)); // flags and numbers only
const child = spawn(`npx next dev ${args.join(" ")}`, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VALIO_FAKE: "1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
