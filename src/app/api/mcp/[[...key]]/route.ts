import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getBuyer, requireCaller, requireRole, type AgentCaller } from "@/lib/agents";
import { errorResponse, keyFrom } from "@/lib/http";
import { describeMandate, getMandate } from "@/lib/mandate";
import { Refusal } from "@/lib/rules";
import { SERVER_INSTRUCTIONS, TOOLS } from "@/lib/tools";

// The MCP endpoint: the same tools as the REST API, for any MCP client (Claude Desktop, Claude Code, ...).
//
//   /api/mcp          with  Authorization: Bearer <agent key>
//   /api/mcp/<key>    for clients that can only be given a URL, such as Claude Desktop
//
// DEMO ONLY: a key in the URL ends up in logs and browser history. Production would use OAuth 2.1 as the
// MCP specification describes (the gateway as a protected resource, one OAuth client per agent).
// An unknown key gets nothing: the request is refused before it reaches the MCP server, and logged.

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }], isError });

async function runForMcp(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return text(await run());
  } catch (e) {
    // A refusal is the gateway's final answer, with the rule and the reason. It is not a crash.
    if (e instanceof Refusal) return text(e.toJSON(), true);
    if (e instanceof z.ZodError) return text({ status: "refused", rule: "invalid_request", reason: z.prettifyError(e), final: true }, true);
    console.error(e);
    return text({ status: "error", error: "upstream_error", detail: String(e), hint: "Valio Aimo's price or stock service did not answer. Try again in a moment." }, true);
  }
}

async function handlerFor(agent: AgentCaller) {
  const mandate = await getMandate(agent.mandateId);
  const buyer = getBuyer(agent.buyerId);
  const instructions = [
    SERVER_INSTRUCTIONS,
    `You are "${agent.name}", ordering for ${buyer?.name ?? agent.buyerId}.`,
    `Delivery sites (use the id): ${buyer?.sites.map((s) => `${s.id} (${s.name})`).join(", ")}.`,
    `Your mandate, as the purchaser set it:\n${describeMandate(mandate).map((line) => `- ${line}`).join("\n")}`,
  ].join("\n\n");

  return createMcpHandler(
    (server) => {
      for (const tool of TOOLS) {
        server.registerTool(
          tool.name,
          { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: tool.readOnly } },
          (args: unknown) => runForMcp(() => tool.run(args, agent)),
        );
      }
    },
    { serverInfo: { name: "valio-aimo-agent-gateway", version: "0.1.0" }, instructions },
  );
}

async function handle(req: Request, ctx: { params: Promise<{ key?: string[] }> }): Promise<Response> {
  try {
    const fromPath = (await ctx.params).key?.[0];
    const caller = await requireCaller(keyFrom(req) ?? fromPath, "mcp");
    const agent = await requireRole(caller, ["agent"], "mcp", "access", "The MCP endpoint is for agents. Use an agent key.");
    return await (await handlerFor(agent))(req);
  } catch (e) {
    return errorResponse(e);
  }
}

export { handle as GET, handle as POST, handle as DELETE };
