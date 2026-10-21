import { createHash } from "node:crypto";
import { atomic, audit, ensure, type Tx } from "./db";
import { availableTicketLots } from "@/domain/ticket-lots";
import {
  PRIVACY_POLICY_VERSION,
  WITHDRAWN_RESTRICTION,
  privacyPolicy,
} from "@/domain/privacy-policy";

const completedAction = "PRIVACY_SYNTHETIC_ACCOUNT_CLOSED";
const syntheticId = /^privacy-test-[a-z0-9-]{8,80}$/;
const anonymizedEmail = (userId: string) => `${userId}@withdrawn.invalid`;

type Request = {
  actorId: string;
  userId: string;
  execute?: boolean;
  expectedFingerprint?: string;
  confirmation?: string;
  identityConfirmed?: boolean;
  caseReference?: string;
};

async function inspect(tx: Tx, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: {
      profile: true,
      sessions: { select: { id: true }, orderBy: { id: "asc" } },
      accounts: {
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      },
      applications: {
        include: {
          payments: { include: { refunds: true }, orderBy: { id: "asc" } },
          waitlist: true,
          table: { select: { id: true, status: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  });
  ensure(user, "대상 계정이 없습니다.", 404);
  ensure(
    syntheticId.test(user.id) &&
      user.role === "PARTICIPANT" &&
      (user.email === `${user.id}@example.test` ||
        (user.restriction === WITHDRAWN_RESTRICTION &&
          user.email === anonymizedEmail(user.id))),
    "지정 형식의 합성 참가자 계정만 처리할 수 있습니다.",
    403,
  );
  const [
    subscriptions,
    notifications,
    ledger,
    reports,
    relations,
    messages,
    feedback,
    prior,
  ] = await Promise.all([
    tx.pushSubscription.findMany({
      where: { userId },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
    tx.notification.findMany({
      where: { userId },
      select: { id: true, pushStatus: true },
      orderBy: { id: "asc" },
    }),
    tx.ticketEntry.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    tx.safetyReport.count({
      where: { OR: [{ reporterId: userId }, { targetId: userId }] },
    }),
    tx.relationship.count({
      where: { OR: [{ fromId: userId }, { toId: userId }] },
    }),
    tx.message.count({ where: { userId } }),
    tx.feedback.count({ where: { application: { userId } } }),
    tx.auditLog.findFirst({
      where: { objectId: userId, action: completedAction },
      select: { id: true },
    }),
  ]);
  const notificationIds = notifications.map((n) => n.id);
  const pushJobs = notificationIds.length
    ? await tx.job.findMany({
        where: {
          kind: "PUSH",
          OR: notificationIds.map((notificationId) => ({
            payload: { path: ["notificationId"], equals: notificationId },
          })),
        },
        select: { id: true, status: true, claimToken: true },
        orderBy: { id: "asc" },
      })
    : [];
  const blockers: { code: string; count: number; action: string }[] = [];
  const add = (code: string, count: number, action: string) => {
    if (count) blockers.push({ code, count, action });
  };
  add(
    "ACTIVE_APPLICATION",
    user.applications.filter(
      (a) =>
        a.applicationStatus === "SUBMITTED" &&
        a.attendanceStatus === "SCHEDULED",
    ).length,
    "진행 신청을 기존 취소·미매칭 해결 절차로 완료한 뒤 다시 확인합니다.",
  );
  add(
    "ACTIVE_WAITLIST",
    user.applications.filter(
      (a) => a.waitlist && ["WAITING", "OFFERED"].includes(a.waitlist.status),
    ).length,
    "대기 등록·자리 제안을 먼저 철회합니다.",
  );
  add(
    "TABLE_HOLD",
    user.applications.filter((a) => a.table?.status === "WAITLIST_PENDING")
      .length,
    "미달 테이블의 자리 보류를 운영 절차로 해소합니다.",
  );
  add(
    "UNSETTLED_REFUND",
    user.applications.filter(
      (a) =>
        (a.paymentStatus === "REFUND_AVAILABLE" && a.resolution !== "KEEP") ||
        ["REFUND_REQUESTED", "REFUND_PROCESSING", "REFUND_FAILED"].includes(
          a.paymentStatus,
        ) ||
        a.payments.some((p) => p.refunds.some((r) => r.status !== "REFUNDED")),
    ).length,
    "환불·보관 선택과 미정산 거래 처리를 먼저 완료합니다.",
  );
  add(
    "TICKET_BALANCE",
    availableTicketLots(ledger).reduce((n, lot) => n + lot.units, 0),
    "남은 이용권의 처리 의사를 확인해 기존 절차로 정리합니다. 자동 소멸시키지 않습니다.",
  );
  add(
    "PUSH_IN_FLIGHT",
    pushJobs.filter((j) => j.status === "RUNNING").length,
    "진행 중인 푸시 전송이 끝난 뒤 재조회합니다. 이미 전송된 알림은 회수할 수 없습니다.",
  );
  const removed = {
    sessions: user.sessions.length,
    credentials: user.accounts.length,
    pushSubscriptions: subscriptions.length,
    profiles: user.profile ? 1 : 0,
    notificationBodies: notifications.length,
    pendingPushJobs: pushJobs.filter((j) =>
      ["PENDING", "FAILED"].includes(j.status),
    ).length,
  };
  const retained = {
    accountIdentifiers: 1,
    applications: user.applications.length,
    payments: user.applications.reduce((n, a) => n + a.payments.length, 0),
    refunds: user.applications.reduce(
      (n, a) => n + a.payments.reduce((m, p) => m + p.refunds.length, 0),
      0,
    ),
    ticketEntries: ledger.length,
    safetyReports: reports,
    relationships: relations,
    authoredMessages: messages,
    feedback,
    linkedTables: new Set(
      user.applications.flatMap((a) => (a.tableId ? [a.tableId] : [])),
    ).size,
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        policy: PRIVACY_POLICY_VERSION,
        user: {
          id: user.id,
          email: user.email,
          updatedAt: user.updatedAt,
          restriction: user.restriction,
        },
        profile: user.profile?.updatedAt,
        sessions: user.sessions,
        accounts: user.accounts,
        applications: user.applications,
        subscriptions,
        notifications,
        ledger,
        pushJobs,
        retained,
        blockers,
      }),
    )
    .digest("hex");
  const completed =
    user.restriction === WITHDRAWN_RESTRICTION &&
    user.email === anonymizedEmail(userId) &&
    !!prior &&
    !user.profile &&
    !user.sessions.length &&
    !user.accounts.length &&
    !subscriptions.length;
  return {
    user,
    pushJobs,
    plan: {
      policyVersion: PRIVACY_POLICY_VERSION,
      userId,
      fingerprint,
      eligible: blockers.length === 0,
      completed,
      blockers,
      removed,
      retained,
      retentionPolicy: privacyPolicy.retention,
    },
  };
}

/** Administrative demonstration procedure. No public route exposes this function. */
export async function processSyntheticPrivacyRequest(request: Request) {
  ensure(
    process.env.DEMO_MODE === "true",
    "시연 모드에서만 사용할 수 있습니다.",
    403,
  );
  return atomic(async (tx) => {
    const actor = await tx.user.findUnique({ where: { id: request.actorId } });
    ensure(
      actor?.role === "ADMIN" &&
        ["NONE", "WARNING"].includes(actor.restriction),
      "활성 전체 관리자 권한이 필요합니다.",
      403,
    );
    ensure(
      actor.id !== request.userId,
      "자기 관리자 계정은 처리할 수 없습니다.",
      403,
    );
    if (request.execute) {
      ensure(
        request.confirmation === `DELETE_SYNTHETIC:${request.userId}` &&
          request.identityConfirmed === true &&
          /^[A-Z0-9][A-Z0-9_-]{5,63}$/.test(request.caseReference ?? ""),
        "대상 계정·본인 확인·접수 기록 참조를 명시해야 실행할 수 있습니다.",
      );
      // Worker claiming uses row locks, not the domain advisory lock. Lock every
      // related PUSH row before inspecting it so a pending job cannot start
      // between inspection and cancellation. Existing RUNNING jobs block closure.
      await tx.$queryRaw`
        SELECT j.id FROM "Job" j
        WHERE j.kind = 'PUSH' AND j.payload->>'notificationId' IN
          (SELECT id FROM "Notification" WHERE "userId" = ${request.userId})
        FOR UPDATE OF j`;
    }
    const state = await inspect(tx, request.userId);
    if (!request.execute) return { mode: "DRY_RUN" as const, ...state.plan };
    if (state.plan.completed)
      return { mode: "ALREADY_COMPLETED" as const, ...state.plan };
    ensure(
      request.expectedFingerprint === state.plan.fingerprint,
      "미리보기 후 상태가 달라졌습니다. 다시 조회한 결과를 확인해 주세요.",
      409,
    );
    ensure(
      state.plan.eligible,
      "진행 중인 신청·권리·작업을 먼저 해결해 주세요.",
      409,
    );
    const userId = request.userId;
    await tx.job.updateMany({
      where: {
        id: { in: state.pushJobs.map((j) => j.id) },
        status: { in: ["PENDING", "FAILED"] },
      },
      data: {
        status: "CANCELED",
        claimToken: null,
        lockedAt: null,
        lastError: null,
        completedAt: new Date(),
      },
    });
    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
    await tx.pushSubscription.deleteMany({ where: { userId } });
    await tx.profile.deleteMany({ where: { userId } });
    await tx.notification.updateMany({
      where: { userId },
      data: {
        title: "",
        body: "",
        href: "",
        pushStatus: "EXPIRED",
      },
    });
    await tx.application.updateMany({
      where: { userId, applicationStatus: "DRAFT" },
      data: { applicationStatus: "CANCELED", reason: "합성 계정 탈퇴 처리" },
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        name: "탈퇴한 참가자",
        email: anonymizedEmail(userId),
        image: null,
        emailVerified: false,
        restriction: WITHDRAWN_RESTRICTION,
      },
    });
    await audit(tx, actor.id, completedAction, userId, undefined, {
      policyVersion: PRIVACY_POLICY_VERSION,
      caseReference: request.caseReference,
      identityConfirmed: true,
      previewFingerprint: state.plan.fingerprint,
      removed: state.plan.removed,
      retained: state.plan.retained,
      consent: state.user.profile
        ? {
            version: state.user.profile.consentVersion,
            at: state.user.profile.consentAt,
          }
        : null,
    });
    return { mode: "EXECUTED" as const, ...state.plan, completed: true };
  });
}
