"use client";
// How to point your own agent at the gateway: the MCP address, the demo agent key, the tools and the REST routes.
import { useEffect, useState } from "react";
import { api } from "./client";

type Info = {
  buyer: { name: string; sites: { id: string; name: string }[] };
  agent: { name: string; key: string; mcpPath: string; mcpPathWithHeader: string };
  tools: { name: string; title: string; description: string; readOnly: boolean }[];
  defaultDeliveryDate: string;
};

const REST: [string, string, string, string][] = [
  ["POST", "/api/v1/options", "agent", "Up to three ranked, quoted options for something the buyer needs"],
  ["POST", "/api/v1/offers", "agent", "A signed offer for a basket, fixed prices for 30 minutes"],
  ["GET", "/api/v1/offers/{id}", "agent, purchaser, Valio Aimo", "A stored offer with its signed token"],
  ["POST", "/api/v1/offers/verify", "anyone", "Is this offer genuine, unchanged and still valid?"],
  ["POST", "/api/v1/orders", "agent", "Place an order on a signed offer"],
  ["GET", "/api/v1/orders", "agent, purchaser, Valio Aimo", "Orders, newest first. An agent sees only its own."],
  ["GET", "/api/v1/orders/{id}", "agent, purchaser, Valio Aimo", "One order with every line's status"],
  ["POST", "/api/v1/orders/{id}/decisions", "purchaser only", "Approve, reject or pick an option for a line"],
  ["GET", "/api/v1/mandate", "agent, purchaser, Valio Aimo", "The mandate as data and as sentences"],
  ["PATCH", "/api/v1/mandate", "purchaser only", "Change the mandate"],
  ["GET", "/api/v1/audit", "purchaser, Valio Aimo", "The log: who, what, which rule, why"],
  ["GET", "/api/v1/products/search", "anyone", "Search the catalogue. No prices, no stock."],
  ["POST", "/api/v1/quote", "agent", "Live price and stock for a shortlist of product codes"],
  ["GET", "/api/v1/openapi.json", "anyone", "This API as an OpenAPI 3.1 document"],
  ["GET", "/.well-known/jwks.json", "anyone", "The public key that verifies offers"],
];

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="shrink-0 rounded border border-line bg-sheet px-2.5 py-1 text-sm font-semibold hover:border-ink"
    >
      {done ? "Copied" : label}
    </button>
  );
}

const Code = ({ children }: { children: string }) => (
  <div className="mt-2 flex items-start justify-between gap-3 rounded border border-line bg-sheet p-3">
    <code className="min-w-0 overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed">{children}</code>
    <Copy text={children} label="Copy" />
  </div>
);

export function ConnectInfo() {
  const [info, setInfo] = useState<Info | null>(null);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    api<Info>("/api/demo/info").then((r) => {
      if (!r.ok) return;
      setInfo(r.json);
      setOrigin(window.location.origin);
    });
  }, []);

  if (!info) return <p className="text-soft">Loading…</p>;
  const mcp = `${origin}${info.agent.mcpPath}`;

  return (
    <>
      <h1 className="text-3xl font-extrabold tracking-tight">Connect an agent</h1>
      <p className="mt-1 max-w-3xl text-soft">
        The gateway speaks MCP and plain REST, with the same six tools behind both. The key below belongs to the demo agent of {info.buyer.name}. It can
        search, get offers and order inside the mandate. It can never approve an order or change the mandate.
      </p>

      <section aria-labelledby="mcp-heading" className="mt-8 max-w-3xl">
        <h2 id="mcp-heading" className="text-xl font-bold">
          MCP
        </h2>
        <p className="mt-1">
          In Claude Desktop, add a custom connector and paste this address. Then ask it for <span className="font-semibold">“1,000 litres of lactose-free milk by Monday”</span>.
        </p>
        <Code>{mcp}</Code>
        <p className="mt-4">In Claude Code:</p>
        <Code>{`claude mcp add --transport http aimo-gateway ${mcp}`}</Code>
        <p className="mt-4 text-sm text-soft">
          The key sits in the address because some clients can only be given a URL. That is for this demo only. Clients that can send headers use{" "}
          <code className="font-mono text-xs">{origin}{info.agent.mcpPathWithHeader}</code> with <code className="font-mono text-xs">Authorization: Bearer {info.agent.key}</code>. In
          production the gateway would use OAuth 2.1, as the MCP specification describes, with one client per agent.
        </p>
      </section>

      <section aria-labelledby="tools-heading" className="mt-10 max-w-3xl">
        <h2 id="tools-heading" className="text-xl font-bold">
          The six tools
        </h2>
        <p className="mt-1 text-soft">Written for an agent that has never seen this API. This is the text your agent reads.</p>
        <div className="mt-3 rounded border border-line bg-sheet">
          {info.tools.map((t) => (
            <details key={t.name} className="border-b border-line px-4 py-3 last:border-0">
              <summary className="cursor-pointer">
                <span className="font-mono text-sm font-semibold">{t.name}</span>
                <span className="ml-3 text-soft">{t.title}</span>
              </summary>
              <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed">{t.description}</p>
            </details>
          ))}
        </div>
      </section>

      <section aria-labelledby="rest-heading" className="mt-10">
        <h2 id="rest-heading" className="text-xl font-bold">
          REST
        </h2>
        <p className="mt-1 max-w-3xl text-soft">
          Send the key as <code className="font-mono text-xs">Authorization: Bearer …</code>. A refusal comes back with status &quot;refused&quot;, the rule, a
          one-line reason and the id of its log entry, and it is final. The whole API is described in an OpenAPI 3.1 document at{" "}
          <a href="/api/v1/openapi.json" className="font-mono text-xs font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
            /api/v1/openapi.json
          </a>
          , built from the same schemas the routes check input with.
        </p>
        <div className="max-w-3xl">
          <Code>{`curl -X POST ${origin}/api/v1/options \\
  -H "Authorization: Bearer ${info.agent.key}" -H "Content-Type: application/json" \\
  -d '{"query":"maito laktoositon","amount":1000,"unit":"L","deliveryDate":"${info.defaultDeliveryDate}"}'`}</Code>
        </div>
        <div className="mt-4 overflow-x-auto rounded border border-line bg-sheet">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-soft">
                <th className="px-3 py-2 font-medium">Route</th>
                <th className="px-3 py-2 font-medium">Who may call it</th>
                <th className="px-3 py-2 font-medium">What it does</th>
              </tr>
            </thead>
            <tbody>
              {REST.map(([method, path, who, what]) => (
                <tr key={method + path} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    <span className="inline-block w-12 font-semibold">{method}</span>
                    {path}
                  </td>
                  <td className="px-3 py-2">{who}</td>
                  <td className="px-3 py-2">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-soft">
          Delivery sites of {info.buyer.name}: {info.buyer.sites.map((s) => s.id).join(", ")}.
        </p>
      </section>
    </>
  );
}
