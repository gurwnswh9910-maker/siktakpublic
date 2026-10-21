import { defineConfig } from "vitest/config";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
try {
  loadEnvFile(".env");
} catch {}
const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!process.env.TEST_DATABASE_URL) url.pathname = "/siktak_test";
if (!url.pathname.endsWith("_test"))
  throw new Error("Tests require an isolated _test database");
process.env.DATABASE_URL = url.toString();
process.env.DEMO_MODE = "true";
process.env.MATCH_EVALUATOR = "balanced-v1";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
