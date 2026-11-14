// Which AI Gateway models can this Vercel team call? One tiny request per model. Prints the model and the outcome only.
//   node --env-file=.env.vercel scripts/try-models.mjs anthropic/claude-haiku-5.5 anthropic/claude-sonnet-5.5
import { generateText } from "ai";

for (const model of process.argv.slice(2)) {
  try {
    const { text, usage } = await generateText({ model, prompt: "Reply with the single word: ready", maxOutputTokens: 20 });
    console.log(`OK    ${model}: "${text.trim().slice(0, 30)}" (${usage?.totalTokens ?? "?"} tokens)`);
  } catch (e) {
    console.log(`FAIL  ${model}: ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, "[link]").slice(0, 140)}`);
  }
}
