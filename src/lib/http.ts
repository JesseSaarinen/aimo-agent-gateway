// Shared by the REST routes: read the caller's key, run the handler, and turn refusals into HTTP answers.
import { z } from "zod";
import { demoKeys, requireCaller, type Caller } from "./agents";
import { Refusal, RULES } from "./rules";

/** The demo sign-in cookies set by /api/demo/session. They stand in for the purchaser's and Valio Aimo's real login. */
export const DEMO_COOKIES = { purchaser: "aimo_demo_purchaser", supplier: "aimo_demo_supplier" } as const;
export type DemoRole = keyof typeof DEMO_COOKIES;

const hasCookie = (req: Request, name: string) => (req.headers.get("cookie") ?? "").split(/;\s*/).some((c) => c === `${name}=1`);

/**
 * `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 * The app's own pages have no key: they send `X-Demo-Role: purchaser` (or supplier) and the matching sign-in cookie.
 * A page on another site can't send that header, so the cookie alone is never enough.
 */
export function keyFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer /i.test(auth)) return auth.slice(7).trim() || null;
  const key = req.headers.get("x-api-key");
  if (key) return key;
  const role = req.headers.get("x-demo-role");
  if ((role === "purchaser" || role === "supplier") && hasCookie(req, DEMO_COOKIES[role])) return demoKeys()[role];
  return null;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof Refusal) {
    return Response.json(e.toJSON(), { status: e.http, headers: e.http === 401 ? { "WWW-Authenticate": "Bearer" } : undefined });
  }
  if (e instanceof z.ZodError) {
    return Response.json(
      { status: "refused", rule: "invalid_request", ruleName: RULES.invalid_request, reason: z.prettifyError(e), final: true, auditId: null, detail: e.issues },
      { status: 400 },
    );
  }
  console.error(e);
  return Response.json({ status: "error", error: "upstream_error", detail: String(e) }, { status: 502 });
}

export const readJson = (req: Request): Promise<unknown> => req.json().catch(() => null);

/** A route that needs a known key. `action` names it in the audit log if the key is refused. */
export async function withCaller(req: Request, action: string, run: (caller: Caller) => Promise<unknown>): Promise<Response> {
  // Read the headers outside the try block: at build time Next.js stops a GET route right here to mark it
  // as dynamic, and that signal must not be caught and logged as an error.
  const key = keyFrom(req);
  try {
    const caller = await requireCaller(key, action);
    return Response.json(await run(caller));
  } catch (e) {
    return errorResponse(e);
  }
}

/** A route anyone may call. */
export async function open(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run());
  } catch (e) {
    return errorResponse(e);
  }
}
