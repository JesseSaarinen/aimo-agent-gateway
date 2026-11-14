# Aimo Agent Gateway

**Any agent can ask. Only the mandate can buy.**

Junction 2026, Valio Aimo's challenge "Trusted Trade Agents".
Live demo: https://aimo-agent-gateway.vercel.app

## What it is

An ordering door for AI agents, on the wholesaler's side.

A hotel chain gives its buying agent a mandate: how much it may spend, where it may deliver, what the food must be.
The agent can be any agent. The gateway checks every order against the mandate on Valio Aimo's side, signs every price it promises, and sends the exceptions to a human purchaser.
The rules live on the server, so a prompt can't talk its way around them.

## Try it

| Page | What to do there |
|---|---|
| [`/`](https://aimo-agent-gateway.vercel.app/) | Run the scripted demos: the milk run, the menu run, an order over the limit, a dead end, and the break-it run |
| [`/agent`](https://aimo-agent-gateway.vercel.app/agent) | Let a language model do the buying with the same six tools, and ask it to cheat |
| [`/purchaser`](https://aimo-agent-gateway.vercel.app/purchaser) | Be the purchaser: approve or reject the waiting lines, pick one of three ranked options, raise the order limit, read the log |
| [`/aimo`](https://aimo-agent-gateway.vercel.app/aimo) | Valio Aimo's read-only view of the same orders and the same log |
| [`/verify`](https://aimo-agent-gateway.vercel.app/verify) | Paste a signed offer, change one character, and watch it fail |
| [`/connect`](https://aimo-agent-gateway.vercel.app/connect) | Connect your own agent over MCP or REST |

Orders in the demo add up. After about 15,000 EUR of confirmed orders in a week every new order waits for approval, as the mandate says. "Reset demo data" on the purchaser's desk clears it.

## How an order goes

```
agent                         gateway (Valio Aimo's side)                 purchaser
  | find_options  ----------->  search + live price and stock
  | <-----------  up to 3 ranked options, each with a decision
  | request_offer ----------->  fixed prices for 30 min, checked against the mandate, signed
  | place_order   ----------->  signature, mandate and stock checked again
  | <-----------  lines inside the mandate: confirmed
  |                             exception lines  ------------------------>  approve, reject or pick an option
  | get_order_status -------->  what was confirmed, what waits, who decided
```

Every line gets one of three decisions, with the rule and a one-line reason:

- `allowed`: the agent may order it alone
- `needs_approval`: the purchaser must approve it. An agent key can never approve
- `blocked`: it can't be ordered as asked. The line comes with up to three ranked options

A `refused` response is final and is written to the audit log.

## The six tools

The same six tools are open over MCP and over REST with an OpenAPI document. They are defined once in [`src/lib/tools.ts`](src/lib/tools.ts).

| Tool | What it does |
|---|---|
| `search_products` | Search the catalogue by name or brand. No prices, no stock |
| `find_options` | Search words or a product code, an amount and a date in, up to three ranked options with live price and stock out. The gateway does the ranking, so every agent gets the same answer |
| `request_offer` | Turn a basket into a signed offer with fixed prices, valid 30 minutes. Orders nothing |
| `verify_offer` | Check that an offer is genuine, unchanged, not expired and not already ordered |
| `place_order` | Order what a signed offer contains |
| `get_order_status` | See what was confirmed and what waits for the purchaser |

- MCP: `https://aimo-agent-gateway.vercel.app/api/mcp`, with the agent key as `Authorization: Bearer <key>` or as a path segment (`/api/mcp/<key>`, for Claude Desktop). The demo agent's key is on `/connect`.
- OpenAPI: [`/api/v1/openapi.json`](https://aimo-agent-gateway.vercel.app/api/v1/openapi.json)
- Public key for verifying offers: [`/.well-known/jwks.json`](https://aimo-agent-gateway.vercel.app/.well-known/jwks.json)

## The mandate: six rules, checked on the server

1. A maximum value for one order and a weekly budget. Over either, the purchaser approves. The weekly budget stops an agent from splitting one big order into small ones.
2. Allowed delivery sites and the latest delivery date.
3. Required product properties, for example lactose-free.
4. Substitutions. A substitute Valio Aimo lists, of the same brand, passes alone. Another brand asks. A product that only shares the product group always asks. Another product group is never allowed.
5. Missing allergen data on a product with an allergen requirement always asks. Unknown is never read as yes.
6. Order cut-off passed means no order. The gateway offers what still makes the date.

The demo buyer starts with 5,000 EUR per order, 15,000 EUR per week, five delivery sites and "lactose-free" on every product. The purchaser can change the mandate. An agent can't.

## The trust protocol

- Every offer is signed (JWS, Ed25519). It carries the prices, the quantities, each product's origin and labels, and whether allergen data exists.
- An order must point to a valid, unchanged offer that was issued to the same agent. One offer makes one order.
- Anyone can verify an offer with the public key, without asking the gateway. The verify page does this in the browser.
- Every response names its source and time. Every decision and every refusal goes to an audit log that both the buyer and Valio Aimo can read.

## The break-it run

A rogue agent tries eight things. The gateway refuses each one, with the rule and an audit entry. The run is scripted calls with no language model, and the same eight are tests in [`src/lib/attacks.test.ts`](src/lib/attacks.test.ts).

1. A tampered offer: the price was changed after signing
2. A replayed offer
3. An order with no offer
4. An expired offer
5. Splitting one big order into small ones, which stops at the weekly budget
6. A delivery site outside the mandate
7. Approving its own order
8. An unknown agent key

## What is real and what stands in

Real:

- Prices and stock come from Valio Aimo's mock price and availability API, read for every offer. Stock is checked again when the order is placed.
- The catalogue is the challenge's 17,546 products.
- The mandate checks, the signing, the approvals and the audit log run on the server and are stored in Postgres.

Stand-ins:

- The buyer, "Lumikello Hotels", is made up.
- There is no login. Anyone can be the demo purchaser, and the agents use fixed demo keys.
- Orders stay in the gateway's own order book, because the mock API has no order endpoint.

## Where it breaks

- Only 41% of the products have allergen data. For the rest the gateway can't confirm "lactose-free", so those lines go to the purchaser. That is more manual work than a buyer would want.
- The mock API gives the same delivery schedule for every date. So the "same product on a later date" option exists in the code and in the tests, but never shows up on live data.
- After Sun 15 Nov 2026 17:00 every product in the mock data is past its cut-off for Monday, and every run is refused. The demo page says so when it happens.
- The gateway never breaks a menu into ingredients. The buyer's agent does that, and the amounts in the menu run are assumptions, listed line by line.
- Valio's category codes are broad (one code holds both salmon and saithe), so only a substitute Valio lists counts as like-for-like.
- "Where it breaks" on the demo page is a real dead end: grated carrot past its cut-off with no substitute that makes the date. The gateway says so and offers nothing.
- The in-app agent runs on a free model tier with 5 model calls a minute. A second run inside the same minute can fail with a "wait a minute" message.

## From demo to production

| Part | In this demo | In production |
|---|---|---|
| Agent identity | A fixed demo key per agent, sent as a bearer key or inside the MCP address | OAuth 2.1 as the MCP specification describes: one client per agent, which the buyer can issue and revoke |
| Buyer and purchaser | One made-up hotel chain. No login | Valio Aimo's customers sign in. Each buyer sets its own mandate, and only its purchasers can change it |
| Orders | Kept in the gateway's own order book | A confirmed order is passed on to Valio Aimo's order system. The order book stays as the record of who decided what, and why |
| Prices and stock | Valio Aimo's mock price and availability API | The same two calls against the production API |
| Signing key | One Ed25519 key in an environment variable | A key held in a key management service and rotated. Every offer already names the key that signed it |
| Load | Calls to Valio Aimo are capped per request: an offer makes at most 7, an order 1 | The same caps, plus a rate limit per agent |

## Run it yourself

You need Node 24 and the challenge's API key from the Junction platform. The product data is not in this repo.

```bash
npm install
cp .env.example .env.local    # then put the key in VALIO_API_KEY
npm run fetch-data            # downloads the challenge files into data/
npm run create-signing-key    # adds OFFER_SIGNING_KEY to .env.local
npm run dev
```

`npm run dev:fake` runs on made-up prices and stock instead of the live API. Without `DATABASE_URL` everything is kept in memory.

Checks: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`. The tests run on fake data with the network blocked.

## Built with

Next.js 16, React 19, TypeScript, Tailwind CSS, zod, `jose` for the signatures, the MCP TypeScript SDK with `mcp-handler`, the Vercel AI SDK and AI Gateway for the in-app agent (Gemini 2.5 Flash), Neon Postgres, Vitest, hosted on Vercel in Frankfurt.

## How it was built

I built this alone during the hackathon weekend, with Claude Code writing the code. I chose what to build, directed the work and tested it against the live mock API. [`CLAUDE.md`](CLAUDE.md) is the working notes from that: what was built, what was checked, and what the live API really does.

The look follows Valio Aimo's colours. This is a hackathon demo and is not affiliated with Valio Aimo.

## License

MIT, see [LICENSE](LICENSE).
