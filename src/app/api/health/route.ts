import { storeKind } from "@/lib/store";
import { ping, valioSource } from "@/lib/valio";

// Checks that this app is up and can reach Valio Aimo's mock API, and says where orders are kept.
export async function GET() {
  const base = { app: "ok", store: storeKind(), valioSource: valioSource(), time: new Date().toISOString() };
  try {
    const valio = await ping();
    return Response.json({ ...base, valioApi: valio.status });
  } catch (e) {
    return Response.json({ ...base, valioApi: "error", detail: String(e) }, { status: 502 });
  }
}
