import { spawn, execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Refusing to reset a non-test database");
execFileSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  { stdio: "inherit" },
);
const db = new PrismaClient();
await db.$executeRawUnsafe(
  'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
);
await db.$disconnect();
execFileSync(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"],
  { stdio: "inherit" },
);
const children = [
  spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--port", "3100"],
    { stdio: "inherit" },
  ),
  spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/worker/index.ts"],
    { stdio: "inherit" },
  ),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
for (const child of children) child.on("exit", stop);
