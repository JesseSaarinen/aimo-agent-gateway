import { connection } from "next/server";
import { jwks } from "@/lib/signing";

// GET /.well-known/jwks.json
// The public key that verifies signed offers (Ed25519). Anyone may fetch it.
export async function GET() {
  await connection(); // read at request time: outside production the key is generated at start-up
  try {
    const { keys } = await jwks();
    return Response.json({ keys }, { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
  } catch (e) {
    return Response.json({ error: "signing_key_missing", detail: String(e) }, { status: 503 });
  }
}
