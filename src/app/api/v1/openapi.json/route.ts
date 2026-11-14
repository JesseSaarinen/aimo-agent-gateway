import { openapi } from "@/lib/openapi";

// GET /api/v1/openapi.json
// The REST API as an OpenAPI 3.1 document, built from the zod schemas the routes use. Public.
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  return Response.json(openapi(origin), { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
