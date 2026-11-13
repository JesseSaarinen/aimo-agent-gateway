// Downloads the static challenge files into ./data. Run: npm run fetch-data
// The files don't change during the challenge, so this only needs to run once.
import { writeFile, mkdir } from "node:fs/promises";

const base = process.env.VALIO_API_BASE ?? "https://junction26.valioaimo.fi/api";
const key = process.env.VALIO_API_KEY;
if (!key) {
  console.error("VALIO_API_KEY missing. Put it in .env.local.");
  process.exit(1);
}

const files = [
  ["products/download", "products.json"],
  ["delivery-reliability/download", "reliability.csv"],
  ["carbon-footprint/download", "carbon.csv"],
];

await mkdir("data", { recursive: true });
for (const [path, name] of files) {
  const res = await fetch(`${base}/${path}`, { headers: { "X-API-Key": key } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`data/${name}`, buf);
  console.log(`data/${name}  ${(buf.length / 1e6).toFixed(1)} MB`);
}
