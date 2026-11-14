import { z } from "zod";
import { AGENT_PRESETS, MAX_RUNS_PER_DAY, runAgent, takeRunSlot, type AgentEvent } from "@/lib/agent-console";
import { errorResponse, readJson } from "@/lib/http";

const schema = z.object({ message: z.string().trim().min(3).max(600) });

// One run at a time per server instance: each run is a model call plus a few Valio calls.
const g = globalThis as unknown as { __aimoAgentBusy?: boolean };

export const maxDuration = 120;

// POST /api/demo/agent  {message}
// Runs the in-app buying agent on one message and streams what it does, one JSON object per line:
// the tool calls it makes to the gateway, the gateway's answers, and its own words.
// The agent has the demo agent's key and the same six tools as any agent over MCP or REST.
export async function POST(req: Request) {
  let message: string;
  try {
    message = schema.parse(await readJson(req)).message;
  } catch (e) {
    return errorResponse(e);
  }
  if (g.__aimoAgentBusy) return Response.json({ status: "busy", reason: "The agent is busy with another request. Try again in a moment." }, { status: 429 });
  if (!(await takeRunSlot())) {
    return Response.json({ status: "busy", reason: `The agent has done its ${MAX_RUNS_PER_DAY} runs for today. The scripted runs and your own agent over MCP still work.` }, { status: 429 });
  }
  g.__aimoAgentBusy = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgentEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        for await (const event of runAgent(message)) send(event);
      } catch (e) {
        console.error(e);
        send({ kind: "error", says: `The agent stopped: ${String((e as Error)?.message ?? e)}` });
      } finally {
        g.__aimoAgentBusy = false;
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

// GET /api/demo/agent: the presets the page offers
export async function GET() {
  return Response.json({ presets: AGENT_PRESETS });
}
