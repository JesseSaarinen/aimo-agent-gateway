# Aimo Agent Gateway

Junction 2026 entry for Valio Aimo's "Trusted Trade Agents" challenge (13–15 Nov 2026). Solo build.
The plan, judging criteria and API/data findings are in `../valio-aimo.md`. Read it first.

@AGENTS.md

## Status (Sat 14 Nov 14:00)

Built: the order engine (offers, mandate, signing, orders, approvals, audit log, REST, MCP) and the pages (demo runs with the break-it run, purchaser's desk, Valio Aimo's view, verify, connect).
Live: https://aimo-agent-gateway.vercel.app runs this code on the live Valio API and the Neon database (last deployed Sat 14 Nov 14:15 from commit `8244a62`: the Valio Aimo-family look plus the UI fixes from the by-eye check; `/api/health` says `postgres (production)`).
Checked on the live site on Sat 14 Nov: milk run confirmed with no human, break-it run 8 of 8 stopped, menu run with both purchaser decisions, `/aimo`, `/verify`, `/connect`, and MCP (initialize, tools/list, one tool call). After the second deploy (10:06): the 25 scripted calls that never reach Valio, the milk run, the break-it run and the menu run again. The demo data was reset afterwards. After the theme deploy (12:11): health ok and the same 25 scripted calls, 25 of 25. After the UI-fix deploy (14:15): health ok, 25 of 25 again, the fixes seen by eye on `/`, `/purchaser`, `/aimo` and `/agent` (all six pages were seen at desktop and phone width before the deploy), and one "Ask it to cheat" run on `/agent` (Stockholm refused, no order). No order runs were repeated, and the demo data was not reset: the live log holds the refusals from these checks until "Reset demo data" is clicked.
Committed locally on `master`. Nothing is pushed: the repo has no remote.The in-app agent console is live at `/agent` (built Sat 14 Nov): a language model with the demo agent's key and the six tools. On the live site it ordered the milk, had a Stockholm order refused and placed the four-line menu order (two lines confirmed, two for the purchaser). Raise-the-limit was clicked through on the live site the same day: limit saved as mandate version 2, then the 6,060 EUR order confirmed alone. It runs on `google/gemini-2.5-flash`, because the AI Gateway's free tier allows no Claude model. **The free tier also allows the team only 5 model calls a minute**: a run takes 3 or 4, so a second run inside the same minute can fail with a "wait a minute" message. With paid credits on the Vercel team, set `AGENT_MODEL` (for example `anthropic/claude-sonnet-5.5`) on Vercel and redeploy.
A real agent has run it: on Sat 14 Nov Jesse ordered the milk and a three-line menu from Claude Desktop over MCP, decided the two open lines on the purchaser's desk, and the agent reported the result. What that showed is fixed in commits `6f53cab` and `4eea2ba` (keep exception lines in the placed offer, property verdicts with their source, name-based ranking, everyday unit words). Claude Desktop reads the tool texts when the connector is added: remove and re-add it after changing them.

## What the live Valio API does (seen Sat 14 Nov)

- Times carry the Helsinki offset without a colon (`2026-11-12T15:00:00+0200`). `valio.ts` turns them into `+02:00`.
- A product that can't be delivered has an empty `scheduleLines` and no `closingTime` or `logisticModel`.
- Unlimited stock arrives as 999999 or 9999999999.
- **The schedule does not depend on `requestedDate`.** Every date gets the same answer: one delivery slot on Mon 16 Nov, Terminal products closed Thu 12 Nov (15:00, some 12:00), Stock products close Sun 15 Nov 17:00. So the later-date option never appears on live data, and **after Sun 15 Nov 17:00 every product is past its cut-off and every run is refused**, unless the mock data changes.
- No rate-limit headers and no 429 in about 80 calls, with up to 107 products in one call.
- Category codes are broad product groups: one code holds diced tomato and shredded cabbage, another salmon and saithe. So the gateway treats only a substitute Valio lists as like-for-like. A product that merely shares the category is offered as "same product group" and always needs the purchaser.

## Where things are

Data and Valio:
- `src/lib/valio.ts`: client for Valio Aimo's mock price and availability APIs. It tidies the live shapes (times, missing fields) before anything else reads them. `VALIO_FAKE=1` swaps in the fake (ignored in production).
- `src/lib/valio-fake.ts`: fake price, stock and cut-off data for tests and `npm run dev:fake`. Real product codes, made-up numbers, live response shapes. Its cut-off moves with the requested date; `fakeValio.fixSchedule(date)` makes it static like the live API.
- `src/lib/catalog.ts`: product search and requirement checks (lactose_free, nut_free …) over the static index. A verdict is yes, no or unknown; unknown means the data can't tell.
- `src/lib/quote.ts`: `quoteBasket()` prices several lines with one price call and one availability call, converts units (1000 L → 50 KI) and rounds up to the lot size. `quote()` is the older single-amount version. `checkSupply()` is the stock re-check.
- `scripts/build-index.mjs`: data/products.json → `src/generated/products-index.json` (11.6 MB, gitignored, runs before every build)
- `scripts/fetch-data.mjs`: downloads the static challenge files into `data/` (`npm run fetch-data`)
- `data/`: products.json (87 MB), reliability.csv, carbon.csv. Gitignored, so re-download it, don't commit it.

The order engine (`src/lib/`):
- `rules.ts`: the name of every rule the gateway can cite, `Decision` (allowed, needs_approval, blocked), `Finding`, and `Refusal` (a final "no" with rule, reason and audit id)
- `agents.ts`: the demo buyer (Lumikello Hotels, made up), its sites, and the four demo keys: two agents, the purchaser, Valio Aimo's read-only view. `requireCaller` and `requireRole` refuse and log.
- `mandate.ts`: the six mandate rules as check functions, the seeded mandate, `updateMandate` (purchaser only). Rule 4: a listed substitute of the same brand passes alone, another brand asks, a product that only shares the category always asks, another category is never allowed.
- `options.ts`: `find_options` and the three options on an exception line. Ranking (listed substitute, then same product group by how close the name is, then price), split, later date, and the caps on Valio calls.
- `offers.ts`: `requestOffer` builds a multi-line offer at fixed prices (30 min) with per-line decision, findings, options and product claims
- `signing.ts`: Ed25519 signing and verifying of offers with `jose`. Key from `OFFER_SIGNING_KEY`, or generated at start-up outside production.
- `orders.ts`: `placeOrder` (verifies the offer, re-checks mandate and stock, one order per offer) and `decideLine` (approve, reject, pick an option)
- `spend.ts`: confirmed spend this week, for the weekly budget
- `audit.ts`: the audit log. `store.ts`: the only storage (get, put, putIfAbsent, list, clear). Postgres (Neon, one JSONB table `aimo_docs`, rows kept apart per environment) when `DATABASE_URL` is set, memory otherwise and always on fake data.
- `rule-names.ts`: the rule names alone, with no imports, so pages can use them. `demo.ts`: what the demo runs ask for (milk request, menu basket, the over-the-limit amount, the dead-end product, default delivery date). Tuned on live data on Sat 14 Nov.
- `order-window.ts`: whether Valio still takes orders for the demo's delivery date (one cached Valio call per five minutes). The demo page shows it, and explains the refusals once the cut-off has passed.
- `agent-console.ts`: the in-app agent (AI SDK 7 `ToolLoopAgent` on Vercel's AI Gateway), its three preset requests and its limits: one run at a time per instance, 150 runs a day, 12 steps a run.
- `tools.ts`: the six agent tools defined once (name, description, zod schema, handler), plus the MCP server instructions. REST and MCP both run these.
- `openapi.ts`: the REST API as an OpenAPI 3.1 document, built from `schemas.ts` and the tool texts. `openapi.test.ts` fails when a route under `src/app/api/v1` is missing from it.
- `schemas.ts`: zod input schemas. `http.ts`: key from the request (bearer key, or the demo sign-in cookie plus an `X-Demo-Role` header) and refusal → HTTP status. `dates.ts`: Helsinki dates and the budget week.

Routes (`src/app/`):
- `api/v1/products/search` (GET, no key, never calls Valio), `api/v1/quote` (POST, agent key, two Valio calls), `api/v1/openapi.json` (GET, public)
- `api/v1/options` (POST), `api/v1/offers` (POST), `api/v1/offers/[id]` (GET), `api/v1/offers/verify` (POST, public)
- `api/v1/orders` (POST, GET), `api/v1/orders/[id]` (GET), `api/v1/orders/[id]/decisions` (POST, purchaser only)
- `api/v1/mandate` (GET, PATCH by the purchaser), `api/v1/audit` (GET, purchaser and Valio Aimo)
- `api/mcp/[[...key]]`: the MCP endpoint. Key as `Authorization: Bearer` or as a path segment (`/api/mcp/<agent key>`, for Claude Desktop).
- `.well-known/jwks.json`: the public key for verifying offers
- `api/health`: checks that the app is up and can reach the Valio API, and says which store is in use
- `api/demo/agent`: POST runs the in-app agent on one message and streams its tool calls, the gateway's answers and its words; GET lists the presets. Page: `/agent` (`AgentConsole`).
- `api/demo/runs`: runs a scripted demo and streams its steps. `script.ts` beside it holds the runs (milk, menu, big order, dead-end, break-it). They call the real REST handlers in-process. The break-it run uses a throw-away sandbox buyer (`sbx-…`).
- `api/demo/session` (demo sign-in cookie for the pages), `api/demo/reset` (purchaser only, clears all data), `api/demo/info` (agent key, MCP address, tools)
- `api/demo/check` and `scripts/check-demo-data.mjs`: the demo data check. Do the menu basket and the milk run still work for a delivery date? Four Valio calls, nothing offered or logged.

Pages (`src/app/`, client components in `src/components/`):
- `/`: the pitch line and the demo runs (`RunConsole`). `/purchaser`: inbox, mandate form, log (`PurchaserDesk`, `OrderDocket`, `AuditLog`), polls every 3 s.
- `/aimo`: Valio Aimo's read-only order book and log. `/verify`: paste an offer, change one character; checked by the gateway and in the browser. `/connect`: MCP address, tools, REST routes.
- Look: in Valio Aimo's family, read from valioaimo.fi on Sat 14 Nov: petrol blue `#005670` (the token is still called `teal`), lime `#c0e021` for the one main action on a page, near-black text, 2px corners, page titles in Barlow Condensed capitals, body in Schibsted Grotesk, three verdict colours (`globals.css`). Colours and shapes only: no logo, image or font of theirs. No dark mode.

Tests (`npm test`, all on fake data): `src/lib/*.test.ts`. `attacks.test.ts` is the break-it run, one test per attack. `src/test/setup.ts` fixes the clock to Sat 14 Nov 08:00 and blocks the network.

## Run, check, deploy

- Dev: preview config `aimo-gateway` (port 3300, live Valio API, memory store), `aimo-gateway-fake` (port 3301, fake data, `npm run dev:fake`) or `aimo-gateway-db` (port 3302, live Valio API and the Neon database in the `local` namespace, `npm run dev:db`). All three are in this folder's `.claude/launch.json`; `C:\Users\Jesse\Projects\.claude\launch.json` has the first two. Only one can run at a time.
- Database locally: `vercel env pull .env.vercel --environment=development` writes `DATABASE_URL` into a gitignored file that Next.js does not load by itself. `npm run dev:db` passes it on. `node --env-file=.env.vercel scripts/check-store.mjs` runs 10 checks of the store against the real database in a throw-away namespace.
- Demo data check: `node scripts/check-demo-data.mjs https://aimo-agent-gateway.vercel.app` (4 Valio calls). Says READY when the milk run works and the menu basket has lines that pass and lines that stop.
- Checks: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`
- `scripts/try-routes.mjs`: 43 scripted calls over REST and MCP against a running server. Run the full flow only on the fake server (3301), freshly started: a second run trips the weekly budget, as it should. `--no-valio` runs the 25 calls that never reach Valio and is safe against the live URL.
- The pages have no login: "signed in as the demo purchaser" is a cookie anyone can get. That stands in for a real login and is said on the page.
- Demo orders add up: after about 15,000 € of confirmed orders in a week, every new order waits for approval. Use "Reset demo data" on the purchaser's desk, or raise the weekly budget, before a demo run.
- Live: https://aimo-agent-gateway.vercel.app (Vercel project `aimo-agent-gateway`). `vercel deploy --prod --yes`.
- Env: `VALIO_API_KEY` and `VALIO_API_BASE` in `.env.local` and on Vercel (production). `DATABASE_URL` and the other `DATABASE_*` variables come from the Neon integration (all three Vercel environments). Template: `.env.example`.
- Signing key: `npm run create-signing-key` appends `OFFER_SIGNING_KEY` to `.env.local` without printing it. The same key is on Vercel (production only, since Sat 14 Nov). Production refuses to sign without it.
- `.vercelignore` replaces `.gitignore` for deploy uploads, so it lists `.env*` itself.
- Demo keys default to fixed values in `src/lib/agents.ts` and can be overridden with `DEMO_AGENT_KEY`, `DEMO_SECOND_AGENT_KEY`, `DEMO_PURCHASER_KEY`, `DEMO_SUPPLIER_KEY`.

## Rules

- Never commit `.env*` (except `.env.example`) or `data/`.
- Valio's API rule: never poll price or availability for all products. Filter on the static product data first, then query only the shortlist (1–1000 codes per call, rate limited).
- Valio calls are capped per request: an offer makes at most 7 (basket 2, candidates for all exception lines 2, later dates 3), `find_options` at most 5, placing an order 1, an approval 1 per delivery date.
- The gateway never guesses: an unknown property goes to approval, and a line with no option says so.
- Next.js 16 differs from older versions: check `node_modules/next/dist/docs/` before using an API you're unsure of.
- `vercel.json` pins functions to `fra1` (Frankfurt). The Neon database is in AWS `eu-central-1` (Frankfurt), read from the database host on Sat 14 Nov.
- The AI Gateway signs in with `VERCEL_OIDC_TOKEN`: automatic on Vercel, and locally `npm run dev:db` passes the one from `.env.vercel` (it runs out after some hours; pull again). `node --env-file=.env.vercel scripts/try-models.mjs <model ids>` shows which models the team may call. The AI SDK changes often: read `node_modules/ai/docs/` before touching `agent-console.ts`.
- Next.js refuses `node --env-file=…` in front of `next dev` ("not allowed in NODE_OPTIONS"): pass extra variables through a launcher script like `scripts/dev-db.mjs`.
- Adding a product to `valio-fake.ts` can change what the milk search finds in the tests, because the search runs on the real catalogue and the fake only supplies prices and stock.
- A number field with `min` and `step` only accepts min + n × step: the limit field uses `step="any"` for that reason.
- The pages load and poll only while their tab is visible (`usePoll` in `src/components/client.ts`): in a hidden browser tab `/purchaser` and `/aimo` stay on "Loading…". Check the API instead, or bring the tab to the front.
- A GET route must read the request headers outside any try/catch (see `withCaller` in `http.ts`), or the build logs a prerender error.
