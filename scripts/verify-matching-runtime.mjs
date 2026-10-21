import { createRequire } from "node:module";
import { resolve } from "node:path";
import { access } from "node:fs/promises";

// Require the built package by absolute path, so a missing package manifest
// cannot be hidden by falling back to the source tree's node_modules.
const packagePath = resolve(
  process.env.SIKTAK_BUILD_DIR ?? ".next",
  "standalone/node_modules/highs",
);
await access(`${packagePath}/package.json`);
await access(`${packagePath}/build/highs.wasm`);
const loadHighs = createRequire(import.meta.url)(packagePath);
const highs = await loadHighs();
const result = highs.solve(
  "Maximize\n obj: x\nSubject To\n c: x <= 1\nBounds\n 0 <= x <= 1\nBinary\n x\nEnd",
  { output_flag: false },
);
if (result.Status !== "Optimal" || result.ObjectiveValue !== 1)
  throw new Error("Built matching solver did not return the proven optimum");
console.log(
  JSON.stringify({
    standaloneWasm: true,
    status: result.Status,
    objective: result.ObjectiveValue,
  }),
);
