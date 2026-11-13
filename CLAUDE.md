# Aimo Agent Gateway

Junction 2026 entry for Valio Aimo's "Trusted Trade Agents" challenge (13–15 Nov 2026). Solo build.
The plan, judging criteria and API/data findings are in `../valio-aimo.md`. Read it first.

@AGENTS.md

## Where things are

- `src/lib/valio.ts`: client for Valio Aimo's mock price and availability APIs
- `src/lib/catalog.ts`: product search and requirement checks (lactose_free, nut_free …) over the static index. A verdict is yes, no or unknown; unknown means the data can't tell.
- `src/lib/quote.ts`: live price + availability for a shortlist, unit conversion (e.g. 1000 L → 50 KI), cut-off and stock issues
- `src/lib/schemas.ts`: zod input schemas shared by REST and MCP
- `src/app/api/v1/products/search` (GET) and `src/app/api/v1/quote` (POST): the REST API
- `scripts/build-index.mjs`: data/products.json → `src/generated/products-index.json` (11.6 MB, gitignored, runs before every build)
- `src/app/api/health`: checks that the app is up and can reach the Valio API
- `scripts/fetch-data.mjs`: downloads the static challenge files into `data/` (`npm run fetch-data`)
- `data/`: products.json (87 MB), reliability.csv, carbon.csv. Gitignored, so re-download it, don't commit it.

## Run, check, deploy

- Dev: the `aimo-gateway` preview config in `C:\Users\Jesse\Projects\.claude\launch.json`, on port 3300
- Checks: `npm run lint`, `npx tsc --noEmit`, `npm run build`
- Live: https://aimo-agent-gateway.vercel.app (Vercel project `aimo-agent-gateway`). `vercel deploy --prod --yes`.
- Env: `VALIO_API_KEY` and `VALIO_API_BASE` in `.env.local` and on Vercel (production). Template: `.env.example`.

## Rules

- Never commit `.env*` (except `.env.example`) or `data/`.
- Valio's API rule: never poll price or availability for all products. Filter on the static product data first, then query only the shortlist (1–1000 codes per call, rate limited).
- Next.js 16 differs from older versions: check `node_modules/next/dist/docs/` before using an API you're unsure of.
