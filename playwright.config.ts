import { defineConfig } from "@playwright/test";
import { loadEnvFile } from "node:process";
try {
  loadEnvFile(".env");
} catch {}
const database = new URL(
  process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL!,
);
if (!process.env.E2E_DATABASE_URL) database.pathname = "/siktak_browser_test";
if (!database.pathname.endsWith("_test"))
  throw new Error("Browser tests require a dedicated _test database");
process.env.DATABASE_URL = database.toString();
process.env.BETTER_AUTH_URL = "http://localhost:3100";
process.env.DEMO_MODE = "true";
process.env.MATCH_EVALUATOR = process.env.TEST_MATCH_EVALUATOR ?? "balanced-v1";
process.env.SIKTAK_BUILD_DIR = ".next-e2e";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  use: {
    baseURL: process.env.BETTER_AUTH_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://localhost:3100/login",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
