"use client";
// Paste a signed offer, change one character, watch it fail. The check runs twice: once by the gateway,
// and once in this browser with only the public key, so nobody has to take the gateway's word for it.
import { createLocalJWKSet, errors, jwtVerify } from "jose";
import { useEffect, useState } from "react";
import { fmtDateTime, fmtDay } from "@/lib/dates";
import type { Offer } from "@/lib/offers";
import { api, money, qty } from "./client";
import { Chip } from "./OrderDocket";

type Verdict = { valid: boolean; text: string };

async function checkInBrowser(token: string): Promise<Verdict> {
  try {
    const keys = await (await fetch("/.well-known/jwks.json", { cache: "no-store" })).json();
    await jwtVerify(token, createLocalJWKSet(keys), { issuer: "aimo-agent-gateway" });
    return { valid: true, text: "The signature matches the public key and the offer has not expired." };
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { valid: false, text: "The signature is genuine, but the offer has expired." };
    if (e instanceof errors.JWSSignatureVerificationFailed) return { valid: false, text: "The signature does not match the content." };
    if (e instanceof errors.JOSEError) return { valid: false, text: "This is not a signed offer the public key can verify." };
    return { valid: false, text: `This browser could not run the check itself (${String(e)}).` };
  }
}

function readOffer(token: string): Offer | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return (JSON.parse(new TextDecoder().decode(bytes)).offer as Offer) ?? null;
  } catch {
    return null;
  }
}

/** Swap one character in the middle part of the token (the offer itself) for a different one. */
function changeOneCharacter(token: string): { token: string; at: number } {
  const [head, payload, signature] = token.split(".");
  const at = Math.floor(payload.length * 0.25 + Math.random() * payload.length * 0.5);
  const other = payload[at] === "A" ? "B" : "A";
  return { token: `${head}.${payload.slice(0, at)}${other}${payload.slice(at + 1)}.${signature}`, at: head.length + 1 + at };
}

const VerdictBox = ({ who, verdict }: { who: string; verdict: Verdict | null }) => (
  <div className={`rounded border-2 px-4 py-3 ${verdict ? (verdict.valid ? "border-go bg-go-bg" : "border-stop bg-stop-bg") : "border-line bg-sheet"}`}>
    <p className="text-sm text-soft">{who}</p>
    <p className={`text-xl font-extrabold ${verdict ? (verdict.valid ? "text-go" : "text-stop") : "text-soft"}`}>{verdict ? (verdict.valid ? "Genuine" : "Not valid") : "Not checked yet"}</p>
    {verdict && <p className="mt-1 text-[15px]">{verdict.text}</p>}
  </div>
);

export function VerifyTool() {
  const [token, setToken] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const [changedAt, setChangedAt] = useState<number | null>(null);
  const [gateway, setGateway] = useState<Verdict | null>(null);
  const [browser, setBrowser] = useState<Verdict | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(value: string) {
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    const [g, b] = await Promise.all([api("/api/v1/offers/verify", { body: { offerToken: t } }), checkInBrowser(t)]);
    setGateway({ valid: g.json.valid === true, text: g.json.reason ?? "The gateway could not check this." });
    setBrowser(b);
    setBusy(false);
  }

  // /verify?offer=off_... loads that offer's signed token (the demo purchaser may read the buyer's offers)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("offer");
    if (!id) return;
    api(`/api/v1/offers/${encodeURIComponent(id)}`, { role: "purchaser" }).then((r) => {
      if (!r.ok) return setNote(`Offer ${id} could not be loaded: ${r.json.reason ?? "not found"}`);
      setToken(r.json.token);
      setOriginal(r.json.token);
      setNote(`Loaded offer ${id}.`);
      void verify(r.json.token);
    });
  }, []);

  function tamper() {
    const base = original ?? token.trim();
    if (base.split(".").length !== 3) return setNote("Paste a signed offer first: three parts separated by dots.");
    setOriginal(base);
    const changed = changeOneCharacter(base);
    setToken(changed.token);
    setChangedAt(changed.at);
    setNote(`Character ${changed.at + 1} of ${changed.token.length} was changed.`);
    void verify(changed.token);
  }

  function restore() {
    if (!original) return;
    setToken(original);
    setChangedAt(null);
    setNote("The original offer is back.");
    void verify(original);
  }

  const offer = token.trim() ? readOffer(token.trim()) : null;
  const button = "rounded border px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <>
      <h1 className="text-3xl font-extrabold tracking-tight">Verify an offer</h1>
      <p className="mt-1 max-w-3xl text-soft">
        Every offer the gateway makes is signed with its private key (Ed25519). Prices, quantities, origin and label claims are all inside the signature.
        Paste an offer below, or get one from a demo run, then change a single character.
      </p>

      <label htmlFor="token" className="mt-6 block font-bold">
        Signed offer
      </label>
      <textarea
        id="token"
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          setChangedAt(null);
          setGateway(null);
          setBrowser(null);
        }}
        rows={7}
        spellCheck={false}
        placeholder="eyJhbGciOiJFZERTQSIs…  Run the milk run on the demo page and follow “Check this offer's signature”, or paste the token from POST /api/v1/offers."
        className="mt-1 w-full rounded border border-line bg-sheet p-3 font-mono text-xs leading-relaxed"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={`${button} border-teal bg-teal text-white hover:bg-teal-deep`} disabled={busy || !token.trim()} onClick={() => verify(token)}>
          Verify
        </button>
        <button type="button" className={`${button} border-stop bg-sheet text-stop hover:bg-stop-bg`} disabled={busy || !token.trim()} onClick={tamper}>
          Change one character
        </button>
        {original && changedAt !== null && (
          <button type="button" className={`${button} border-line bg-sheet hover:border-ink`} disabled={busy} onClick={restore}>
            Put the original back
          </button>
        )}
        {note && (
          <p role="status" className="text-sm text-soft">
            {note}
          </p>
        )}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <VerdictBox who="The gateway says" verdict={gateway} />
        <VerdictBox who="Your browser says, using only the public key" verdict={browser} />
      </div>
      <p className="mt-2 text-sm text-soft">
        The public key is at{" "}
        <a href="/.well-known/jwks.json" className="font-semibold text-teal underline underline-offset-2">
          /.well-known/jwks.json
        </a>
        . Any JWT library can run the same check (algorithm EdDSA).
      </p>

      {!offer && gateway && !gateway.valid && token.trim().split(".").length === 3 && (
        <p className="mt-8 rounded border border-dashed border-stop px-4 py-4 text-soft">
          The changed text can no longer even be read as an offer. Put the original back to see what Valio Aimo signed.
        </p>
      )}

      {offer && (
        <section aria-labelledby="content-heading" className="mt-8">
          <h2 id="content-heading" className="text-xl font-bold">
            What this offer says
          </h2>
          <p className="mt-1 text-soft">
            {gateway?.valid
              ? "Valio Aimo signed exactly this."
              : gateway
                ? "Read from the text above. It is not what Valio Aimo signed, so none of it can be relied on."
                : "Read from the text above, not yet checked."}
          </p>
          <div className={`mt-3 rounded border bg-sheet ${gateway && !gateway.valid ? "border-stop" : "border-line"}`}>
            <dl className="grid gap-x-6 gap-y-1 border-b border-line px-4 py-3 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-soft">Offer</dt>
              <dd className="font-mono text-xs">{offer.id}</dd>
              <dt className="text-soft">Made for</dt>
              <dd>
                {offer.agentId}, buying for {offer.buyerId}
              </dd>
              <dt className="text-soft">Delivery</dt>
              <dd>
                {fmtDay(offer.deliveryDate)} to {offer.deliverySite}
              </dd>
              <dt className="text-soft">Prices fixed until</dt>
              <dd>{fmtDateTime(offer.expiresAt)}</dd>
              <dt className="text-soft">Total, without VAT</dt>
              <dd className="font-semibold">{money(offer.total)}</dd>
            </dl>
            <ol>
              {offer.lines.map((l) => (
                <li key={l.line} className="border-b border-line px-4 py-3 last:border-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-4">
                    <p className="font-medium">
                      <span className="mr-2 text-soft">{l.line}</span>
                      {l.name ?? l.productId}
                    </p>
                    <p className="font-semibold">{l.total !== null ? money(l.total) : "no price"}</p>
                  </div>
                  <p className="text-sm text-soft">
                    {l.requested.amount} {l.requested.unit} asked
                    {l.quantity !== null && l.unitPrice !== null ? `; ${qty(l.quantity, l.salesUnit)} at ${money(l.unitPrice)}` : ""}
                  </p>
                  <p className="mt-1.5 flex flex-wrap gap-1.5">
                    <Chip tone="ink">Origin: {l.claims.origin?.toUpperCase() ?? "not stated"}</Chip>
                    <Chip tone={l.claims.allergenDataKnown ? "ink" : "wait"}>{l.claims.allergenDataKnown ? "Allergen data on file" : "No allergen data"}</Chip>
                    {Object.entries(l.claims.requirements).map(([r, v]) => (
                      <Chip key={r} tone={v === "yes" ? "go" : v === "no" ? "stop" : "wait"}>
                        {r.replace(/_/g, " ")}: {v}
                      </Chip>
                    ))}
                    {l.claims.labels.map((label) => (
                      <Chip key={label} tone="ink">
                        {label.replace(/_/g, " ").toLowerCase()}
                      </Chip>
                    ))}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </>
  );
}
