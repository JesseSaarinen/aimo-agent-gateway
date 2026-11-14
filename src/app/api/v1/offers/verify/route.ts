import { z } from "zod";
import { open, readJson } from "@/lib/http";
import { verifyOffer } from "@/lib/offers";

const schema = z.object({ offerToken: z.string().min(1).max(200_000) });

// POST /api/v1/offers/verify  {offerToken}
// Public, no key needed: is this a genuine, unaltered, unexpired offer from this gateway?
// The same check can be done without this gateway, with the public keys at /.well-known/jwks.json.
export const POST = (req: Request) => open(async () => verifyOffer(schema.parse(await readJson(req)).offerToken));
