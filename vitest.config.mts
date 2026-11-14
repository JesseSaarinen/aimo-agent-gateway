import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    // Tests always run on the fixtures in src/lib/valio-fake.ts, never on the live Valio API.
    env: { VALIO_FAKE: "1" },
  },
});
