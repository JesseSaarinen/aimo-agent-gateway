// Tries the REST routes and the MCP endpoint on a running dev server, as scripted calls with the demo keys.
// Full flow (fake data only):  npm run dev:fake -- -p 3301   then   node scripts/try-routes.mjs http://localhost:3301
// Without touching Valio:      node scripts/try-routes.mjs http://localhost:3300 --no-valio
// Run the full flow on a freshly started server. A second run on the same server fails some checks, correctly:
// the first run's confirmed orders are still in memory, so the weekly budget sends the next ones to approval.
const BASE = process.argv[2] ?? "http://localhost:3301";
const NO_VALIO = process.argv.includes("--no-valio");
const KEYS = { agent: "agent_lumikello_kitchen_demo", other: "agent_lumikello_banquet_demo", purchaser: "purchaser_lumikello_demo", supplier: "aimo_sales_view_demo" };
const MONDAY = "2026-11-16";

async function api(method, path, key, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

let id = 0;
async function mcp(path, method, params, key) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
  let json;
  try { json = JSON.parse(data); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, type: res.headers.get("content-type"), json };
}

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ->  " + detail : ""}`); };
const short = (o) => JSON.stringify(o).slice(0, 220);

// --- routes that never reach Valio ---
let r = await api("GET", "/.well-known/jwks.json");
check("jwks", r.status === 200 && r.json.keys?.[0]?.crv === "Ed25519" && !("d" in r.json.keys[0]), short(r.json));

r = await api("GET", "/api/v1/mandate", KEYS.agent);
check("mandate read (agent)", r.status === 200 && r.json.mandate?.maxOrderEur > 0 && r.json.rules?.length === 6, `limit ${r.json.mandate?.maxOrderEur}, sites ${r.json.mandate?.deliverySites}`);
const startLimit = r.json.mandate?.maxOrderEur;

r = await api("GET", "/api/v1/mandate", "made_up_key");
check("unknown key -> 401", r.status === 401 && r.json.rule === "agent_identity" && !!r.json.auditId, short(r.json));
r = await api("GET", "/api/v1/mandate");
check("no key -> 401", r.status === 401 && r.json.rule === "agent_identity", short(r.json));

r = await api("PATCH", "/api/v1/mandate", KEYS.agent, { maxOrderEur: 999999 });
check("agent can't change mandate -> 403", r.status === 403 && r.json.rule === "mandate_authority", short(r.json));
r = await api("PATCH", "/api/v1/mandate", KEYS.purchaser, { maxOrderEur: "lots" });
check("bad mandate input -> 400", r.status === 400 && r.json.rule === "invalid_request", short(r.json));

r = await api("POST", "/api/v1/orders", KEYS.agent, {});
check("order with no offer -> 400", r.status === 400 && r.json.rule === "offer_required", short(r.json));
r = await api("POST", "/api/v1/orders", KEYS.agent, { offerToken: "aaa.bbb.ccc" });
check("order with junk token -> 422", r.status === 422 && r.json.rule === "offer_signature", short(r.json));
r = await api("POST", "/api/v1/orders", KEYS.purchaser, { offerId: "off_x" });
check("purchaser can't place orders -> 403", r.status === 403 && r.json.rule === "access", short(r.json));
r = await api("POST", "/api/v1/offers/verify", null, { offerToken: "aaa.bbb.ccc" });
check("public verify of junk -> valid:false", r.status === 200 && r.json.valid === false, short(r.json));
r = await api("POST", "/api/v1/orders/ord_nope/decisions", KEYS.agent, { line: 1, action: "approve" });
check("agent can't approve -> 403", r.status === 403 && r.json.rule === "approval_authority" && !!r.json.auditId, short(r.json));
r = await api("GET", "/api/v1/orders/ord_nope", KEYS.agent);
check("unknown order -> 404", r.status === 404 && r.json.rule === "access", short(r.json));
r = await api("GET", "/api/v1/orders", KEYS.purchaser);
check("orders list (purchaser)", r.status === 200 && Array.isArray(r.json.orders), `total ${r.json.total}`);
r = await api("GET", "/api/v1/audit", KEYS.agent);
check("agent can't read audit -> 403", r.status === 403 && r.json.rule === "access", short(r.json));
r = await api("GET", "/api/v1/audit?limit=100", KEYS.supplier);
check("audit (Valio view) shows the unknown-key attempt", r.status === 200 && r.json.entries.some((e) => e.rule === "agent_identity" && e.buyerId === null), `total ${r.json.total}, newest: ${r.json.entries[0]?.action}`);
r = await api("POST", "/api/v1/offers", KEYS.agent, { deliverySite: "stockholm", deliveryDate: MONDAY, lines: [{ productId: "465039", amount: 10, unit: "L" }] });
check("offer for a site outside the mandate -> 403 (refused before Valio)", r.status === 403 && r.json.rule === "delivery_site", short(r.json));
r = await api("POST", "/api/v1/quote", null, { productIds: ["465039"], deliveryDate: MONDAY, amount: 10, unit: "L" });
check("quote without a key -> 401 (refused before Valio)", r.status === 401 && r.json.rule === "agent_identity", short(r.json));
r = await api("GET", "/api/v1/openapi.json");
check("OpenAPI document lists the routes", r.status === 200 && r.json.openapi === "3.1.0" && !!r.json.paths?.["/api/v1/orders/{id}/decisions"]?.post && r.json.servers?.[0]?.url === BASE, `${Object.keys(r.json.paths ?? {}).length} paths, server ${r.json.servers?.[0]?.url}`);

// MCP, without Valio
r = await mcp("/api/mcp/made_up_key", "tools/list", {});
check("MCP unknown key in path -> 401", r.status === 401 && r.json.rule === "agent_identity", short(r.json));
r = await mcp("/api/mcp", "tools/list", {}, KEYS.purchaser);
check("MCP with purchaser key -> 403", r.status === 403 && r.json.rule === "access", short(r.json));
r = await mcp(`/api/mcp/${KEYS.agent}`, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "try-routes", version: "0" } });
check("MCP initialize (key in path)", r.status === 200 && !!r.json.result?.serverInfo, `${r.type} ${short(r.json.result?.serverInfo)} instructions ${r.json.result?.instructions?.length} chars`);
r = await mcp("/api/mcp", "tools/list", {}, KEYS.agent);
const names = r.json.result?.tools?.map((t) => t.name) ?? [];
check("MCP tools/list (bearer key)", names.join() === "search_products,find_options,request_offer,verify_offer,place_order,get_order_status", names.join() || short(r.json));
check("MCP tools carry JSON schemas", !!r.json.result?.tools?.[2]?.inputSchema?.properties?.lines, short(r.json.result?.tools?.[2]?.inputSchema?.properties?.lines));
r = await mcp(`/api/mcp/${KEYS.agent}`, "tools/call", { name: "search_products", arguments: { query: "maito laktoositon", limit: 2 } });
let payload = JSON.parse(r.json.result?.content?.[0]?.text ?? "{}");
check("MCP search_products", payload.total > 10 && payload.products?.length === 2, `total ${payload.total}, first ${payload.products?.[0]?.name}`);
r = await mcp(`/api/mcp/${KEYS.agent}`, "tools/call", { name: "place_order", arguments: {} });
payload = JSON.parse(r.json.result?.content?.[0]?.text ?? "{}");
check("MCP place_order with no offer -> refused, isError", r.json.result?.isError === true && payload.rule === "offer_required" && payload.final === true, short(payload));

if (NO_VALIO) {
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed (routes that reach Valio were skipped)`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

// --- the full flow (only run this against the fake server) ---
r = await api("POST", "/api/v1/options", KEYS.agent, { query: "maito laktoositon", amount: 1000, unit: "L", deliveryDate: MONDAY });
check("options: milk run", r.status === 200 && r.json.possible === true && r.json.source?.startsWith("FAKE"), `${r.json.message} | best ${r.json.options?.[0]?.parts?.[0]?.name} ${r.json.options?.[0]?.total}`);
const productId = r.json.options?.[0]?.parts?.[0]?.productId;

r = await api("POST", "/api/v1/offers", KEYS.agent, { deliverySite: "helsinki", deliveryDate: MONDAY, lines: [{ productId, amount: 1000, unit: "L" }] });
check("offer: signed, with token", r.status === 200 && r.json.decision === "allowed" && r.json.signature?.token?.split(".").length === 3, `${r.json.offerId} total ${r.json.total} expires ${r.json.expiresAt}`);
const { offerId } = r.json;
const token = r.json.signature?.token ?? "";

r = await api("POST", "/api/v1/offers/verify", null, { offerToken: token });
check("public verify: valid", r.json.valid === true && r.json.alreadyOrdered === null, r.json.reason);
const [h, p, s] = token.split(".");
r = await api("POST", "/api/v1/offers/verify", null, { offerToken: `${h}.${p.slice(0, 30)}${p[30] === "A" ? "B" : "A"}${p.slice(31)}.${s}` });
check("public verify: one character changed -> invalid", r.json.valid === false, r.json.reason);

r = await api("GET", `/api/v1/offers/${offerId}`, KEYS.other);
check("another agent can't read the offer -> 404", r.status === 404, short(r.json));
r = await api("POST", "/api/v1/orders", KEYS.other, { offerToken: token });
check("another agent can't order on it -> 403", r.status === 403 && r.json.rule === "offer_owner", short(r.json));

r = await api("POST", "/api/v1/orders", KEYS.agent, { offerId });
check("order: confirmed alone", r.status === 200 && r.json.order?.status === "confirmed" && r.json.replayed === false, r.json.order?.message);
const orderId = r.json.order?.id;
r = await api("POST", "/api/v1/orders", KEYS.agent, { offerId });
check("replay: same order back, nothing new", r.json.replayed === true && r.json.order?.id === orderId && r.json.rule === "offer_replay", r.json.notice);

// Over the limit -> waits; agent can't approve; purchaser raises the limit; the same request passes
const big = { deliverySite: "helsinki", deliveryDate: MONDAY, lines: [{ productId: "465039", amount: 4000, unit: "L" }] };
r = await api("POST", "/api/v1/offers", KEYS.agent, big);
r = await api("POST", "/api/v1/orders", KEYS.agent, { offerId: r.json.offerId });
check("order over the limit waits for the purchaser", r.json.order?.status === "awaiting_approval" && r.json.order?.findings?.[0]?.rule === "order_limit", r.json.order?.findings?.[0]?.reason);
const heldId = r.json.order?.id;
r = await api("POST", `/api/v1/orders/${heldId}/decisions`, KEYS.agent, { line: 1, action: "approve" });
check("agent can't approve its own order -> 403", r.status === 403 && r.json.rule === "approval_authority", r.json.reason);
r = await api("PATCH", "/api/v1/mandate", KEYS.purchaser, { maxOrderEur: 8000 });
check("purchaser raises the limit", r.status === 200 && r.json.mandate?.maxOrderEur === 8000, `version ${r.json.mandate?.version}`);
r = await api("POST", "/api/v1/offers", KEYS.agent, big);
r = await api("POST", "/api/v1/orders", KEYS.agent, { offerId: r.json.offerId });
check("the same request now goes through alone", r.json.order?.status === "confirmed", r.json.order?.message);
r = await api("POST", `/api/v1/orders/${heldId}/decisions`, KEYS.purchaser, { decisions: [{ line: 1, action: "reject", note: "ordered again after the limit change" }] });
check("purchaser rejects the held order", r.status === 200 && r.json.status === "rejected", r.json.message);

// An exception line with options, over MCP
r = await mcp(`/api/mcp/${KEYS.agent}`, "tools/call", { name: "request_offer", arguments: { deliverySite: "tampere", deliveryDate: MONDAY, lines: [{ productId: "463232", amount: 225, unit: "KG" }, { productId: "472332", amount: 60, unit: "ST" }] } });
payload = JSON.parse(r.json.result?.content?.[0]?.text ?? "{}");
check("MCP request_offer: blocked line gets ranked options", payload.summary?.blocked === 1 && payload.offer?.lines?.[0]?.options?.length === 2, payload.offer?.lines?.[0]?.options?.map((o) => `${o.rank}. ${o.reason} [${o.decision}]`).join(" | "));
r = await mcp(`/api/mcp/${KEYS.agent}`, "tools/call", { name: "place_order", arguments: { offerId: payload.offerId } });
payload = JSON.parse(r.json.result?.content?.[0]?.text ?? "{}");
check("MCP place_order: one confirmed, one for the purchaser", payload.order?.summary?.confirmed === 1 && payload.order?.summary?.blocked === 1 && payload.order?.status === "awaiting_approval", payload.order?.message);
const menuId = payload.order?.id;
r = await api("POST", `/api/v1/orders/${menuId}/decisions`, KEYS.purchaser, { line: 1, action: "pick_option", option: 1 });
check("purchaser picks option 1", r.status === 200 && r.json.status === "confirmed" && r.json.lines?.[0]?.fulfilment?.[0]?.productId === "472673", r.json.message);
r = await mcp(`/api/mcp/${KEYS.agent}`, "tools/call", { name: "get_order_status", arguments: { orderId: menuId } });
payload = JSON.parse(r.json.result?.content?.[0]?.text ?? "{}");
check("MCP get_order_status sees the purchaser's decision", payload.status === "confirmed" && payload.lines?.[0]?.resolution?.action === "option_picked", short(payload.lines?.[0]?.resolution));

r = await api("GET", `/api/v1/audit?orderId=${menuId}`, KEYS.purchaser);
check("audit log for that order", r.status === 200 && r.json.entries.length >= 4, r.json.entries.map((e) => e.action).reverse().join(", "));

// Put the limit back
await api("PATCH", "/api/v1/mandate", KEYS.purchaser, { maxOrderEur: startLimit });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
