// Builds a slim product index from Valio Aimo's static files.
// Input: data/products.json (87 MB), data/reliability.csv, data/carbon.csv
// Output: src/generated/products-index.json (bundled into the app, gitignored)
// Run: npm run build-index (also runs automatically before `npm run build`)
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execSync } from "node:child_process";

const OUT = "src/generated/products-index.json";

try {
  await access("data/products.json");
} catch {
  console.log("data/ missing, downloading challenge files first");
  execSync("node --env-file-if-exists=.env.local scripts/fetch-data.mjs", { stdio: "inherit" });
}

const products = JSON.parse(await readFile("data/products.json", "utf8"));

function csvMap(text) {
  const map = new Map();
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const [id, value] = line.split(",");
    const n = Number(value);
    if (id && Number.isFinite(n)) map.set(id.trim(), Math.round(n * 1000) / 1000);
  }
  return map;
}
const reliability = csvMap(await readFile("data/reliability.csv", "utf8"));
const carbon = csvMap(await readFile("data/carbon.csv", "utf8"));

const pick = (arr, lang) => (arr ?? []).find((v) => v.language === lang)?.value ?? null;
const classif = (s, name) => (s.classifications ?? []).find((c) => c.name === name)?.values ?? [];

const index = products
  .filter((p) => !p.deleted)
  .map((p) => {
    const s = p.synkkaData ?? {};
    const allergenValues = classif(s, "allergen");
    const freeFromValues = classif(s, "nonAllergen");
    const base = (s.unitConversions ?? []).find((u) => u.synkkaPackagingType === "BASE_UNIT_OR_EACH") ?? s.unitConversions?.[0];
    return {
      id: p.id,
      nameFi: pick(s.names, "fi"),
      nameEn: pick(s.names, "en"),
      nameSv: pick(s.names, "sv"),
      brand: s.brand ?? null,
      vendor: p.vendorName,
      category: p.category,
      salesUnit: p.salesUnit,
      baseUnit: p.baseUnit,
      units: (p.units ?? []).map((u) => ({ unit: u.unitId, baseUnits: u.sizeInBaseUnits })),
      lotSize: p.allowedLotSize,
      origin: p.countryOfOrigin ?? null,
      temperature: p.temperatureCondition ?? null,
      // Content of one base unit, when the data has it
      litresPerBaseUnit: base?.volume?.unit === "LTR" ? base.volume.value : null,
      kgPerBaseUnit: base?.netWeight?.unit === "GRM" ? base.netWeight.value / 1000 : base?.netWeight?.unit === "KGM" ? base.netWeight.value : null,
      // Allergens use GS1 codes (AM milk, AW gluten, AE egg, AN tree nuts, AP peanuts, ML lactose ...)
      allergenDataKnown: allergenValues.length > 0 || freeFromValues.length > 0,
      contains: allergenValues.filter((v) => v.unit === "CONTAINS").map((v) => v.id),
      mayContain: allergenValues.filter((v) => v.unit === "MAY_CONTAIN").map((v) => v.id),
      freeFrom: freeFromValues.map((v) => v.id),
      claims: classif(s, "nutritionalClaim").map((v) => v.id),
      labels: classif(s, "packagingMarkedLabel")
        .map((v) => v.id)
        .filter((id) => !/Temperature$/.test(id)),
      substitutes: (p.substitutions ?? []).map((x) => x.substituteProduct),
      deliveryReliability: reliability.get(p.id) ?? null,
      co2PerKg: carbon.get(p.id) ?? null,
    };
  });

await mkdir("src/generated", { recursive: true });
await writeFile(OUT, JSON.stringify(index));
const size = (JSON.stringify(index).length / 1e6).toFixed(1);
console.log(`${OUT}: ${index.length} products, ${size} MB`);
