import { connection } from "next/server";
import { DEMO_BUYER, demoKeys } from "@/lib/agents";
import { defaultDeliveryDate, MENU, RUNS } from "@/lib/demo";
import { storeKind } from "@/lib/store";
import { TOOLS } from "@/lib/tools";
import { usingFakeValio, valioSource } from "@/lib/valio";

// GET /api/demo/info
// What the app's own pages need to explain the demo: the agent key and MCP address a visitor can connect
// their own agent with, the tools, the presets and where the data comes from.
// The agent key is public on purpose. The purchaser's and Valio Aimo's keys are never sent to a browser.
export async function GET() {
  await connection(); // the default delivery date depends on today's date
  const agentKey = demoKeys().agent;
  return Response.json({
    buyer: { name: DEMO_BUYER.name, sites: DEMO_BUYER.sites },
    agent: { name: "Lumikello kitchen agent", key: agentKey, mcpPath: `/api/mcp/${agentKey}`, mcpPathWithHeader: "/api/mcp" },
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: t.readOnly })),
    runs: RUNS,
    menu: MENU,
    defaultDeliveryDate: defaultDeliveryDate(),
    data: { source: valioSource(), fake: usingFakeValio(), store: storeKind() },
  });
}
