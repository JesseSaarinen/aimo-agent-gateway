import { z } from "zod";
import { defaultDeliveryDate, RUNS, type RunId } from "@/lib/demo";
import { errorResponse, readJson } from "@/lib/http";
import { runScript, type Step } from "./script";

const schema = z.object({
  run: z.enum(Object.keys(RUNS) as [RunId, ...RunId[]]),
  deliveryDate: z.iso.date().optional(),
});

// One run at a time per server instance, and a short pause between runs: each run makes a few Valio calls.
const g = globalThis as unknown as { __aimoRunBusy?: boolean; __aimoRunLast?: number };
const PAUSE_MS = 2000;

// POST /api/demo/runs  {run: "milk" | "menu" | "big" | "dead-end" | "break-it", deliveryDate?}
// Runs a scripted demo and streams its steps as they finish, one JSON object per line.
// No language model is involved: the steps are fixed calls to the gateway's own REST API.
export async function POST(req: Request) {
  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await readJson(req));
  } catch (e) {
    return errorResponse(e);
  }
  if (g.__aimoRunBusy || Date.now() - (g.__aimoRunLast ?? 0) < PAUSE_MS) {
    return Response.json({ status: "busy", reason: "Another demo run is in progress. Try again in a few seconds." }, { status: 429 });
  }
  g.__aimoRunBusy = true;
  const deliveryDate = input.deliveryDate ?? defaultDeliveryDate();
  const encoder = new TextEncoder();
  const line = (o: unknown) => encoder.encode(`${JSON.stringify(o)}\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(line({ kind: "start", run: input.run, title: RUNS[input.run].title, ask: RUNS[input.run].ask, deliveryDate }));
      try {
        for await (const step of runScript(input.run, deliveryDate)) controller.enqueue(line(step));
      } catch (e) {
        console.error(e);
        const failed: Step = {
          kind: "result", number: null, title: "The run failed", actor: "Gateway", does: "", call: null, status: null, verdict: "failed",
          rule: null, ruleName: null, says: `Something went wrong outside the gateway's rules: ${String(e)}`, auditId: null, stopped: null,
        };
        controller.enqueue(line(failed));
      } finally {
        g.__aimoRunBusy = false;
        g.__aimoRunLast = Date.now();
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
