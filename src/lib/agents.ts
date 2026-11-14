// Who is calling. Every key belongs to exactly one identity:
//   an agent (tied to one buyer and one mandate), the buyer's purchaser, or Valio Aimo's read-only view.
// An unknown key gets nothing. An agent key can never approve an order or change a mandate.
//
// DEMO ONLY: the keys below are fixed demo values, overridable with env variables, so judges can connect
// their own agent. Production would use OAuth 2.1 as the MCP specification describes, with one client per agent.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "./audit";
import { refuse, type RuleId } from "./rules";

export type Site = { id: string; name: string };
export type Buyer = { id: string; name: string; sites: Site[] };

/** The demo buyer is a made-up hotel chain, not a real company. */
export const DEMO_BUYER: Buyer = {
  id: "lumikello-hotels",
  name: "Lumikello Hotels (made-up demo buyer)",
  sites: [
    { id: "helsinki", name: "Lumikello Helsinki" },
    { id: "tampere", name: "Lumikello Tampere" },
    { id: "turku", name: "Lumikello Turku" },
    { id: "oulu", name: "Lumikello Oulu" },
    { id: "rovaniemi", name: "Lumikello Rovaniemi" },
  ],
};
export const DEMO_MANDATE_ID = "mandate-lumikello-kitchen";

const BUYERS = new Map<string, Buyer>([[DEMO_BUYER.id, DEMO_BUYER]]);
/** Sandbox buyers ("sbx-<run>") exist only for one break-it run and have the same five sites. */
export const getBuyer = (id: string): Buyer | null =>
  id.startsWith("sbx-") ? { id, name: "Break-it sandbox buyer", sites: DEMO_BUYER.sites } : (BUYERS.get(id) ?? null);
export const isSandbox = (buyerId: string | null) => !!buyerId?.startsWith("sbx-");

export type AgentCaller = { role: "agent"; id: string; name: string; buyerId: string; mandateId: string };
export type PurchaserCaller = { role: "purchaser"; id: string; name: string; buyerId: string; mandateId: string };
export type SupplierCaller = { role: "supplier"; id: string; name: string };
export type Caller = AgentCaller | PurchaserCaller | SupplierCaller;
export type Role = Caller["role"];

const KITCHEN_AGENT: AgentCaller = { role: "agent", id: "agent-kitchen", name: "Lumikello kitchen agent", buyerId: DEMO_BUYER.id, mandateId: DEMO_MANDATE_ID };
const BANQUET_AGENT: AgentCaller = { role: "agent", id: "agent-banquet", name: "Lumikello banquet agent", buyerId: DEMO_BUYER.id, mandateId: DEMO_MANDATE_ID };
const PURCHASER: PurchaserCaller = { role: "purchaser", id: "purchaser-lumikello", name: "Lumikello purchasing", buyerId: DEMO_BUYER.id, mandateId: DEMO_MANDATE_ID };
const SUPPLIER: SupplierCaller = { role: "supplier", id: "valio-aimo-sales", name: "Valio Aimo (read-only view)" };

/** The demo keys. Server-side only: never send the purchaser or supplier key to a browser or an agent. */
export function demoKeys() {
  return {
    agent: process.env.DEMO_AGENT_KEY || "agent_lumikello_kitchen_demo",
    secondAgent: process.env.DEMO_SECOND_AGENT_KEY || "agent_lumikello_banquet_demo",
    purchaser: process.env.DEMO_PURCHASER_KEY || "purchaser_lumikello_demo",
    supplier: process.env.DEMO_SUPPLIER_KEY || "aimo_sales_view_demo",
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** A short, safe-to-log fingerprint of a key. The key itself is never stored or logged. */
export const fingerprint = (key: string | null | undefined) => (key ? sha256(key).toString("hex").slice(0, 8) : "none");

// ---- Sandbox identities for the break-it run ----
// Each run gets its own throw-away buyer, mandate, agent and purchaser, so the attacks never touch the demo
// buyer's orders or budget. The keys are stateless: "sbx.<run>.<role>.<mac>", where the mac proves this
// server issued them. Nothing about them is stored.
const gs = globalThis as unknown as { __aimoSandboxSecret?: string };
const sandboxSecret = () => process.env.DEMO_SANDBOX_SECRET || process.env.OFFER_SIGNING_KEY || (gs.__aimoSandboxSecret ??= randomBytes(32).toString("hex"));

export function sandboxKey(run: string, role: "agent" | "purchaser"): string {
  const mac = createHmac("sha256", sandboxSecret()).update(`${run}.${role}`).digest("base64url").slice(0, 32);
  return `sbx.${run}.${role}.${mac}`;
}

function sandboxCaller(key: string): Caller | null {
  const [tag, run, role, mac] = key.split(".");
  if (tag !== "sbx" || !mac || !/^[a-z0-9]{6,16}$/.test(run ?? "") || (role !== "agent" && role !== "purchaser")) return null;
  if (!timingSafeEqual(sha256(key), sha256(sandboxKey(run, role)))) return null;
  const buyerId = `sbx-${run}`;
  const mandateId = `mandate-sbx-${run}`;
  return role === "agent"
    ? { role: "agent", id: `rogue-agent-${run}`, name: "Rogue agent (break-it run)", buyerId, mandateId }
    : { role: "purchaser", id: `purchaser-sbx-${run}`, name: "Sandbox purchaser (break-it run)", buyerId, mandateId };
}

export function authenticate(key: string | null | undefined): Caller | null {
  if (!key) return null;
  if (key.startsWith("sbx.")) return sandboxCaller(key);
  const given = sha256(key);
  const keys = demoKeys();
  const table: [string, Caller][] = [
    [keys.agent, KITCHEN_AGENT],
    [keys.secondAgent, BANQUET_AGENT],
    [keys.purchaser, PURCHASER],
    [keys.supplier, SUPPLIER],
  ];
  let found: Caller | null = null;
  for (const [k, caller] of table) if (timingSafeEqual(given, sha256(k))) found = caller;
  return found;
}

export const actorOf = (caller: Caller): Actor => ({ role: caller.role, id: caller.id });
export const buyerIdOf = (caller: Caller): string | null => (caller.role === "supplier" ? null : caller.buyerId);

/** Resolve a key or refuse. The refusal is written to the audit log. */
export async function requireCaller(key: string | null | undefined, action: string): Promise<Caller> {
  const caller = authenticate(key);
  if (caller) return caller;
  return refuse({
    rule: "agent_identity",
    reason: key ? "Unknown key. The gateway only answers registered agents." : "No key given. The gateway only answers registered agents.",
    http: 401,
    actor: { role: "unknown", id: `key:${fingerprint(key)}` },
    buyerId: null,
    action,
  });
}

/** Check the caller's role or refuse, citing the rule that reserves this action. */
export async function requireRole<R extends Role>(
  caller: Caller,
  roles: R[],
  action: string,
  rule: RuleId,
  reason: string,
  ref: { orderId?: string; offerId?: string; line?: number } = {},
): Promise<Extract<Caller, { role: R }>> {
  if ((roles as Role[]).includes(caller.role)) return caller as Extract<Caller, { role: R }>;
  return refuse({ rule, reason, http: 403, actor: actorOf(caller), buyerId: buyerIdOf(caller), action, ...ref });
}
