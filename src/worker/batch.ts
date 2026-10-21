import { db } from "@/server/db";
import { tickDetailed } from "./runner";

const maxJobs = Math.min(20, Math.max(1, Number(process.argv[2]) || 20));
const budgetMs = Math.min(20000, Math.max(1, Number(process.argv[3]) || 20000));
const counts = {
  claimed: 0,
  processed: 0,
  succeeded: 0,
  retrying: 0,
  failed: 0,
  lost: 0,
};
function progress() {
  process.send?.({ type: "progress", counts });
}
// If the HTTP process dies, do not become an orphan worker.
const onParentDisconnect = () => process.exit(1);
process.once("disconnect", onParentDisconnect);
async function main() {
  // Parent time includes Node/module startup, which is significant on a small
  // free instance. Never restart the full work budget after importing modules.
  const parentDeadline = Number(process.argv[4]);
  const deadline = Math.min(
    Date.now() + budgetMs,
    Number.isFinite(parentDeadline) && parentDeadline > 0
      ? parentDeadline
      : Infinity,
  );
  let reason = "limit";
  for (let i = 0; i < maxJobs; i++) {
    if (Date.now() >= deadline) {
      reason = "deadline";
      break;
    }
    const result = await tickDetailed(() => {
      counts.claimed++;
      progress();
    });
    if (result.outcome === "empty") {
      reason = "empty";
      break;
    }
    counts.processed++;
    counts[result.outcome]++;
    progress();
  }
  await db.$disconnect();
  process.send?.({ type: "complete", reason, counts }, () => {
    process.off("disconnect", onParentDisconnect);
    process.disconnect?.();
  });
}
main().catch(async () => {
  // Error details stay in Job.lastError; HTTP reports only a generic failure.
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
