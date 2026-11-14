// Creates the Ed25519 key that signs offers and appends it to .env.local as OFFER_SIGNING_KEY.
// The key is never printed. Run: npm run create-signing-key
// For the deployed site, add the same line to Vercel (Project > Settings > Environment Variables, Production).
import { generateKeyPairSync } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

const FILE = ".env.local";
const NAME = "OFFER_SIGNING_KEY";

let existing = "";
try {
  existing = await readFile(FILE, "utf8");
} catch {
  // no .env.local yet: it will be created
}

if (new RegExp(`^${NAME}=`, "m").test(existing)) {
  console.log(`${FILE} already has ${NAME}. Nothing changed. Remove that line first if you want a new key (old offers then stop verifying).`);
  process.exit(0);
}

const { privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" }); // { kty: "OKP", crv: "Ed25519", x, d }
const value = Buffer.from(JSON.stringify(jwk)).toString("base64url");

await appendFile(FILE, `${existing && !existing.endsWith("\n") ? "\n" : ""}# Signs offers (Ed25519). Public part is served at /.well-known/jwks.json\n${NAME}=${value}\n`);
console.log(`Added ${NAME} to ${FILE} (not shown). Restart the dev server to use it.`);
