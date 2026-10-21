import { randomUUID } from "node:crypto";
import { reservationExpiries, coversEvent } from "./ticket-eligibility";
import { notificationDayMs } from "./notification-timing";
import { Tx, audit, ensure } from "./db";
import { validateGroup } from "@/domain/matching";
import type { ScoringContext } from "@/domain/matching-policy";
import { allocationContext, evaluateAllocation } from "./matching-policy";
import { captureMatchFacts, applicationMatchHistory } from "./match-facts";
import { enqueue, notify } from "./jobs";
import { eventDateTime } from "@/domain/notification-templates";
import { freezeTableContent } from "./content-catalog";
import { cancellationNotice } from "@/domain/cancellation-policy";
import { loadNotificationTemplates } from "./notification-content";

export const allocatedTableStatuses = ["CONFIRMED", "WAITLIST_PENDING"];
export type AllocationGroup = {
  eventId: string;
  venueSlotId: string;
  applicationIds: string[];
};

/** Read-only validation also used by operator previews. Caller holds atomic(). */
export async function inspectAllocation(
  tx: Tx,
  group: AllocationGroup,
  ignoreTableIds: string[] = [],
  scoring?: ScoringContext,
) {
  const event = await tx.eventSlot.findUnique({ where: { id: group.eventId } });
  const venue = await tx.venueSlot.findUnique({
    where: { id: group.venueSlotId },
  });
  const rows = await tx.application.findMany({
    where: { id: { in: group.applicationIds } },
    include: {
      user: { include: { profile: true } },
      options: { include: { event: true }, orderBy: { eventId: "asc" } },
    },
    orderBy: { id: "asc" },
  });
  const relationships = await tx.relationship.findMany({
    where: {
      active: true,
      fromId: { in: rows.map((a) => a.userId) },
      toId: { in: rows.map((a) => a.userId) },
    },
    orderBy: { id: "asc" },
  });
  const occupiedTables = await tx.diningTable.findMany({
    where: {
      id: { notIn: ignoreTableIds },
      status: { in: allocatedTableStatuses },
    },
    include: {
      event: true,
      applications: {
        where: { applicationStatus: "SUBMITTED" },
        select: { id: true, userId: true },
      },
    },
    orderBy: { id: "asc" },
  });
  const offeredReservations = await tx.waitlistEntry.findMany({
    where: {
      eventId: group.eventId,
      status: "OFFERED",
      tableId: { notIn: ignoreTableIds },
    },
    select: { id: true, applicationId: true, tableId: true, expiresAt: true },
    orderBy: { id: "asc" },
  });
  const year = event
    ? Number(
        new Intl.DateTimeFormat("en", {
          timeZone: "Asia/Seoul",
          year: "numeric",
        }).format(event.startsAt),
      )
    : 0;
  const members = rows.map((a) => ({
    id: a.id,
    userId: a.userId,
    age: a.user.profile ? year - a.user.profile.birthYear : NaN,
    gender: a.user.profile?.gender ?? "",
    mbti: a.user.profile?.mbti ?? [],
    interests: a.user.profile?.interests ?? [],
    traits: a.user.profile?.traits ?? [],
    desiredTraits: a.user.profile?.desiredTraits ?? [],
  }));
  const conflicts = occupiedTables.filter(
    (t) =>
      event &&
      t.event.startsAt < event.endsAt &&
      t.event.endsAt > event.startsAt,
  );
  const occupied = new Set(
    conflicts.flatMap((t) => t.applications.map((a) => a.userId)),
  );
  const issues = validateGroup(members, relationships);
  const expiries = await reservationExpiries(
    tx,
    rows.map((a) => a.id),
  );
  if (
    event &&
    rows.some((a) => !coversEvent(expiries.get(a.id), event.startsAt))
  )
    issues.push("이용권 유효기간 밖의 일정에는 배정할 수 없습니다.");
  const context =
    scoring ??
    (await allocationContext(tx, event?.startsAt ?? new Date(), members));
  const quality = evaluateAllocation(members, relationships, context);
  if (quality.evaluation.score < quality.minimum)
    issues.push("최소 매칭 점수를 충족하지 못했습니다.");
  if (
    !event ||
    !["OPEN", "MATCHED"].includes(event.status) ||
    event.startsAt <= new Date()
  )
    issues.push("시작 전 유효한 회차만 배정할 수 있습니다.");
  if (!venue || venue.eventId !== group.eventId)
    issues.push("해당 회차의 식당을 선택해 주세요.");
  if (
    new Set(group.applicationIds).size !== group.applicationIds.length ||
    rows.length !== group.applicationIds.length
  )
    issues.push("중복되거나 존재하지 않는 신청이 있습니다.");
  if (
    rows.some(
      (a) =>
        a.applicationStatus !== "SUBMITTED" ||
        a.paymentStatus !== "PAID" ||
        a.attendanceStatus !== "SCHEDULED",
    )
  )
    issues.push(
      "신청·결제가 완료되고 참석 예정인 참가자만 배정할 수 있습니다.",
    );
  if (
    rows.some(
      (a) =>
        !a.user.profile?.consentAt ||
        !["NONE", "WARNING"].includes(a.user.restriction),
    )
  )
    issues.push("프로필 동의 또는 이용 자격을 확인해 주세요.");
  if (rows.some((a) => !a.options.some((o) => o.eventId === group.eventId)))
    issues.push("참가자가 선택하지 않은 날짜·지역으로 이동할 수 없습니다.");
  if (rows.some((a) => occupied.has(a.userId)))
    issues.push("같은 시간에 이미 배정된 참가자가 있습니다.");
  if (
    venue &&
    (venue.capacity < rows.length ||
      occupiedTables.filter((t) => t.venueSlotId === venue.id).length >=
        venue.totalTables)
  )
    issues.push("식당의 인원 또는 테이블 재고가 부족합니다.");
  if (
    event &&
    occupiedTables
      .filter((t) => t.eventId === event.id)
      .reduce((sum, t) => sum + t.applications.length, 0) +
      rows.length +
      offeredReservations.length >
      event.capacity
  )
    issues.push("회차 정원을 초과합니다.");
  return {
    issues,
    event,
    venue,
    rows,
    relationships,
    members,
    occupied,
    occupiedTables,
    offeredReservations,
    quality,
    context,
  };
}

/** Caller retires replaced tables first. All writes must share one atomic(). */
export async function createAllocatedTable(
  tx: Tx,
  input: AllocationGroup & {
    reason: string;
    actorId: string;
    runId?: string;
    source: "MANUAL" | "WAITLIST" | "AUTO";
    scoring?: ScoringContext;
  },
) {
  const state = await inspectAllocation(tx, input, [], input.scoring);
  ensure(!state.issues.length, state.issues.join(" "));
  const { event, venue, rows, relationships, members, occupied } = state;
  ensure(event && venue, "회차 또는 식당을 찾을 수 없습니다.");
  const runId = input.runId ?? `${input.source.toLowerCase()}:${randomUUID()}`;
  const confirmedAt = new Date();
  const prior = await tx.auditLog.findMany({
    where: { objectId: { in: input.applicationIds } },
    orderBy: { createdAt: "asc" },
  });
  const facts = captureMatchFacts({
    event,
    members: members.map((m) => {
      const a = rows.find((a) => a.id === m.id)!;
      const p = a.user.profile!;
      const history = applicationMatchHistory(a.id, prior);
      if (a.tableId || history.confirmedAt) {
        history.reallocationCount =
          history.reallocationCount === null
            ? null
            : history.reallocationCount + 1;
        history.recordedReallocationCount++;
        history.lastReallocationAt = confirmedAt.toISOString();
        history.lastReallocationReason = input.reason;
      }
      history.confirmedAt = confirmedAt.toISOString();
      history.finalReason = input.reason;
      return {
        ...m,
        name: a.user.name,
        budgets: p.budgets,
        foodRestrictions: p.foodRestrictions,
        allergies: p.allergies,
        selectedEvents: a.options.map((o) => o.event),
        paymentStatus: a.paymentStatus,
        applicationStatus: a.applicationStatus,
        consented: !!p.consentAt,
        restriction: a.user.restriction,
        history,
      };
    }),
    relations: relationships,
    occupiedUserIds: occupied,
    confirmedAt,
    finalReason: input.reason,
  });
  ensure(
    Object.values(facts.constraints).every(Boolean),
    "배정 필수 조건을 충족하지 못했습니다.",
  );
  const evaluation = state.quality.evaluation;
  const curation =
    input.source === "AUTO"
      ? `${(await loadNotificationTemplates(tx)).curation}\n${input.reason}`
      : input.reason;
  const table = await tx.diningTable.create({
    data: {
      eventId: event.id,
      venueSlotId: venue.id,
      runId,
      score: evaluation.score,
      explanation: input.reason,
      createdAt: confirmedAt,
      evaluation: JSON.parse(
        JSON.stringify({
          ...evaluation,
          members,
          facts,
          source: input.source,
          dietaryNotes: venue.dietaryNotes,
          foodConditions: rows.map((a) => ({
            userId: a.userId,
            budgets: a.user.profile!.budgets,
            foodRestrictions: a.user.profile!.foodRestrictions,
            allergies: a.user.profile!.allergies,
          })),
        }),
      ),
      room: { create: {} },
    },
    include: { room: true },
  });
  await tx.application.updateMany({
    where: { id: { in: input.applicationIds } },
    data: {
      matchStatus: "CONFIRMED",
      tableId: table.id,
      reason: input.reason,
      resolution: null,
    },
  });
  for (const a of rows) {
    if (
      a.tableId ||
      prior.some(
        (log) => log.objectId === a.id && log.action === "MATCH_CONFIRMED",
      )
    )
      await audit(
        tx,
        input.actorId,
        "REALLOCATED",
        a.id,
        { tableId: a.tableId },
        {
          tableId: table.id,
          eventId: event.id,
          runId,
          factsVersion: 1,
          reallocatedAt: confirmedAt.toISOString(),
          reason: input.reason,
          source: input.source,
        },
      );
    await audit(
      tx,
      input.actorId,
      "MATCH_CONFIRMED",
      a.id,
      { tableId: a.tableId },
      {
        tableId: table.id,
        eventId: event.id,
        runId,
        factsVersion: 1,
        confirmedAt: confirmedAt.toISOString(),
        reason: input.reason,
        source: input.source,
      },
    );
    await notify(
      tx,
      a.userId,
      `confirmed:${table.id}:${a.id}`,
      "함께할 식탁이 정해졌어요",
      `${curation}\n${eventDateTime(event.startsAt)} · ${event.region} · ${venue.name}. 모임 상세와 단체방을 확인해 주세요.`,
      `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
    );
  }
  await tx.message.create({
    data: {
      roomId: table.room!.id,
      kind: "SYSTEM",
      key: `welcome:${table.id}`,
      body: `${curation}\n${eventDateTime(event.startsAt)}\n${venue.name} · ${venue.address}\n예약명: ${venue.reservationName} · 식비 약 ${venue.price.toLocaleString()}원, 현장 개별 결제\n가상 식당·모의 예약입니다. 식이 조건은 식당 안내에서 확인해 주세요.\n${cancellationNotice(event.cancelRefundCutoffAt)} 안전 문제는 언제든 신고할 수 있어요.`,
    },
  });
  await enqueue(
    tx,
    `reminder:${table.id}`,
    "REMINDER",
    { tableId: table.id },
    new Date(
      Math.max(Date.now(), event.startsAt.getTime() - notificationDayMs()),
    ),
  );
  await enqueue(
    tx,
    `start:${table.id}`,
    "START",
    { tableId: table.id },
    event.startsAt,
  );
  await enqueue(
    tx,
    `end:${table.id}`,
    "END",
    { tableId: table.id },
    event.endsAt,
  );
  await enqueue(
    tx,
    `feedback-reminder:${table.id}`,
    "FEEDBACK_REMINDER",
    { tableId: table.id },
    new Date(event.endsAt.getTime() + notificationDayMs()),
  );
  await freezeTableContent(tx, table.id);
  return table;
}

export async function retireAllocatedTables(tx: Tx, tableIds: string[]) {
  if (!tableIds.length) return;
  await tx.diningTable.updateMany({
    where: { id: { in: tableIds } },
    data: { status: "REPLACED" },
  });
  // Cancel claimed work as well: the worker rechecks its claim under atomic().
  await tx.job.updateMany({
    where: {
      status: { in: ["PENDING", "RUNNING", "FAILED"] },
      OR: tableIds.map((id) => ({
        payload: { path: ["tableId"], equals: id },
      })),
    },
    data: {
      status: "CANCELED",
      claimToken: null,
      lockedAt: null,
      lastError: "배정 변경으로 이전 테이블 작업을 취소했습니다.",
    },
  });
  const oldNotices = await tx.notification.findMany({
    where: {
      OR: tableIds.flatMap((id) => [
        { key: { startsWith: `confirmed:${id}:` } },
        { key: { startsWith: `reminder:${id}:` } },
      ]),
    },
    select: { id: true },
  });
  if (oldNotices.length) {
    await tx.notification.updateMany({
      where: {
        id: { in: oldNotices.map((n) => n.id) },
        pushStatus: { not: "SENT" },
      },
      data: { pushStatus: "EXPIRED" },
    });
    await tx.job.updateMany({
      where: {
        kind: "PUSH",
        status: { in: ["PENDING", "RUNNING", "FAILED"] },
        OR: oldNotices.map((n) => ({
          payload: { path: ["notificationId"], equals: n.id },
        })),
      },
      data: {
        status: "CANCELED",
        claimToken: null,
        lockedAt: null,
        lastError: "배정 변경으로 이전 확정 안내를 취소했습니다.",
      },
    });
  }
}
