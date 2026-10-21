import { contentCatalog } from "./content-catalog";
import { automationStatus } from "@/worker/automation-status";
import { db, Actor, admin, ensure } from "./db";
import { nextNotice } from "./participant-notices";
import { availableTicketLots } from "@/domain/ticket-lots";
import {
  cancellationCutoff,
  isMeetingDayOrLater,
} from "@/domain/cancellation-policy";
import { applicationMatchHistory, projectMatchFacts } from "./match-facts";
import { projectJobHistory } from "./job-history";
import { suitableAlternatives } from "./alternative-events";
import { noShowMetric } from "@/domain/attendance-metrics";
export async function participantView(actor: Actor) {
  const now = new Date();
  const [user, events, applications, notifications, ledger, relations] =
    await Promise.all([
      db.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          restriction: true,
          profile: true,
        },
      }),
      db.eventSlot.findMany({
        where: { status: "OPEN", closesAt: { gt: new Date() } },
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          title: true,
          region: true,
          startsAt: true,
          endsAt: true,
          closesAt: true,
          matchAt: true,
          cancelRefundCutoffAt: true,
          capacity: true,
          status: true,
        },
      }),
      db.application.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
        include: {
          options: { include: { event: true } },
          payments: { include: { refunds: true } },
          feedback: true,
          waitlist: { include: { event: true } },
          table: {
            include: {
              event: true,
              venueSlot: true,
              applications: {
                where: {
                  applicationStatus: "SUBMITTED",
                  matchStatus: "CONFIRMED",
                },
                select: {
                  id: true,
                  userId: true,
                  user: {
                    select: {
                      name: true,
                      profile: { select: { interests: true, traits: true } },
                    },
                  },
                },
              },
              room: {
                include: {
                  messages: { orderBy: { createdAt: "desc" }, take: 100 },
                },
              },
            },
          },
        },
      }),
      db.notification.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      db.ticketEntry.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
      }),
      db.relationship.findMany({
        where: {
          active: true,
          OR: [{ fromId: actor.id }, { toId: actor.id }],
        },
      }),
    ]);
  ensure(user.restriction !== "WITHDRAWN", "탈퇴 처리된 계정입니다.", 403);
  const eventIds = [
    ...new Set(applications.flatMap((a) => a.options.map((o) => o.eventId))),
  ];
  const tableIds = [
    ...new Set(applications.flatMap((a) => (a.tableId ? [a.tableId] : []))),
  ];
  const noticeJobs =
    eventIds.length || tableIds.length
      ? await db.job.findMany({
          where: {
            OR: [
              ...eventIds.map((eventId) => ({
                kind: "MATCH",
                payload: { path: ["eventId"], equals: eventId },
              })),
              ...tableIds.map((tableId) => ({
                kind: { in: ["REMINDER", "START", "END", "FEEDBACK_REMINDER"] },
                payload: { path: ["tableId"], equals: tableId },
              })),
            ],
          },
          select: { kind: true, payload: true, status: true, runAt: true },
        })
      : [];
  const hidden = new Set(
    relations
      .filter((r) => ["BLOCK", "REPORT"].includes(r.kind))
      .map((r) => (r.fromId === actor.id ? r.toId : r.fromId)),
  );
  const apps = await Promise.all(
    applications.map(async (a) => {
      const canSee =
        a.applicationStatus === "SUBMITTED" &&
        a.matchStatus === "CONFIRMED" &&
        a.table?.status === "CONFIRMED";
      const t = a.table;
      return {
        ...a,
        alternativeEvents:
          ["ALTERNATIVE_OFFERED", "NO_MATCH", "EXCEPTION"].includes(
            a.matchStatus,
          ) && !a.resolution
            ? await suitableAlternatives(db, a.id)
            : [],
        nextNotice: nextNotice(a, noticeJobs, now),
        cancellationCutoffAt: cancellationCutoff(a),
        cancellationBlocked:
          !!a.table && isMeetingDayOrLater(a.table.event.startsAt, now),
        peerPreferences: relations
          .filter(
            (r) =>
              r.fromId === actor.id &&
              r.sourceId === a.id &&
              ["LIKE", "AVOID"].includes(r.kind),
          )
          .map((r) => ({ userId: r.toId, kind: r.kind })),
        table:
          canSee && t
            ? {
                id: t.id,
                status: t.status,
                explanation: t.explanation,
                preferenceFulfillment:
                  projectMatchFacts(t.evaluation)?.members.find(
                    (m) => m.userId === actor.id,
                  )?.preferenceFulfillment ?? null,
                event: t.event,
                venue: t.venueSlot,
                members: t.applications.map((m) => ({
                  id: m.userId,
                  name: m.user.name,
                  interests: m.user.profile?.interests ?? [],
                  traits: m.user.profile?.traits ?? [],
                })),
                room: t.room
                  ? {
                      id: t.room.id,
                      messages: t.room.messages
                        .filter((m) => !m.userId || !hidden.has(m.userId))
                        .reverse()
                        .map((m) => ({
                          ...m,
                          sender: m.userId
                            ? (t.applications.find((a) => a.userId === m.userId)
                                ?.user.name ?? "참가자")
                            : "우연한 식탁",
                        })),
                    }
                  : null,
              }
            : null,
      };
    }),
  );
  const preferredRegions = new Set(
    applications.flatMap((a) => a.options.map((o) => o.event.region)),
  );
  const successful = applications.filter(
    (a) =>
      a.attendanceStatus === "ATTENDED" &&
      a.table &&
      (!a.feedback || a.feedback.returnIntent),
  );
  const likedRegions = new Set(successful.map((a) => a.table!.event.region));
  const weekday = (d: Date) =>
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      weekday: "long",
    }).format(d);
  const likedDays = new Set(
    successful.map((a) => weekday(a.table!.event.startsAt)),
  );
  const futurePool = await db.application.findMany({
    where: {
      userId: { not: actor.id },
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      matchStatus: "WAITING",
    },
    select: { userId: true, options: { select: { eventId: true } } },
  });
  const excluded = new Set(
    relations
      .filter((r) => ["BLOCK", "REPORT", "AVOID"].includes(r.kind))
      .map((r) => (r.fromId === actor.id ? r.toId : r.fromId)),
  );
  const met = new Set(
    relations
      .filter((r) => r.kind === "MET")
      .map((r) => (r.fromId === actor.id ? r.toId : r.fromId)),
  );
  const recommendedEvents = events
    .map((e) => {
      const freshPool = new Set(
        futurePool
          .filter(
            (a) =>
              !excluded.has(a.userId) &&
              !met.has(a.userId) &&
              a.options.some((o) => o.eventId === e.id),
          )
          .map((a) => a.userId),
      ).size;
      const score =
        Number(preferredRegions.has(e.region)) * 3 +
        Number(likedRegions.has(e.region)) * 2 +
        Number(likedDays.has(weekday(e.startsAt))) +
        Math.min(freshPool, 3) / 3;
      return {
        ...e,
        recommendation: likedRegions.has(e.region)
          ? "이전에 즐겁게 참석한 지역이에요"
          : preferredRegions.has(e.region)
            ? "이전에 선택한 지역이에요"
            : likedDays.has(weekday(e.startsAt))
              ? "참석했던 요일의 새로운 만남이에요"
              : "새로운 지역의 식탁을 둘러보세요",
        recommendationScore: score,
      };
    })
    .sort(
      (a, b) =>
        b.recommendationScore - a.recommendationScore ||
        a.startsAt.getTime() - b.startsAt.getTime(),
    );
  return {
    user,
    privacyRequests: await db.exceptionCase.findMany({
      where: { kind: "PRIVACY", objectId: actor.id },
      select: {
        id: true,
        reason: true,
        status: true,
        resolution: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    events: recommendedEvents.map(({ recommendationScore, ...e }) => e),
    applications: apps,
    notifications,
    ledger,
    ticketLots: availableTicketLots(ledger, now),
    ticketBalance: ledger
      .filter((x) => !x.expiresAt || x.expiresAt > now)
      .reduce((s, e) => s + e.units, 0),
    pushPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    demo: process.env.DEMO_MODE === "true",
  };
}
export async function adminView(actor: Actor, eventId?: string) {
  admin(actor, "all");
  const safety = ["ADMIN", "SAFETY"].includes(actor.role);
  const operations = ["ADMIN", "OPERATIONS"].includes(actor.role);
  const [
    events,
    allApplications,
    tables,
    runs,
    allJobs,
    allExceptions,
    allReports,
    allAudits,
    settings,
    notifications,
    allTicketEntries,
    allRelationships,
    notificationTargets,
  ] = await Promise.all([
    db.eventSlot.findMany({
      include: { venues: true },
      orderBy: { startsAt: "asc" },
    }),
    db.application.findMany({
      include: {
        user: {
          select: { id: true, name: true, email: true, profile: operations },
        },
        options: { include: { event: true } },
        payments: { include: { refunds: true } },
        feedback: true,
        table: { include: { event: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.diningTable.findMany({
      where: eventId ? { eventId } : {},
      include: {
        event: true,
        venueSlot: true,
        applications: {
          select: {
            id: true,
            userId: true,
            applicationStatus: true,
            matchStatus: true,
            user: { select: { name: true } },
          },
        },
        room: {
          include: { messages: { orderBy: { createdAt: "desc" }, take: 20 } },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.matchRun.findMany({
      where: eventId ? { eventId } : {},
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    db.job.findMany({ orderBy: { runAt: "desc" } }),
    db.exceptionCase.findMany({ orderBy: { createdAt: "desc" } }),
    db.safetyReport.findMany({ orderBy: { createdAt: "desc" } }),
    db.auditLog.findMany({ orderBy: { createdAt: "desc" } }),
    operations ? db.setting.findMany() : [],
    operations
      ? db.notification.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
      : [],
    operations
      ? db.ticketEntry.findMany({ orderBy: { createdAt: "asc" } })
      : [],
    safety
      ? db.relationship.findMany({
          where: { kind: { in: ["AVOID", "BLOCK", "REPORT"] } },
          orderBy: { createdAt: "desc" },
        })
      : [],
    operations
      ? db.notification.findMany({
          select: {
            id: true,
            href: true,
            userId: true,
            key: true,
            title: true,
            pushStatus: true,
            createdAt: true,
          },
        })
      : [],
  ]);
  const eventHistoryIds = new Set(
    allAudits
      .filter((a) => {
        const before = a.before as Record<string, unknown> | null;
        const after = a.after as Record<string, unknown> | null;
        return (
          eventId &&
          ([before?.eventId, after?.eventId].includes(eventId) ||
            [before?.eventIds, after?.eventIds].some(
              (ids) => Array.isArray(ids) && ids.includes(eventId),
            ))
        );
      })
      .map((a) => a.objectId),
  );
  const applications = eventId
    ? allApplications.filter(
        (a) =>
          a.table?.eventId === eventId ||
          a.options.some((o) => o.eventId === eventId) ||
          eventHistoryIds.has(a.id),
      )
    : allApplications;
  const jobs = operations
    ? allJobs.slice(0, 200).map((job) => ({
        ...job,
        attemptHistory: projectJobHistory(job.id, allAudits),
      }))
    : [];
  const reports = safety ? allReports : [];
  const visibleActions = new Set(["SAFETY_REVIEWED", "REPORT", "BLOCK"]);
  const audits = allAudits
    .filter(
      (a) =>
        actor.role === "ADMIN" ||
        (safety
          ? visibleActions.has(a.action)
          : !visibleActions.has(a.action) &&
            a.action !== "FEEDBACK_SAVED" &&
            !a.action.startsWith("PRIVACY_")),
    )
    .slice(0, 200);
  // Exception targets may be applications, tables, events, reports or jobs.
  // Resolve them to application IDs before counting unique human interventions.
  const affected = (objectId: string, depth = 0): string[] => {
    if (depth > 3) return [];
    if (allApplications.some((a) => a.id === objectId)) return [objectId];
    const job = allJobs.find((j) => j.id === objectId);
    if (job) {
      const p = job.payload as Record<string, string>;
      if (p.notificationId) {
        const href = notificationTargets.find(
          (n) => n.id === p.notificationId,
        )?.href;
        const applicationId = href
          ? new URL(href, "https://siktak.invalid").searchParams.get(
              "application",
            )
          : null;
        return applicationId &&
          allApplications.some((a) => a.id === applicationId)
          ? [applicationId]
          : [];
      }
      if (p.refundId)
        return allApplications
          .filter((a) =>
            a.payments.some((pay) =>
              pay.refunds.some((r) => r.id === p.refundId),
            ),
          )
          .map((a) => a.id);
      return affected(p.eventId ?? p.tableId ?? "", depth + 1);
    }
    const report = allReports.find((r) => r.id === objectId);
    if (report) return [report.applicationId];
    return allApplications
      .filter(
        (a) =>
          a.tableId === objectId ||
          a.table?.eventId === objectId ||
          a.options.some((o) => o.eventId === objectId),
      )
      .map((a) => a.id);
  };
  const scopedExceptions = allExceptions.filter(
    (e) =>
      !eventId ||
      affected(e.objectId).some((id) => applications.some((a) => a.id === id)),
  );
  const exceptions = scopedExceptions.filter((e) =>
    e.kind === "PRIVACY"
      ? actor.role === "ADMIN"
      : e.kind === "SAFETY"
        ? safety
        : operations,
  );
  const appIds = new Set(applications.map((a) => a.id));
  const submitted = applications.filter((a) => a.applicationStatus !== "DRAFT");
  const paid = submitted.filter((a) =>
    a.payments.some((p) => ["PAID", "REFUNDED"].includes(p.status)),
  );
  const matched = submitted.filter((a) => a.matchStatus === "CONFIRMED");
  const attended = submitted.filter((a) => a.attendanceStatus === "ATTENDED");
  const unique = (ids: string[]) => new Set(ids).size;
  const metric = (label: string, n: number, d: number) => ({
    label,
    n,
    d,
    value: d ? n / d : null,
  });
  const transferred = allAudits.filter(
    (a) => a.action === "MATCH_TRANSFERRED" && appIds.has(a.objectId),
  );
  const reallocated = allAudits.filter(
    (a) => a.action === "REALLOCATED" && appIds.has(a.objectId),
  );
  const failedIds = new Set([
    ...allAudits
      .filter((a) => a.action === "MATCH_UNRESOLVED" && appIds.has(a.objectId))
      .map((a) => a.objectId),
    ...transferred.map((a) => a.objectId),
  ]);
  const refunds = applications.flatMap((a) =>
    a.payments.flatMap((p) => p.refunds),
  );
  const interventions = allAudits.filter((a) =>
    [
      "MANUAL_ALLOCATION_APPLIED",
      "EXCEPTION_RESOLVED",
      "JOB_RETRY",
      "ATTENDANCE_REVIEWED",
      "SAFETY_REVIEWED",
      "MATCH_RETRY",
    ].includes(a.action),
  );
  const interventionIds = new Set(
    interventions
      .flatMap((a) => affected(a.objectId))
      .filter((id) => appIds.has(id)),
  );
  const attendedIds = new Set(attended.map((a) => a.userId));
  const returning = [...attendedIds].filter((uid) => {
    const first = attended
      .filter((a) => a.userId === uid && a.table)
      .sort(
        (a, b) =>
          a.table!.event.endsAt.getTime() - b.table!.event.endsAt.getTime(),
      )[0];
    return (
      first &&
      allApplications.some(
        (a) =>
          a.applicationStatus !== "DRAFT" &&
          a.userId === uid &&
          a.createdAt > first.table!.event.endsAt,
      )
    );
  }).length;
  const metrics = [
    metric(
      "신청 완료율",
      unique(submitted.map((a) => a.userId)),
      unique(applications.map((a) => a.userId)),
    ),
    metric("결제 전환율", paid.length, submitted.length),
    metric("매칭 성공률", matched.length, paid.length),
    metric(
      "자동 확정률",
      tables.filter(
        (t) =>
          t.status === "CONFIRMED" &&
          !interventions.some(
            (a) =>
              a.createdAt <= t.createdAt &&
              affected(a.objectId).some((id) =>
                t.applications.some((app) => app.id === id),
              ),
          ),
      ).length,
      tables.filter((t) => t.status === "CONFIRMED").length,
    ),
    metric(
      "자동 재배치 성공률",
      unique(reallocated.map((a) => a.objectId)),
      unique([...reallocated.map((a) => a.objectId), ...failedIds]),
    ),
    metric(
      "대체 일정 전환율",
      unique(transferred.map((a) => a.objectId)),
      failedIds.size,
    ),
    metric(
      "자동 환불 완료율",
      refunds.filter(
        (r) =>
          r.status === "REFUNDED" &&
          !interventions.some(
            (log) =>
              log.createdAt <= r.updatedAt &&
              allJobs.some(
                (j) =>
                  j.id === log.objectId &&
                  (j.payload as Record<string, string>).refundId === r.id,
              ),
          ),
      ).length,
      refunds.length,
    ),
    metric(
      "실제 참가 전환율",
      unique(attended.map((a) => a.userId)),
      unique(submitted.map((a) => a.userId)),
    ),
    noShowMetric(
      submitted.flatMap((a) => {
        const confirmation = allAudits.find(
          (log) => log.objectId === a.id && log.action === "MATCH_CONFIRMED",
        );
        const eventId = (confirmation?.after as { eventId?: string } | null)
          ?.eventId;
        const event = a.table?.event ?? events.find((e) => e.id === eventId);
        if (!event || (!a.table && !confirmation)) return [];
        const cancellation = allAudits.find(
          (log) =>
            log.objectId === a.id && log.action === "APPLICATION_CANCELED",
        );
        const saved = (cancellation?.after as { canceledAt?: string } | null)
          ?.canceledAt;
        return [
          {
            attendanceStatus: a.attendanceStatus,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            canceledAt: saved
              ? new Date(saved)
              : (cancellation?.createdAt ?? null),
          },
        ];
      }),
    ),
    metric("재방문율", returning, attendedIds.size),
    metric(
      "피드백 응답률",
      attended.filter((a) => a.feedback).length,
      attended.length,
    ),
    metric("운영자 개입률", interventionIds.size, submitted.length),
  ];
  const koreanDay = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  const sameDayCancellations = new Set(
    allAudits
      .filter((log) => {
        if (log.action !== "APPLICATION_CANCELED") return false;
        const a = allApplications.find(
          (candidate) => candidate.id === log.objectId,
        );
        const snapshot = log.after as Record<string, unknown> | null;
        const hasSnapshot = !!snapshot && Object.hasOwn(snapshot, "eventId");
        const actualEventId =
          typeof snapshot?.eventId === "string"
            ? snapshot.eventId
            : hasSnapshot
              ? null
              : a?.table?.eventId;
        const start =
          typeof snapshot?.eventStartsAt === "string"
            ? new Date(snapshot.eventStartsAt)
            : hasSnapshot
              ? null
              : a?.table?.event.startsAt;
        const canceledAt =
          typeof snapshot?.canceledAt === "string"
            ? new Date(snapshot.canceledAt)
            : log.createdAt;
        return (
          start &&
          Number.isFinite(start.getTime()) &&
          Number.isFinite(canceledAt.getTime()) &&
          actualEventId &&
          (!eventId || actualEventId === eventId) &&
          koreanDay(start) === koreanDay(canceledAt)
        );
      })
      .map((log) => log.objectId),
  ).size;
  const venueMissingTables = tables.filter(
    (t) => t.status === "CONFIRMED" && !t.venueSlotId,
  );
  const operationalSummary = {
    unresolvedConditionCases: scopedExceptions.filter(
      (e) =>
        e.status === "OPEN" &&
        ["DATA", "CONDITION", "MATCHING"].includes(e.kind),
    ).length,
    venueCases: scopedExceptions.filter(
      (e) => e.status === "OPEN" && e.kind === "VENUE",
    ).length,
    unassignedVenueTables: venueMissingTables.length,
    unassignedVenueApplications: venueMissingTables.reduce(
      (sum, t) =>
        sum +
        t.applications.filter(
          (a) =>
            a.applicationStatus === "SUBMITTED" &&
            a.matchStatus === "CONFIRMED",
        ).length,
      0,
    ),
    noticeFailures: allJobs.filter(
      (j) =>
        j.status === "FAILED" &&
        ["PUSH", "REMINDER"].includes(j.kind) &&
        (!eventId || affected(j.id).some((id) => appIds.has(id))),
    ).length,
    sameDayCancellations,
  };
  return {
    contentCatalog: operations ? await contentCatalog(db) : [],
    waitlist: operations
      ? await db.waitlistEntry.findMany({
          where: eventId ? { eventId } : {},
          include: {
            event: true,
            application: {
              select: { id: true, user: { select: { name: true } } },
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [],
    user: { id: actor.id, name: actor.name, role: actor.role },
    events: operations ? events : [],
    applications: operations
      ? applications.map((a) => ({
          ...a,
          matchHistory: applicationMatchHistory(a.id, allAudits),
        }))
      : [],
    safetyRelationships: safety
      ? allRelationships
          .filter(
            (r) =>
              !eventId ||
              applications.some(
                (a) =>
                  a.id === r.sourceId ||
                  a.userId === r.fromId ||
                  a.userId === r.toId,
              ),
          )
          .map((r) => ({
            ...r,
            fromName:
              allApplications.find((a) => a.userId === r.fromId)?.user.name ??
              "참가자",
            toName:
              allApplications.find((a) => a.userId === r.toId)?.user.name ??
              "참가자",
          }))
      : [],
    ticketEntries: operations
      ? allTicketEntries.filter(
          (e) => !eventId || (!!e.applicationId && appIds.has(e.applicationId)),
        )
      : [],
    safetyParticipants: safety
      ? applications.map((a) => ({
          id: a.id,
          userId: a.userId,
          name: a.user.name,
        }))
      : [],
    tables: operations
      ? tables.map((t) => ({
          ...t,
          matchFacts: projectMatchFacts(t.evaluation),
          noticeJobs: allJobs
            .filter(
              (j) =>
                (j.payload as Record<string, unknown> | null)?.tableId === t.id,
            )
            .map(({ id, kind, status, runAt, completedAt }) => ({
              id,
              kind,
              status,
              runAt,
              completedAt,
            })),
          notices: notificationTargets
            .filter(
              (n) =>
                n.key.startsWith(`confirmed:${t.id}:`) ||
                n.key.startsWith(`reminder:${t.id}:`) ||
                t.applications.some(
                  (a) =>
                    n.key === `feedback:${a.id}` ||
                    n.key === `feedback-once:${a.id}`,
                ),
            )
            .map(({ id, userId, title, pushStatus, createdAt }) => ({
              id,
              userId,
              title,
              pushStatus,
              createdAt,
            })),
        }))
      : [],
    runs: operations
      ? runs.map((r) => ({
          ...r,
          input: safety
            ? r.input
            : {
                version: r.version,
                notice:
                  "제외 관계를 포함한 원본 입력은 전체 관리자만 조회합니다.",
              },
        }))
      : [],
    jobs,
    exceptions,
    reports,
    audits,
    settings: operations
      ? settings.filter(
          (s) => !s.key.startsWith("content:") && s.key !== "matchingPolicy",
        )
      : [],
    notifications:
      actor.role === "ADMIN"
        ? notifications
        : notifications.filter((n) => !n.key.startsWith("privacy-review:")),
    metrics: operations ? metrics : [],
    operationalSummary: operations ? operationalSummary : null,
    operatingSeconds: scopedExceptions.reduce(
      (s, e) => s + e.handlingSeconds,
      0,
    ),
    period: {
      from: applications.at(-1)?.createdAt ?? null,
      to: new Date(),
      eventId: eventId ?? null,
    },
    automation: automationStatus(settings),
    workerOnline: automationStatus(settings, "worker").online,
    demo: process.env.DEMO_MODE === "true",
  };
}
export type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
export type ParticipantData = Wire<Awaited<ReturnType<typeof participantView>>>;
export type AdminData = Wire<Awaited<ReturnType<typeof adminView>>>;
