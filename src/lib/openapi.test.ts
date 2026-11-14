import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openapi } from "@/lib/openapi";
import { findOptionsSchema, mandatePatchSchema, requestOfferSchema } from "@/lib/schemas";
import { TOOLS } from "@/lib/tools";

type Operation = { operationId: string; summary: string; description?: string; security?: unknown[]; requestBody?: { content: { "application/json": { schema: Record<string, unknown> } } } };
const doc = openapi("https://gateway.example") as unknown as {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: { Refusal: { properties: { rule: { enum: string[] } } } } };
};

/** Every route.ts under src/app/api/v1, as [OpenAPI path, exported HTTP methods]. */
function routeFiles(): [string, string[]][] {
  const root = join(process.cwd(), "src", "app", "api", "v1");
  const out: [string, string[]][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        const path = `/api/v1/${relative(root, dir).split(sep).join("/")}`.replace(/\[(\w+)\]/g, "{$1}");
        const source = readFileSync(full, "utf8");
        const methods = ["GET", "POST", "PATCH", "DELETE"].filter((m) => new RegExp(`export (const|async function) ${m}\\b|\\bas ${m}\\b`).test(source));
        out.push([path, methods]);
      }
    }
  };
  walk(root);
  return out;
}

describe("OpenAPI document", () => {
  it("covers every REST route and method that exists in the code", () => {
    const routes = routeFiles();
    expect(routes.length).toBeGreaterThanOrEqual(12);
    for (const [path, methods] of routes) {
      expect(doc.paths[path], `${path} is missing from src/lib/openapi.ts`).toBeDefined();
      for (const m of methods) expect(doc.paths[path][m.toLowerCase()], `${m} ${path} is missing from src/lib/openapi.ts`).toBeDefined();
    }
  });

  it("describes nothing that is not a route", () => {
    const known = new Set([...routeFiles().map(([p]) => p), "/.well-known/jwks.json"]);
    expect(Object.keys(doc.paths).filter((p) => !known.has(p))).toEqual([]);
  });

  it("takes request bodies from the same zod schemas the routes parse with", () => {
    const fromZod = (s: z.ZodType) => {
      const { $schema, ...rest } = z.toJSONSchema(s, { io: "input" }) as Record<string, unknown>;
      void $schema;
      return rest;
    };
    const bodyOf = (path: string, method: string) => doc.paths[path][method].requestBody!.content["application/json"].schema;
    expect(bodyOf("/api/v1/options", "post")).toEqual(fromZod(findOptionsSchema));
    expect(bodyOf("/api/v1/offers", "post")).toEqual(fromZod(requestOfferSchema));
    expect(bodyOf("/api/v1/mandate", "patch")).toEqual(fromZod(mandatePatchSchema));
    expect(bodyOf("/api/v1/offers", "post").required).toEqual(["deliverySite", "deliveryDate", "lines"]);
  });

  it("gives each of the six tools one operation, with the text the MCP server shows", () => {
    const operations = Object.values(doc.paths).flatMap((p) => Object.values(p));
    for (const tool of TOOLS) {
      const op = operations.find((o) => o.operationId === tool.name);
      expect(op, `no operation for ${tool.name}`).toBeDefined();
      expect(op!.summary).toBe(tool.title);
      expect(op!.description).toContain(tool.description);
    }
    expect(new Set(operations.map((o) => o.operationId)).size).toBe(operations.length);
  });

  it("marks which routes need a key, and lists every rule a refusal can cite", () => {
    expect(doc.paths["/api/v1/offers"].post.security).toEqual([{ bearerKey: [] }]);
    expect(doc.paths["/api/v1/quote"].post.security).toEqual([{ bearerKey: [] }]);
    expect(doc.paths["/api/v1/offers/verify"].post.security).toBeUndefined();
    expect(doc.paths["/api/v1/products/search"].get.security).toBeUndefined();
    expect(doc.components.schemas.Refusal.properties.rule.enum).toEqual(expect.arrayContaining(["offer_signature", "offer_replay", "weekly_budget", "agent_identity"]));
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://gateway.example" }]);
  });
});
