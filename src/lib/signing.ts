// Offers are signed with Ed25519 (a JWT with alg EdDSA), so anyone can check what Valio Aimo promised:
// fetch the public key from /.well-known/jwks.json and verify the token with any JWT library.
// The private key comes from OFFER_SIGNING_KEY (create one with `npm run create-signing-key`).
// Outside production a key is generated at start-up instead, so offers stop verifying after a restart.
import { calculateJwkThumbprint, errors, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { fmtDateTime } from "./dates";
import type { Offer } from "./offers";
import type { RuleId } from "./rules";

export const ISSUER = "aimo-agent-gateway";
const ALG = "EdDSA";
const TYP = "aimo-offer+jwt";

type Key = Awaited<ReturnType<typeof importJWK>>;
type Keys = { privateKey: Key; publicKey: Key; publicJwk: JWK; kid: string; source: "environment" | "generated at start-up" };

const g = globalThis as unknown as { __aimoSigningKeys?: Promise<Keys> };

async function load(): Promise<Keys> {
  const raw = process.env.OFFER_SIGNING_KEY;
  let privateJwk: JWK;
  if (raw) {
    privateJwk = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as JWK;
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("OFFER_SIGNING_KEY is not set. Create one with `npm run create-signing-key` and add it to the environment.");
  } else {
    const pair = await generateKeyPair(ALG, { crv: "Ed25519", extractable: true });
    privateJwk = await exportJWK(pair.privateKey);
  }
  const publicPart: JWK = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x };
  const kid = await calculateJwkThumbprint(publicPart);
  const publicJwk: JWK = { ...publicPart, kid, alg: ALG, use: "sig" };
  return {
    privateKey: await importJWK(privateJwk, ALG),
    publicKey: await importJWK(publicJwk, ALG),
    publicJwk,
    kid,
    source: raw ? "environment" : "generated at start-up",
  };
}

function keys(): Promise<Keys> {
  if (!g.__aimoSigningKeys) {
    g.__aimoSigningKeys = load();
    g.__aimoSigningKeys.catch(() => delete g.__aimoSigningKeys); // don't cache a failure
  }
  return g.__aimoSigningKeys;
}

/** The public key set served at /.well-known/jwks.json */
export async function jwks() {
  const k = await keys();
  return { keys: [k.publicJwk], keySource: k.source };
}

export async function signOffer(offer: Offer): Promise<{ token: string; keyId: string }> {
  const { privateKey, kid } = await keys();
  const token = await new SignJWT({ offer: offer as unknown as Record<string, unknown> })
    .setProtectedHeader({ alg: ALG, kid, typ: TYP })
    .setIssuer(ISSUER)
    .setSubject(offer.agentId)
    .setJti(offer.id)
    .setIssuedAt(new Date(offer.createdAt))
    .setExpirationTime(new Date(offer.expiresAt))
    .sign(privateKey);
  return { token, keyId: kid };
}

export type Verification =
  | { valid: true; offer: Offer; keyId: string }
  | { valid: false; problem: "missing" | "malformed" | "bad_signature" | "expired"; rule: RuleId; reason: string; offer: Offer | null };

/** Check a signed offer: is it one of ours, unaltered, and still valid? */
export async function verifyOfferToken(token: unknown): Promise<Verification> {
  if (typeof token !== "string" || !token.trim()) {
    return { valid: false, problem: "missing", rule: "offer_required", reason: "No offer was given. An order needs a signed offer from request_offer.", offer: null };
  }
  const { publicKey, kid } = await keys();
  try {
    const { payload } = await jwtVerify(token.trim(), publicKey, { issuer: ISSUER, algorithms: [ALG] });
    const offer = payload.offer as Offer | undefined;
    if (!offer || offer.id !== payload.jti || offer.agentId !== payload.sub) {
      return { valid: false, problem: "malformed", rule: "offer_signature", reason: "The token is signed by this gateway but is not an offer.", offer: null };
    }
    return { valid: true, offer, keyId: kid };
  } catch (e) {
    if (e instanceof errors.JWTExpired) {
      const offer = (e.payload.offer as Offer | undefined) ?? null;
      return {
        valid: false,
        problem: "expired",
        rule: "offer_expired",
        reason: `The offer expired on ${offer ? fmtDateTime(offer.expiresAt) : "an earlier date"}. Prices are only fixed for the validity time: request a new offer.`,
        offer,
      };
    }
    if (e instanceof errors.JWSSignatureVerificationFailed) {
      return {
        valid: false,
        problem: "bad_signature",
        rule: "offer_signature",
        reason: "The signature does not match the offer. It was changed after Valio Aimo signed it, or it was not signed by this gateway.",
        offer: null,
      };
    }
    return { valid: false, problem: "malformed", rule: "offer_signature", reason: "This is not a signed offer from this gateway.", offer: null };
  }
}
