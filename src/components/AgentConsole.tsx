"use client";
// Talk to a real buying agent: a language model with the gateway's six tools and the demo agent's key.
// The page shows every tool call it makes and what the gateway answered, next to the agent's own words.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent-console";
import { api } from "./client";
import { Chip } from "./OrderDocket";

type Preset = { id: string; label: string; message: string };
type Call = { id: string; name: string; title: string; input: unknown; result: Extract<AgentEvent, { kind: "result" }> | null };
type Item = { kind: "said"; text: string } | { kind: "call"; call: Call };

/** A model's Markdown habits as plain text: "* item" becomes "• item", and ** and ` marks are dropped. */
const plain = (text: string) =>
  text
    .replace(/^[ \t]*[*-][ \t]+/gm, "• ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "");

const OUTCOME = {
  answered: { label: "Answered", tone: "ink" },
  refused: { label: "Refused", tone: "stop" },
  failed: { label: "No answer", tone: "stop" },
} as const;

export function AgentConsole() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ presets: Preset[] }>("/api/demo/agent").then((r) => r.ok && setPresets(r.json.presets));
  }, []);

  function take(event: AgentEvent) {
    if (event.kind === "start") return setModel(event.model);
    if (event.kind === "error") return setProblem(event.says);
    if (event.kind === "done") return setFinished(true);
    setItems((before) => {
      const last = before.at(-1);
      if (event.kind === "text") {
        if (last?.kind === "said") return [...before.slice(0, -1), { kind: "said", text: last.text + event.text }];
        return [...before, { kind: "said", text: event.text }];
      }
      if (event.kind === "tool") return [...before, { kind: "call", call: { id: event.id, name: event.name, title: event.title, input: event.input, result: null } }];
      return before.map((i) => (i.kind === "call" && i.call.id === event.id ? { kind: "call", call: { ...i.call, result: event } } : i));
    });
  }

  async function ask(message: string) {
    const clean = message.trim();
    if (clean.length < 3 || running) return;
    setRunning(true);
    setAsked(clean);
    setItems([]);
    setProblem(null);
    setFinished(false);
    try {
      const res = await fetch("/api/demo/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: clean }) });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        setProblem(body.reason ?? `The agent could not start (HTTP ${res.status}).`);
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) take(JSON.parse(line) as AgentEvent);
        bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    } catch (e) {
      setProblem(`The connection broke: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  const waiting = running && (items.length === 0 || (items.at(-1)?.kind === "call" && (items.at(-1) as { call: Call }).call.result !== null));

  return (
    <section aria-label="Live agent">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-extrabold tracking-tight">Ask a real agent</h1>
        <p className="mt-2 text-lg leading-relaxed text-soft">
          This is a language model working as the kitchen&apos;s buying agent. It holds one agent key and the gateway&apos;s six tools, the same ones your own
          agent gets over MCP. Nobody scripted what it does. Everything it calls and everything the gateway answers is shown below, and lands in the same
          order book and log.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={running}
            onClick={() => {
              setText(p.message);
              void ask(p.message);
            }}
            className={`rounded border bg-sheet px-3 py-2 text-left font-bold disabled:cursor-not-allowed disabled:opacity-60 ${p.id === "rogue" ? "border-stop text-stop hover:bg-stop-bg" : "border-line hover:border-teal"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <form
        className="mt-3 flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <label className="flex-1 text-sm">
          <span className="block text-soft">Or write your own request to the agent</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={600}
            rows={2}
            placeholder="Order 200 litres of lactose-free milk to Tampere for Monday."
            className="mt-1 w-full rounded border border-line bg-sheet px-3 py-2 text-base"
          />
        </label>
        <button type="submit" disabled={running || text.trim().length < 3} className="rounded bg-teal px-4 py-2.5 font-semibold text-white hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60">
          {running ? "Working…" : "Ask the agent"}
        </button>
      </form>

      {problem && (
        <p role="alert" className="mt-4 max-w-3xl rounded border border-stop bg-stop-bg px-4 py-3 text-stop">
          {problem}
        </p>
      )}

      {asked && (
        <div className="mt-6 rounded border border-line bg-sheet">
          <header className="border-b border-line px-4 py-3">
            <p className="text-sm text-soft">Kitchen manager</p>
            <p className="mt-0.5 text-[15px] font-medium">{asked}</p>
          </header>
          <ol aria-live="polite">
            {items.map((item, i) =>
              item.kind === "said" ? (
                <li key={i} className="border-b border-line bg-paper px-4 py-4 last:border-0">
                  <p className="text-sm text-soft">Agent{model ? ` (${model.split("/")[1]})` : ""}</p>
                  <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed">{plain(item.text)}</p>
                </li>
              ) : (
                <li key={i} className="grid gap-x-5 gap-y-2 border-b border-line px-4 py-4 last:border-0 sm:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <h3 className="font-bold">
                      {item.call.title} <span className="font-mono text-xs font-normal text-soft">{item.call.name}</span>
                    </h3>
                    <p className="mt-1.5 overflow-x-auto whitespace-nowrap font-mono text-xs text-soft">{JSON.stringify(item.call.input)}</p>
                    {item.call.result && (
                      <p className={`mt-1.5 text-[15px] ${item.call.result.outcome === "refused" ? "font-medium" : ""}`}>
                        <span className="text-soft">Gateway:</span> {item.call.result.says}
                      </p>
                    )}
                    {item.call.result && (item.call.result.rule || item.call.result.auditId) && (
                      <p className="mt-1 text-sm text-soft">
                        {item.call.result.rule ? `Rule: ${item.call.result.rule}. ` : ""}
                        {item.call.result.auditId ? (
                          <>
                            Audit entry <span className="font-mono text-xs">{item.call.result.auditId}</span>
                          </>
                        ) : null}
                      </p>
                    )}
                  </div>
                  <div className="sm:text-right">
                    {item.call.result ? <Chip tone={OUTCOME[item.call.result.outcome].tone}>{OUTCOME[item.call.result.outcome].label}</Chip> : <Chip tone="ink">Calling…</Chip>}
                  </div>
                </li>
              ),
            )}
            {waiting && <li className="px-4 py-4 text-soft">The agent is thinking…</li>}
          </ol>
          {finished && (
            <footer className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-4 py-3 text-sm">
              <Link href="/purchaser" className="font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
                See it on the purchaser&apos;s desk
              </Link>
              <Link href="/aimo" className="font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
                See it in Valio Aimo&apos;s view
              </Link>
            </footer>
          )}
        </div>
      )}
      <div ref={bottom} />

      <p className="mt-6 max-w-3xl text-sm text-soft">
        The model runs on Vercel&apos;s AI Gateway and can be wrong, like any agent. That is the point of the gateway: what it may buy is decided on Valio
        Aimo&apos;s side, not by how well it behaves. The scripted runs on the first page make the same calls with no model in between.
      </p>
    </section>
  );
}
