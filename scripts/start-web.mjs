import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Free web instances have no pre-deploy command. Complete setup before serving.
const root = fileURLToPath(new URL("../", import.meta.url));
process.env.SIKTAK_APP_ROOT = root;
if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET)
  throw new Error("DATABASE_URL and BETTER_AUTH_SECRET are required");
if (!process.env.BETTER_AUTH_URL && !process.env.RENDER_EXTERNAL_URL)
  throw new Error("Set the public authentication origin before starting");
if (
  process.env.AUTOMATION_MODE === "scheduler" &&
  (!process.env.SCHEDULER_SECRET || process.env.SCHEDULER_SECRET.length < 32)
)
  throw new Error("Scheduler mode requires a secret of at least 32 characters");
// One-container mode: the queue worker runs next to the web server, so no
// external cron is needed. Jobs wait while a free instance sleeps and resume
// as soon as any request wakes it.
const embeddedWorker =
  process.env.AUTOMATION_MODE !== "scheduler" &&
  process.env.SIKTAK_EMBEDDED_WORKER === "true";

let active;
let worker;
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    active?.kill(signal);
    worker?.kill(signal);
  });

async function run(args) {
  if (stopping) throw new Error("Startup interrupted");
  await new Promise((resolve, reject) => {
    active = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
    active.once("error", reject);
    active.once("exit", (code, signal) => {
      active = undefined;
      if (code === 0 || stopping) resolve();
      else reject(new Error(`Application process exited: ${code ?? signal}`));
    });
  });
}

function startWorker() {
  if (stopping) return;
  const compiled = fileURLToPath(
    new URL("../.runtime/worker.cjs", import.meta.url),
  );
  worker = spawn(
    process.execPath,
    existsSync(compiled) ? [compiled] : ["--import", "tsx", "src/worker/index.ts"],
    { cwd: root, stdio: "inherit" },
  );
  worker.once("exit", (code, signal) => {
    worker = undefined;
    if (stopping) return;
    console.error(`Embedded worker exited: ${code ?? signal}; restarting in 5s`);
    setTimeout(startWorker, 5000);
  });
}

try {
  await run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  if (process.env.DEMO_SEED_ON_START === "true") {
    const compiledSeed = fileURLToPath(
      new URL("../.runtime/seed.cjs", import.meta.url),
    );
    await run(
      existsSync(compiledSeed)
        ? [compiledSeed]
        : ["--import", "tsx", "prisma/seed.ts"],
    );
  }
  if (embeddedWorker) startWorker();
  await run([".next/standalone/server.js"]);
} catch (error) {
  if (!stopping) {
    console.error(error instanceof Error ? error.message : "Startup failed");
    process.exitCode = 1;
  }
}
stopping = true;
worker?.kill("SIGTERM");
