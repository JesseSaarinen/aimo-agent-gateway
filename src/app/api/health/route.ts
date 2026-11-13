import { ping } from "@/lib/valio";

// Checks that this app is up and can reach Valio Aimo's mock API.
export async function GET() {
  try {
    const valio = await ping();
    return Response.json({ app: "ok", valioApi: valio.status, time: new Date().toISOString() });
  } catch (e) {
    return Response.json({ app: "ok", valioApi: "error", detail: String(e) }, { status: 502 });
  }
}
