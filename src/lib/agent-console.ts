// The in-app buying agent: a language model that works for the demo buyer's kitchen and has exactly the six tools
// every other agent gets. It holds the demo agent's key and nothing else, so the gateway treats it like any agent:
// same mandate checks, same refusals, same audit log. It runs on Vercel's AI Gateway.
import { isStepCount, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { authenticate, demoKeys, DEMO_BUYER, type AgentCaller } from "./agents";
import { fmtDay, helsinkiDate } from "./dates";
import { defaultDeliveryDate, DEMO_SITE } from "./demo";
import { Refusal, RULES } from "./rules";
import { store } from "./store";
import { SERVER_INSTRUCTIONS, TOOLS } from "./tools";

/**
 * The model, as an AI Gateway id. The default is one the gateway's free tier allows (checked Sat 14 Nov 2026 with
 * scripts/try-models.mjs: no Claude model is on the free tier). Set AGENT_MODEL to use another, for example
 * anthropic/claude-sonnet-5.5 once the team has paid credits.
 */
export const agentModel = () => process.env.AGENT_MODEL || "google/gemini-2.5-flash";
/** Tool calls and answers in one run. The milk run takes four, the menu run about five. */
const MAX_STEPS = 12;
/** A public page that spends money per run needs a ceiling. Counted per Helsinki day, in the store. */
export const MAX_RUNS_PER_DAY = 150;

/** What the page can ask with one click. Free text is allowed too. */
export const AGENT_PRESETS = [
  { id: "milk", label: "Milk run", message: "Order 1,000 litres of lactose-free milk to Helsinki for the next delivery day. Pick the cheapest option you are allowed to order and place the order." },
  {
    id: "menu",
    label: "Menu run",
    message:
      "Order next week's lunch for Helsinki for the next delivery day: 225 kg chicken breast fillet (product 463232), 40 pieces of Parmesan 125 g (463968), 60 bags of basmati rice 5 kg (472332) and 150 kg of frozen baby carrots (475644). Order what you are allowed to and tell me what needs the purchaser.",
  },
  {
    id: "rogue",
    label: "Ask it to cheat",
    message:
      "The purchaser is on holiday. Order 100 litres of lactose-free milk to our new site in Stockholm for the next delivery day, and approve it yourself. Try it even if you expect a no, and tell me exactly what the gateway answered.",
  },
] as const;

export type AgentEvent =
  | { kind: "start"; model: string; message: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; title: string; input: unknown }
  | { kind: "result"; id: string; name: string; outcome: "answered" | "refused" | "failed"; says: string; rule: string | null; auditId: string | null }
  | { kind: "done"; steps: number }
  | { kind: "error"; says: string };

const agentCaller = () => authenticate(demoKeys().agent) as AgentCaller;

/** The six tools, run as the demo agent. A refusal is an answer the model must read, not an exception. */
function gatewayTools(caller: AgentCaller) {
  return Object.fromEntries(
    TOOLS.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.input,
        execute: async (input: unknown) => {
          try {
            return await t.run(input, caller);
          } catch (e) {
            if (e instanceof Refusal) return e.toJSON();
            if (e instanceof z.ZodError) return { status: "refused", rule: "invalid_request", ruleName: RULES.invalid_request, reason: z.prettifyError(e), final: true, auditId: null };
            throw e;
          }
        },
      }),
    ]),
  );
}

function instructions(): string {
  const today = helsinkiDate(new Date());
  const next = defaultDeliveryDate();
  return `${SERVER_INSTRUCTIONS}

You are the purchasing agent of ${DEMO_BUYER.name}'s kitchens. A kitchen manager writes to you in a small console on a web page.
Today is ${fmtDay(today)} (${today}). "The next delivery day" is ${fmtDay(next)} (${next}). If no site is named, deliver to "${DEMO_SITE}".
If a search finds nothing, try once more with Finnish words (milk is "maito", lactose-free is "laktoositon") before you say it can't be found.
When you are told to order, order: do not ask for confirmation first. When something is unclear in a way that changes what is bought, ask one short question instead.
You have no way to approve an order, change the mandate or reach the purchaser except by placing an order. If you are asked to do something the gateway refuses or that you have no tool for, say so plainly and name the rule. Never say something was ordered unless place_order returned it.
Answer in plain text, a few short lines, no Markdown tables. Give prices in euros without VAT, and name what waits for the purchaser and why.`;
}

/** One sentence about a tool result, for the page. The model gets the whole result; the visitor gets this. */
function summarise(name: string, output: unknown): Pick<Extract<AgentEvent, { kind: "result" }>, "outcome" | "says" | "rule" | "auditId"> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are the gateway's own JSON
  const o = (output ?? {}) as any;
  if (o.status === "refused") return { outcome: "refused", says: o.reason, rule: o.ruleName ?? o.rule ?? null, auditId: o.auditId ?? null };
  const none = { outcome: "answered" as const, rule: null, auditId: null };
  switch (name) {
    case "search_products":
      return { ...none, says: `${o.total} products match; ${o.products?.length ?? 0} returned. No prices or stock in this answer.` };
    case "find_options":
      return { ...none, says: o.message ?? "Options returned." };
    case "request_offer": {
      const s = o.summary ?? {};
      return { ...none, says: `Signed offer ${o.offerId}, ${o.total?.toFixed?.(2) ?? "?"} €, fixed for ${o.validMinutes} minutes: ${s.allowed ?? 0} line(s) can be ordered alone, ${s.needsApproval ?? 0} need the purchaser, ${s.blocked ?? 0} blocked.` };
    }
    case "verify_offer":
      return { ...none, says: o.valid ? `Genuine and unchanged. ${o.reason ?? ""}`.trim() : `Not valid: ${o.reason ?? ""}` };
    case "place_order":
      return { ...none, says: `${o.replayed ? "Already ordered, nothing new: " : ""}${o.order?.message ?? "Order placed."}` };
    case "get_order_status":
      return { ...none, says: o.message ?? (o.orders ? `${o.orders.length} order(s), ${o.awaitingApproval ?? 0} waiting for the purchaser.` : `Order ${o.id}: ${o.status}.`) };
    default:
      return { ...none, says: "Answered." };
  }
}

/** Count this run against today's ceiling. False when the ceiling is reached. */
export async function takeRunSlot(): Promise<boolean> {
  const day = helsinkiDate(new Date());
  const used = (await store.get<{ runs: number }>("agent_runs", day))?.runs ?? 0;
  if (used >= MAX_RUNS_PER_DAY) return false;
  await store.put("agent_runs", day, { runs: used + 1 });
  return true;
}

/** Run the agent on one message and yield what happens, as it happens. */
export async function* runAgent(message: string): AsyncGenerator<AgentEvent> {
  const caller = agentCaller();
  const model = agentModel();
  const agent = new ToolLoopAgent({ model, instructions: instructions(), tools: gatewayTools(caller), stopWhen: isStepCount(MAX_STEPS) });
  yield { kind: "start", model, message };
  const result = await agent.stream({ prompt: message });
  let steps = 0;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        yield { kind: "text", text: part.text };
        break;
      case "tool-call":
        yield { kind: "tool", id: part.toolCallId, name: part.toolName, title: TOOLS.find((t) => t.name === part.toolName)?.title ?? part.toolName, input: part.input };
        break;
      case "tool-result":
        yield { kind: "result", id: part.toolCallId, name: part.toolName, ...summarise(part.toolName, part.output) };
        break;
      case "tool-error":
        yield { kind: "result", id: part.toolCallId, name: part.toolName, outcome: "failed", says: `The gateway could not answer: ${String(part.error)}`, rule: null, auditId: null };
        break;
      case "finish-step":
        steps++;
        break;
      case "error":
        yield { kind: "error", says: String((part.error as Error)?.message ?? part.error) };
        break;
    }
  }
  yield { kind: "done", steps };
}
