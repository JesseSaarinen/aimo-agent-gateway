"use client";
// The demo runs: pick a run, watch each scripted call to the gateway and its answer arrive.
// The break-it run fills a row of eight boxes, one stamp per stopped attack.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Step } from "@/app/api/demo/runs/script";
import { fmtDay } from "@/lib/dates";
import type { RunId } from "@/lib/demo";
import { api, TONE, type Tone } from "./client";

type Start = { kind: "start"; run: RunId; title: string; ask: string; deliveryDate: string };
type Info = { runs: Record<RunId, { title: string; ask: string; human: boolean }>; defaultDeliveryDate: string };

const ORDER: RunId[] = ["milk", "menu", "big", "dead-end", "break-it"];

const VERDICT: Record<Step["verdict"], { label: string; tone: Tone }> = {
  ok: { label: "Answered", tone: "ink" },
  confirmed: { label: "Confirmed", tone: "go" },
  held: { label: "Held for a human", tone: "wait" },
  blocked: { label: "Not possible", tone: "stop" },
  refused: { label: "Refused", tone: "stop" },
  failed: { label: "Got through", tone: "stop" },
};

function StepRow({ step }: { step: Step }) {
  const v = VERDICT[step.verdict];
  const attack = step.kind === "attack";
  const label = step.stamp ?? (attack && step.stopped ? (step.verdict === "held" ? "Held for a human" : "Refused") : step.kind === "result" && step.verdict === "failed" ? "Failed" : v.label);
  return (
    <li className={`grid gap-x-5 gap-y-2 border-b border-line px-4 py-4 last:border-0 sm:grid-cols-[1fr_auto] ${step.kind === "result" ? "bg-paper" : ""}`}>
      <div className="min-w-0">
        <h3 className="font-bold">
          {step.number ? `${step.number}. ` : ""}
          {step.title}
        </h3>
        {step.does && (
          <p className="mt-0.5 text-[15px]">
            <span className="text-soft">{step.actor}:</span> {step.does}
          </p>
        )}
        {step.call && (
          <p className="mt-1.5 overflow-x-auto whitespace-nowrap font-mono text-xs text-soft">
            {step.call.method} {step.call.path}
            {step.call.body !== undefined ? ` ${JSON.stringify(step.call.body)}` : ""}
          </p>
        )}
        <p className={`mt-1.5 text-[15px] ${attack || step.verdict === "blocked" ? "font-medium" : ""}`}>
          <span className="text-soft">Gateway:</span> {step.says}
        </p>
        {(step.ruleName || step.auditId) && (
          <p className="mt-1 text-sm text-soft">
            {step.ruleName ? `Rule: ${step.ruleName}. ` : ""}
            {step.auditId ? (
              <>
                Audit entry <span className="font-mono text-xs">{step.auditId}</span>
              </>
            ) : null}
          </p>
        )}
        {step.details && step.details.length > 0 && (
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
            {step.details.map((d, i) => (
              <div key={i} className="contents">
                <dt className="text-soft">{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {step.links && step.links.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-x-5 text-sm">
            {step.links.map((l) => (
              <Link key={l.href} href={l.href} className="font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
                {l.label}
              </Link>
            ))}
          </p>
        )}
      </div>
      {step.kind !== "setup" && (
        <div className="flex items-start gap-2 sm:flex-col sm:items-end">
          <span className={`stamp-land inline-block whitespace-nowrap rounded-sm border-2 px-2 py-1 text-sm font-extrabold ${TONE[v.tone]}`}>{label}</span>
          {step.status !== null && <span className="font-mono text-xs text-soft">HTTP {step.status}</span>}
        </div>
      )}
    </li>
  );
}

export function RunConsole() {
  const [info, setInfo] = useState<Info | null>(null);
  const [date, setDate] = useState("");
  const [running, setRunning] = useState<RunId | null>(null);
  const [start, setStart] = useState<Start | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Info>("/api/demo/info").then((r) => {
      if (!r.ok) return;
      setInfo(r.json);
      setDate((d) => d || r.json.defaultDeliveryDate);
    });
  }, []);

  async function run(id: RunId) {
    setRunning(id);
    setSteps([]);
    setStart(null);
    setProblem(null);
    try {
      const res = await fetch("/api/demo/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: id, deliveryDate: date || undefined }) });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        setProblem(body.reason ?? `The run could not start (HTTP ${res.status}).`);
        return;
      }
      // One JSON object per line, as each step finishes
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const item = JSON.parse(line) as Start | Step;
          if (item.kind === "start") setStart(item);
          else setSteps((s) => [...s, item]);
        }
        bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    } catch (e) {
      setProblem(`The connection to the gateway broke: ${String(e)}`);
    } finally {
      setRunning(null);
    }
  }

  const attacks = steps.filter((s) => s.kind === "attack");
  const breakIt = start?.run === "break-it";

  return (
    <section aria-label="Demo runs">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {ORDER.map((id) => {
            const r = info?.runs[id];
            const danger = id === "break-it";
            return (
              <button
                key={id}
                type="button"
                disabled={!info || running !== null}
                onClick={() => run(id)}
                className={`rounded border px-3 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${
                  danger ? "border-stop bg-sheet hover:bg-stop-bg" : "border-line bg-sheet hover:border-teal"
                } ${running === id ? "ring-2 ring-teal" : ""}`}
              >
                <span className={`block font-bold ${danger ? "text-stop" : ""}`}>{r?.title ?? id}</span>
                <span className="mt-0.5 block text-sm text-soft">{r?.ask ?? ""}</span>
              </button>
            );
          })}
        </div>
        <label className="text-sm">
          <span className="block text-soft">Delivery date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 rounded border border-line bg-sheet px-2 py-1.5" />
        </label>
      </div>

      {problem && (
        <p role="alert" className="mt-4 rounded border border-stop bg-stop-bg px-4 py-3 text-stop">
          {problem}
        </p>
      )}

      {!start && !running && !problem && (
        <p className="mt-6 rounded border border-dashed border-line px-4 py-8 text-center text-soft">
          Pick a run. Each one is a fixed list of calls to the gateway&apos;s REST API, with no language model in between, so you see exactly what an agent
          sends and what the gateway answers.
        </p>
      )}

      {(start || running) && (
        <div className="mt-6 rounded border border-line bg-sheet">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-4 py-3">
            <div>
              <h2 className="text-xl font-extrabold">{start?.title ?? "Starting"}</h2>
              {start && (
                <p className="text-soft">
                  {start.ask}. Delivery {fmtDay(start.deliveryDate)}.
                </p>
              )}
            </div>
            {breakIt && (
              <ol aria-label="Attacks stopped" className="flex gap-1.5">
                {Array.from({ length: 8 }, (_, i) => {
                  const a = attacks.find((x) => x.number === i + 1);
                  return (
                    <li
                      key={i}
                      title={a ? `${a.title}: ${a.stopped ? "stopped" : "got through"}` : `Attack ${i + 1}`}
                      className={`grid h-9 w-9 place-items-center rounded-sm border-2 text-sm font-extrabold ${
                        a ? (a.stopped ? "stamp-land border-stop bg-stop-bg text-stop" : "border-ink bg-ink text-white") : "border-line text-line"
                      }`}
                    >
                      {a ? (a.stopped ? "✕" : "!") : i + 1}
                    </li>
                  );
                })}
              </ol>
            )}
          </header>
          <ol>
            {steps.map((s, i) => (
              <StepRow key={i} step={s} />
            ))}
          </ol>
          {running && (
            <p className="px-4 py-3 text-sm text-soft" aria-live="polite">
              Calling the gateway…
            </p>
          )}
          <div ref={bottom} />
        </div>
      )}
    </section>
  );
}
