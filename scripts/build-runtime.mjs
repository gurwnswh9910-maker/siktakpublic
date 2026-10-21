import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Compile once in the image build. A free web instance should spend its short
// scheduler budget processing jobs, not starting a TypeScript compiler.
await build({
  absWorkingDir: root,
  entryPoints: {
    batch: "src/worker/batch.ts",
    worker: "src/worker/index.ts",
    seed: "prisma/seed.ts",
  },
  outdir: ".runtime",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // Preserve Prisma native engine discovery; inline the rest so a throttled
  // instance does not traverse hundreds of npm modules for each short batch.
  external: ["@prisma/client", "highs"],
  tsconfig: "tsconfig.json",
  logLevel: "info",
});
