import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  domainTransactionLimits,
  jobControlTransactionLimits,
  type Tx,
} from "@/server/db";
import { runBoundedProcess } from "./bounded-process";
import { schedulerDb } from "./scheduler-db";
export { schedulerDb } from "./scheduler-db";

const workBudgetMs = 15000;
const controlPhaseMs =
  jobControlTransactionLimits.maxWait + jobControlTransactionLimits.timeout;
const schedulerControlLimits = { maxWait: 2000, timeout: 5000 };
const schedulerControlMs =
  schedulerControlLimits.maxWait + schedulerControlLimits.timeout;
const parentExitMarginMs = 3000;
// Reserve claim+settings, domain work, acknowledgement, error recording and
// an outstanding renewal, each with enforced DB bounds, then 5s for process exit.
const processBudgetMs =
  workBudgetMs +
  domainTransactionLimits.maxWait +
  domainTransactionLimits.timeout +
  4 * controlPhaseMs +
  5000;
export const schedulerLimits = {
  maxJobs: 20,
  budgetMs: workBudgetMs,
  hardTimeoutMs: processBudgetMs,
  // Acquire, initial heartbeat, renewal, final heartbeat, failure heartbeat and
  // release (including one bounded retry) reserve pool acquisition + transaction life.
  httpBudgetMs: processBudgetMs + 7 * schedulerControlMs + parentExitMarginMs,
};
const leaseMs = schedulerLimits.httpBudgetMs + 10000;
export type BatchCounts = {
  claimed: number;
  processed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  lost: number;
};

export function schedulerAuthorization(header: string | null) {
  const secret = process.env.SCHEDULER_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) return "unconfigured";
  const candidate = /^Bearer (\S+)$/i.exec(header ?? "")?.[1] ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(secret))
    ? "authorized"
    : "unauthorized";
}

// Control-plane reads/writes cannot wait indefinitely behind database locks.
// Prisma bounds pool acquisition + transaction life; PostgreSQL also cancels
// the statement itself instead of merely abandoning a JavaScript Promise.
async function control<T>(phase: string, fn: (tx: Tx) => Promise<T>) {
  const startedAt = Date.now();
  try {
    return await schedulerDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '1500ms'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
      return fn(tx);
    }, schedulerControlLimits);
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^P\d{4}$/.test(error.code)
        ? error.code
        : "UNKNOWN";
    // Never log query text, parameters, credentials or the driver's message.
    console.error("scheduler_control_failed", {
      phase,
      code,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function runScheduledBatch(signal?: AbortSignal) {
  const deadline = Date.now() + schedulerLimits.httpBudgetMs;
  const token = randomUUID();
  const acquired = await control(
    "acquire",
    (tx) => tx.$executeRaw`
    INSERT INTO "Setting" (key, value)
    VALUES ('schedulerLease', jsonb_build_object('token', ${token}::text,
      'expiresAt', EXTRACT(EPOCH FROM NOW()) * 1000 + ${leaseMs}))
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
    WHERE ("Setting".value->>'expiresAt')::numeric < EXTRACT(EPOCH FROM NOW()) * 1000`,
  );
  if (!acquired) return { busy: true as const };
  const startedAt = new Date().toISOString();
  let counts: BatchCounts = {
    claimed: 0,
    processed: 0,
    succeeded: 0,
    retrying: 0,
    failed: 0,
    lost: 0,
  };
  let reason: string | undefined;
  let status = "FAILED";
  async function heartbeat(finished: boolean) {
    const at = new Date().toISOString();
    const value = {
      mode: "scheduler",
      status,
      at,
      startedAt,
      finishedAt: finished ? at : null,
      ...counts,
      interrupted: counts.claimed - counts.processed,
      reason: reason ?? null,
    };
    await control(
      finished ? "final-heartbeat" : "initial-heartbeat",
      (tx) => tx.$executeRaw`
      INSERT INTO "Setting" (key, value)
      SELECT 'schedulerHeartbeat', ${JSON.stringify(value)}::jsonb
      WHERE EXISTS (SELECT 1 FROM "Setting" WHERE key='schedulerLease' AND value->>'token'=${token})
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    );
  }
  try {
    status = "RUNNING";
    await heartbeat(false);
    // Renew immediately before spawning: a slow DB heartbeat must not consume
    // the child process's lease, and an old owner must never start new work.
    const renewed = await control(
      "renew",
      (tx) => tx.$executeRaw`
      UPDATE "Setting" SET value=jsonb_set(value, '{expiresAt}', to_jsonb(EXTRACT(EPOCH FROM NOW()) * 1000 + ${leaseMs}))
      WHERE key='schedulerLease' AND value->>'token'=${token}
        AND (value->>'expiresAt')::numeric > EXTRACT(EPOCH FROM NOW()) * 1000`,
    );
    if (!renewed) return { busy: true as const };
    const root = process.env.SIKTAK_APP_ROOT || process.cwd();
    // Reserve final heartbeat, its failure recovery, two release attempts and exit.
    const timeoutMs = Math.max(
      1,
      Math.min(
        schedulerLimits.hardTimeoutMs,
        deadline - Date.now() - 4 * schedulerControlMs - parentExitMarginMs,
      ),
    );
    // A normal 155-second invocation reserves every database phase of the last
    // job, including acknowledgement and recovery. Startup is included.
    // Shortened HTTP budgets stop new work earlier to leave cleanup time.
    const workBudgetMs = Math.max(
      0,
      Math.min(schedulerLimits.budgetMs, timeoutMs - 5000),
    );
    const workDeadline = Date.now() + workBudgetMs;
    const bundledEntry = resolve(root, ".runtime/batch.cjs");
    const entryArgs =
      process.env.NODE_ENV === "production" && existsSync(bundledEntry)
        ? [bundledEntry]
        : ["--import", "tsx", resolve(root, "src/worker/batch.ts")];
    const result = await runBoundedProcess(
      [
        ...entryArgs,
        String(schedulerLimits.maxJobs),
        String(Math.max(1, workBudgetMs)),
        String(workDeadline),
      ],
      {
        cwd: root,
        timeoutMs,
        signal,
        onMessage(message) {
          const data = message as {
            type?: string;
            counts?: BatchCounts;
            reason?: string;
          };
          if (
            (data?.type === "progress" || data?.type === "complete") &&
            data.counts
          )
            counts = data.counts;
          if (data?.type === "complete") reason = data.reason;
        },
      },
    );
    status = result.aborted
      ? "INTERRUPTED"
      : result.timedOut
        ? "DEADLINE"
        : result.exitCode === 0 && reason
          ? "COMPLETED"
          : "FAILED";
    if (result.timedOut) reason = "deadline";
    await heartbeat(true);
    return {
      busy: false as const,
      status,
      reason: reason ?? null,
      ...counts,
      interrupted: counts.claimed - counts.processed,
    };
  } catch {
    status = "FAILED";
    await heartbeat(true).catch(() => {});
    throw new Error("예약 작업 실행에 실패했습니다.");
  } finally {
    // Token-conditional deletion is idempotent, even if a transaction committed
    // before its acknowledgement was lost. Never retry the batch or lease acquire.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await control(
          attempt === 0 ? "release" : "release-retry",
          (tx) =>
            tx.$executeRaw`DELETE FROM "Setting" WHERE key='schedulerLease' AND value->>'token'=${token}`,
        );
        break;
      } catch (error) {
        const retryable =
          error instanceof Error && "code" in error && error.code === "P2028";
        if (
          attempt > 0 ||
          !retryable ||
          deadline - Date.now() < schedulerControlMs + parentExitMarginMs
        )
          throw error;
      }
    }
  }
}
