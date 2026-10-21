import webpush from "web-push";
import { randomUUID } from "node:crypto";
import {
  db,
  atomic,
  jobControlTransactionLimits,
  jobControlTransaction,
  type Tx,
} from "@/server/db";
import { advanceWaitlist, expireEventWaitlist } from "@/server/waitlist";
import { runMatch } from "@/server/match-run";
import { notify } from "@/server/jobs";
import { syncMeetingHistory } from "@/server/attendance";
import { sendTableContent } from "@/server/content-catalog";
import { completeMockRefund } from "@/server/refunds";
import { reminderNotice } from "@/server/notification-content";
import { buildPushPayload } from "@/server/push-payload";
import type { JobAttemptHistoryEntry } from "@/server/job-history";
import type { Job } from "@prisma/client";

type ExecutionResult = NonNullable<JobAttemptHistoryEntry["result"]>;
type AttemptOutcome = JobAttemptHistoryEntry["outcome"];
const failureMessages = {
  PUSH_UNCONFIGURED: "푸시 발송 키가 설정되지 않았습니다.",
  PUSH_DELIVERY_FAILED: "일부 푸시 구독 전송 실패",
  ATTEMPTS_EXHAUSTED: "중단된 작업이 최대 실행 횟수를 초과했습니다.",
  RECORD_NOT_FOUND: "작업 대상 기록을 찾을 수 없습니다.",
  EXECUTION_FAILED: "작업 실행에 실패했습니다. 대상과 설정을 확인해 주세요.",
} as const;
type FailureReason = keyof typeof failureMessages;
class JobFailure extends Error {
  constructor(public reason: FailureReason) {
    super(failureMessages[reason]);
  }
}
function failureReason(error: unknown): FailureReason {
  if (error instanceof JobFailure) return error.reason;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2025"
  )
    return "RECORD_NOT_FOUND";
  // Provider/Prisma errors may contain credentials, URLs or message bodies.
  // Only fixed codes and descriptions are retained in job and audit history.
  return "EXECUTION_FAILED";
}
function safeJobKind(kind: string) {
  return [
    "PUSH",
    "MATCH",
    "WAITLIST",
    "REFUND",
    "REMINDER",
    "START",
    "END",
    "FEEDBACK_REMINDER",
  ].includes(kind)
    ? kind
    : "UNKNOWN";
}
async function recordAttempt(
  tx: Pick<Tx, "auditLog">,
  job: Pick<Job, "id" | "kind" | "attempts">,
  attemptId: string,
  outcome: AttemptOutcome,
  detail: {
    reason?: JobAttemptHistoryEntry["reason"];
    result?: ExecutionResult;
    nextRunAt?: Date;
  } = {},
  occurredAt = new Date(),
) {
  const started = outcome === "STARTED";
  // One immutable start and terminal event per claim. An old worker returning
  // after recovery cannot overwrite the recorded lease expiration or success.
  const id = `job-attempt:${attemptId}:${started ? "started" : "finished"}`;
  await tx.auditLog.createMany({
    data: {
      id,
      actorId: "worker",
      objectId: job.id,
      action: started ? "JOB_ATTEMPT_STARTED" : "JOB_ATTEMPT_FINISHED",
      after: {
        attemptId,
        attempt: job.attempts,
        kind: safeJobKind(job.kind),
        occurredAt: occurredAt.toISOString(),
        outcome,
        ...(detail.reason ? { reason: detail.reason } : {}),
        ...(detail.result ? { result: detail.result } : {}),
        ...(detail.nextRunAt
          ? { nextRunAt: detail.nextRunAt.toISOString() }
          : {}),
      },
    },
    skipDuplicates: true,
  });
}

export async function execute(
  job: Job,
  assertClaim: (tx?: Tx) => Promise<void> = async () => {},
): Promise<ExecutionResult> {
  // Database-only work checks ownership inside its bounded domain transaction.
  // PUSH also checks before its external-provider reads and sends.
  if (job.kind === "PUSH") await assertClaim();
  const payload = job.payload as Record<string, string>;
  if (job.kind === "PUSH") {
    const n = await db.notification.findUniqueOrThrow({
      where: { id: payload.notificationId },
    });
    if (n.pushStatus === "SENT") return "ALREADY_SENT";
    if (n.pushStatus === "EXPIRED") return "EXPIRED";
    const offerKey = /^waitlist-offer:([^:]+):(.+)$/.exec(n.key);
    const expirePush = async () => {
      await atomic(async (tx) => {
        await assertClaim(tx);
        await tx.notification.update({
          where: { id: n.id },
          data: { pushStatus: "EXPIRED" },
        });
      });
      return "EXPIRED" as const;
    };
    const offerTtl = async () => {
      if (!offerKey) return 86400;
      const entry = await db.waitlistEntry.findUnique({
        where: { id: offerKey[1] },
        include: {
          event: true,
          application: { include: { user: { include: { profile: true } } } },
        },
      });
      const now = Date.now();
      if (
        !entry ||
        entry.status !== "OFFERED" ||
        !entry.expiresAt ||
        entry.expiresAt.toISOString() !== offerKey[2] ||
        entry.expiresAt.getTime() <= now ||
        !entry.tableId ||
        !["OPEN", "MATCHED"].includes(entry.event.status) ||
        entry.event.startsAt.getTime() <= now ||
        entry.application.userId !== n.userId ||
        entry.application.applicationStatus !== "SUBMITTED" ||
        !["PAID", "REFUND_AVAILABLE"].includes(
          entry.application.paymentStatus,
        ) ||
        entry.application.attendanceStatus !== "SCHEDULED" ||
        entry.application.matchStatus === "CONFIRMED" ||
        entry.application.tableId ||
        entry.application.resolution ||
        !["NONE", "WARNING"].includes(entry.application.user.restriction) ||
        !entry.application.user.profile?.consentAt
      )
        return 0;
      const table = await db.diningTable.findUnique({
        where: { id: entry.tableId },
        select: { status: true, eventId: true },
      });
      if (
        !table ||
        table.eventId !== entry.eventId ||
        !["CONFIRMED", "WAITLIST_PENDING"].includes(table.status)
      )
        return 0;
      // A provider must not retain an offer beyond its response deadline.
      return Math.max(
        0,
        Math.min(
          86400,
          Math.floor(
            (Math.min(
              entry.expiresAt.getTime(),
              entry.event.startsAt.getTime(),
            ) -
              Date.now()) /
              1000,
          ),
        ),
      );
    };
    if (offerKey && !(await offerTtl())) return expirePush();
    // Also expire a reminder that was queued before sleep but not delivered.
    const noticeTable = /^(?:reminder|confirmed):([^:]+):/.exec(n.key)?.[1];
    const tableNoticeCurrent = async (client: Pick<Tx, "diningTable"> = db) => {
      if (!noticeTable) return true;
      const table = await client.diningTable.findUnique({
        where: { id: noticeTable },
        include: { event: true },
      });
      return (
        !!table &&
        table.status === "CONFIRMED" &&
        table.event.status !== "CANCELED" &&
        (!n.key.startsWith("reminder:") ||
          table.event.startsAt.getTime() > Date.now())
      );
    };
    if (!(await tableNoticeCurrent())) return expirePush();
    const subscriptions = await db.pushSubscription.findMany({
      where: { userId: n.userId },
    });
    if (!subscriptions.length) {
      await atomic(async (tx) => {
        await assertClaim(tx);
        await tx.notification.update({
          where: { id: n.id },
          data: {
            pushStatus: "NOT_SUBSCRIBED",
          },
        });
      });
      return "NOT_SUBSCRIBED";
    }
    if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) {
      await atomic(async (tx) => {
        await assertClaim(tx);
        await tx.notification.update({
          where: { id: n.id },
          data: { pushStatus: "UNCONFIGURED" },
        });
      });
      throw new JobFailure("PUSH_UNCONFIGURED");
    }
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? "mailto:demo@example.com",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    let failed = false,
      delivered = 0;
    for (const s of subscriptions) {
      await assertClaim();
      // Recheck every device: a participant can respond while another push is sent.
      const ttl = await offerTtl();
      if (!ttl) return expirePush();
      if (!(await tableNoticeCurrent())) return expirePush();
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          buildPushPayload(n),
          { TTL: ttl, timeout: 10000 },
        );
        delivered++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404)
          await atomic(async (tx) => {
            await assertClaim(tx);
            await tx.pushSubscription.deleteMany({ where: { id: s.id } });
          });
        else failed = true;
      }
    }
    await assertClaim();
    if (failed) throw new JobFailure("PUSH_DELIVERY_FAILED");
    const currentDelivery = await atomic(async (tx) => {
      await assertClaim(tx);
      const sent = delivered > 0 && (await tableNoticeCurrent(tx));
      const updated = await tx.notification.updateMany({
        where: { id: n.id, pushStatus: { not: "EXPIRED" } },
        data: { pushStatus: sent ? "SENT" : "EXPIRED" },
      });
      return sent && updated.count === 1;
    });
    return currentDelivery ? "SENT" : "EXPIRED";
  }
  return atomic(async (tx) => {
    await assertClaim(tx);
    if (job.kind === "WAITLIST") {
      if (payload.tableId) await advanceWaitlist(tx, payload.tableId);
      if (payload.eventId) await expireEventWaitlist(tx, payload.eventId);
      return "COMPLETED";
    }
    if (job.kind === "MATCH") {
      await runMatch(tx, payload.eventId);
      return "COMPLETED";
    }
    if (job.kind === "REFUND") {
      await completeMockRefund(tx, payload.refundId);
      return "COMPLETED";
    }
    const t = await tx.diningTable.findUnique({
      where: { id: payload.tableId },
      include: {
        event: true,
        venueSlot: true,
        room: true,
        applications: {
          where: { applicationStatus: "SUBMITTED", matchStatus: "CONFIRMED" },
          include: { user: { include: { profile: true } }, feedback: true },
        },
      },
    });
    if (
      !t ||
      t.status !== "CONFIRMED" ||
      !t.room ||
      t.event.status === "CANCELED"
    )
      return "SKIPPED";
    // A scheduler can wake long after a free web service has gone to sleep.
    // Keep useful end/feedback recovery, but never announce a past meeting.
    const now = Date.now();
    if (job.kind === "REMINDER" && t.event.startsAt.getTime() <= now)
      return "SKIPPED";
    if (job.kind === "START" && t.event.endsAt.getTime() <= now)
      return "SKIPPED";
    if (["START", "REMINDER", "END"].includes(job.kind))
      await sendTableContent(tx, job);
    if (job.kind === "START") {
      // Scheduled content was sent from its immutable snapshot above.
    } else if (job.kind === "REMINDER") {
      const body = await reminderNotice(tx, t);
      await tx.message.upsert({
        where: { key: `reminder:${t.id}` },
        create: {
          roomId: t.room.id,
          kind: "SYSTEM",
          key: `reminder:${t.id}`,
          body,
        },
        update: {},
      });
      for (const a of t.applications)
        await notify(
          tx,
          a.userId,
          `reminder:${t.id}:${a.id}`,
          "우리 곧 만나요",
          body,
          `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
        );
    } else if (job.kind === "END") {
      await tx.application.updateMany({
        where: {
          tableId: t.id,
          applicationStatus: "SUBMITTED",
          attendanceStatus: "SCHEDULED",
        },
        data: { attendanceReviewRequired: true },
      });
      for (const a of t.applications) {
        await notify(
          tx,
          a.userId,
          `feedback:${a.id}`,
          "오늘의 식탁은 어땠나요?",
          "체크인을 확인하고 비공개 피드백을 남겨 주세요. 다음 만남에 반영할게요.",
          `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
        );
      }
      await syncMeetingHistory(tx, t.id);
    } else if (job.kind === "FEEDBACK_REMINDER") {
      for (const a of t.applications.filter(
        (x) => x.attendanceStatus === "ATTENDED" && !x.feedback,
      ))
        await notify(
          tx,
          a.userId,
          `feedback-once:${a.id}`,
          "짧은 피드백을 기다리고 있어요",
          "다음 만남을 준비하는 데 도움이 돼요. 피드백 없이도 다음 일정을 신청할 수 있어요.",
          `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
        );
    } else return "SKIPPED";
    return "COMPLETED";
  });
}
class LostClaim extends Error {}
const leaseMs = 5 * 60 * 1000;
export type TickResult = {
  outcome: "empty" | "succeeded" | "retrying" | "failed" | "lost";
};
export async function tickDetailed(onClaim?: () => void): Promise<TickResult> {
  const token = randomUUID();
  type RetryConfig = { retrySeconds?: number; maxAttempts?: number };
  const claimedJob = await jobControlTransaction(async (tx) => {
    const [claimed] = await tx.$queryRaw<
      (Job & {
        previousClaimToken: string | null;
        previousAttempts: number;
      })[]
    >`
      WITH candidate AS (
        SELECT id, "claimToken" AS "previousClaimToken", attempts AS "previousAttempts"
        FROM "Job" WHERE (status='PENDING' AND "runAt"<=NOW())
          OR (status='RUNNING' AND "lockedAt"<NOW()-INTERVAL '5 minutes')
        ORDER BY "runAt" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "Job" j SET status='RUNNING', "lockedAt"=NOW(),
        "claimToken"=${token}, attempts=j.attempts+1
      FROM candidate c WHERE j.id=c.id
      RETURNING j.*, c."previousClaimToken", c."previousAttempts"`;
    if (!claimed) return null;
    if (claimed.previousClaimToken)
      await recordAttempt(
        tx,
        { ...claimed, attempts: claimed.previousAttempts },
        claimed.previousClaimToken,
        "INTERRUPTED",
        { reason: "LEASE_EXPIRED" },
      );
    await recordAttempt(tx, claimed, token, "STARTED", {}, claimed.lockedAt!);
    const setting = await tx.setting.findUnique({
      where: { key: "automation" },
    });
    return { job: claimed, config: setting?.value as RetryConfig | null };
  });
  if (!claimedJob) return { outcome: "empty" };
  const { job, config } = claimedJob;
  onClaim?.();
  let outcome: TickResult["outcome"] = "succeeded";
  const ownership = () => ({
    id: job.id,
    claimToken: token,
    status: "RUNNING",
    lockedAt: { gt: new Date(Date.now() - leaseMs) },
  });
  let lost = false;
  let renewing: Promise<void> | undefined;
  const renewal = setInterval(() => {
    if (renewing || lost) return;
    renewing = jobControlTransaction((tx) =>
      tx.job.updateMany({
        where: ownership(),
        data: { lockedAt: new Date() },
      }),
    )
      .then(({ count }) => {
        if (count !== 1) lost = true;
      })
      .catch(() => {
        lost = true;
      })
      .finally(() => {
        renewing = undefined;
      });
  }, 60000);
  renewal.unref();
  async function assertClaim(tx?: Tx) {
    if (lost) throw new LostClaim("작업 실행 권한이 만료되었습니다.");
    // Lock the claim for the same transaction as domain writes. A reclaimed
    // worker cannot commit side effects or continue to the next push recipient.
    const rows = await (tx ?? db).$queryRaw<{ id: string }[]>`
      SELECT id FROM "Job" WHERE id=${job.id} AND "claimToken"=${token}
        AND status='RUNNING' AND "lockedAt">NOW()-INTERVAL '5 minutes' FOR UPDATE`;
    if (!rows.length) {
      lost = true;
      throw new LostClaim("작업 실행 권한이 변경되었습니다.");
    }
  }
  try {
    // A killed process never enters catch. Enforce the retry ceiling when its
    // stale claim is recovered too, before any domain writes or push delivery.
    if (job.attempts > (config?.maxAttempts ?? 3))
      throw new JobFailure("ATTEMPTS_EXHAUSTED");
    const result = await execute(job, assertClaim);
    await jobControlTransaction(async (tx) => {
      const completed = await tx.job.updateMany({
        where: ownership(),
        data: {
          status: "DONE",
          completedAt: new Date(),
          lockedAt: null,
          claimToken: null,
          lastError: null,
        },
      });
      if (completed.count !== 1) outcome = "lost";
      await recordAttempt(
        tx,
        job,
        token,
        completed.count ? "SUCCEEDED" : "INTERRUPTED",
        completed.count ? { result } : { reason: "CLAIM_LOST" },
      );
    });
  } catch (e) {
    if (e instanceof LostClaim || lost) {
      await jobControlTransaction((tx) =>
        recordAttempt(tx, job, token, "INTERRUPTED", {
          reason: "CLAIM_LOST",
        }),
      );
      return { outcome: "lost" };
    }
    const reason = failureReason(e);
    const failed = job.attempts >= (config?.maxAttempts ?? 3);
    outcome = failed ? "failed" : "retrying";
    await atomic(async (tx) => {
      // The refund transaction may have committed before a process was killed
      // while acknowledging its Job. Never downgrade that terminal result when
      // a stale claim has exhausted its retry allowance.
      if (job.kind === "REFUND") {
        const payload = job.payload as { refundId: string };
        const refund = await tx.refund.findUnique({
          where: { id: payload.refundId },
          select: { status: true },
        });
        if (refund?.status === "REFUNDED") {
          const completed = await tx.job.updateMany({
            where: ownership(),
            data: {
              status: "DONE",
              completedAt: new Date(),
              lockedAt: null,
              claimToken: null,
              lastError: null,
            },
          });
          outcome = completed.count ? "succeeded" : "lost";
          await recordAttempt(
            tx,
            job,
            token,
            completed.count ? "SUCCEEDED" : "INTERRUPTED",
            completed.count
              ? { result: "RECOVERED" }
              : { reason: "CLAIM_LOST" },
          );
          return;
        }
      }
      const nextRunAt = new Date(
        Date.now() +
          (config?.retrySeconds ?? 30) * 1000 * 2 ** (job.attempts - 1),
      );
      const updated = await tx.job.updateMany({
        where: ownership(),
        data: {
          status: failed ? "FAILED" : "PENDING",
          lockedAt: null,
          claimToken: null,
          lastError: failureMessages[reason],
          runAt: nextRunAt,
        },
      });
      if (!updated.count) {
        outcome = "lost";
        await recordAttempt(tx, job, token, "INTERRUPTED", {
          reason: "CLAIM_LOST",
        });
        return;
      }
      await recordAttempt(tx, job, token, failed ? "FAILED" : "RETRYING", {
        reason,
        ...(failed ? {} : { nextRunAt }),
      });
      if (failed) {
        await tx.exceptionCase.upsert({
          where: { key: `job:${job.id}` },
          create: {
            key: `job:${job.id}`,
            kind: "JOB",
            objectId: job.id,
            reason: `${safeJobKind(job.kind)} 작업이 반복 실패했습니다.`,
          },
          update: { status: "OPEN" },
        });
        if (job.kind === "REFUND") {
          const p = job.payload as { refundId: string };
          const r = await tx.refund.update({
            where: { id: p.refundId },
            data: { status: "REFUND_FAILED" },
            include: { payment: true },
          });
          await tx.application.update({
            where: { id: r.payment.applicationId },
            data: { paymentStatus: "REFUND_FAILED" },
          });
        }
      }
    }, jobControlTransactionLimits);
  } finally {
    clearInterval(renewal);
    await renewing;
  }
  return { outcome };
}

// Keep the continuous worker and existing callers compatible.
export async function tick() {
  return (await tickDetailed()).outcome !== "empty";
}
