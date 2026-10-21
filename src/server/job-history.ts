import { z } from "zod";
import type { AuditLog } from "@prisma/client";

const attemptSchema = z.object({
  attemptId: z.uuid(),
  attempt: z.number().int().positive(),
  kind: z.enum([
    "PUSH",
    "MATCH",
    "WAITLIST",
    "REFUND",
    "REMINDER",
    "START",
    "END",
    "FEEDBACK_REMINDER",
    "UNKNOWN",
  ]),
  occurredAt: z.iso.datetime(),
  outcome: z.enum([
    "STARTED",
    "SUCCEEDED",
    "RETRYING",
    "FAILED",
    "INTERRUPTED",
  ]),
  reason: z
    .enum([
      "PUSH_UNCONFIGURED",
      "PUSH_DELIVERY_FAILED",
      "ATTEMPTS_EXHAUSTED",
      "RECORD_NOT_FOUND",
      "EXECUTION_FAILED",
      "LEASE_EXPIRED",
      "CLAIM_LOST",
    ])
    .optional(),
  result: z
    .enum([
      "SENT",
      "NOT_SUBSCRIBED",
      "EXPIRED",
      "ALREADY_SENT",
      "COMPLETED",
      "SKIPPED",
      "RECOVERED",
    ])
    .optional(),
  nextRunAt: z.iso.datetime().optional(),
});

export type JobAttemptHistoryEntry = z.infer<typeof attemptSchema> & {
  id: string;
};

// Explicit projection: historical arbitrary audit JSON and provider error text
// must never reach the job-history UI. Incomplete/malformed records are omitted.
export function projectJobHistory(
  jobId: string,
  audits: Pick<AuditLog, "id" | "objectId" | "action" | "after">[],
): JobAttemptHistoryEntry[] {
  return audits
    .flatMap((audit): JobAttemptHistoryEntry[] => {
      if (
        audit.objectId !== jobId ||
        !["JOB_ATTEMPT_STARTED", "JOB_ATTEMPT_FINISHED"].includes(audit.action)
      )
        return [];
      const parsed = attemptSchema.safeParse(audit.after);
      if (!parsed.success) return [];
      const entry = parsed.data;
      if (
        (entry.outcome === "STARTED") !==
        (audit.action === "JOB_ATTEMPT_STARTED")
      )
        return [];
      if (entry.outcome === "SUCCEEDED" && !entry.result) return [];
      if (
        ["FAILED", "RETRYING", "INTERRUPTED"].includes(entry.outcome) &&
        !entry.reason
      )
        return [];
      if (entry.outcome === "RETRYING" && !entry.nextRunAt) return [];
      return [{ id: audit.id, ...entry }];
    })
    .sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        (a.outcome === "STARTED" ? 0 : 1) - (b.outcome === "STARTED" ? 0 : 1),
    );
}
