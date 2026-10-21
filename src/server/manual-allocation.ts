import { createHash } from "node:crypto";
import { z } from "zod";
import { Actor, Tx, admin, audit, ensure } from "./db";
import {
  inspectAllocation,
  createAllocatedTable,
  retireAllocatedTables,
  allocatedTableStatuses,
} from "./table-allocation";
import { notify } from "./jobs";
import { alternativeNotice } from "./notification-content";

const id = z.string().min(1).max(150);
const planSchema = z.object({
  operation: z.enum(["MOVE", "SPLIT", "MERGE", "UNASSIGN"]),
  sourceTableIds: z.array(id).min(1).max(12),
  groups: z
    .array(
      z.object({
        eventId: id,
        venueSlotId: id,
        applicationIds: z.array(id).max(6),
      }),
    )
    .max(12),
  unassignApplicationIds: z.array(id).max(72).default([]),
  reason: z
    .string()
    .trim()
    .min(5, "변경 사유를 5자 이상 입력해 주세요.")
    .max(500),
});
export type ManualAllocationPlan = z.infer<typeof planSchema>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function staff(tx: Tx, actor: Actor) {
  const current = await tx.user.findUnique({ where: { id: actor.id } });
  ensure(current, "로그인이 필요합니다.", 401);
  admin(current);
}
async function inspect(tx: Tx, plan: ManualAllocationPlan) {
  const sources = await tx.diningTable.findMany({
    where: { id: { in: plan.sourceTableIds } },
    include: {
      event: true,
      venueSlot: true,
      room: true,
      applications: {
        where: { applicationStatus: "SUBMITTED" },
        include: { user: { select: { name: true } } },
        orderBy: { id: "asc" },
      },
    },
    orderBy: { id: "asc" },
  });
  const sourceAppIds = sources.flatMap((t) => t.applications.map((a) => a.id));
  const assignedIds = plan.groups.flatMap((g) => g.applicationIds);
  const affectedIds = [
    ...new Set([
      ...sourceAppIds,
      ...assignedIds,
      ...plan.unassignApplicationIds,
    ]),
  ].sort();
  const affected = await tx.application.findMany({
    where: { id: { in: affectedIds } },
    include: {
      user: { include: { profile: true } },
      options: { orderBy: { eventId: "asc" } },
      table: true,
    },
    orderBy: { id: "asc" },
  });
  const jobs = await tx.job.findMany({
    where: {
      OR: plan.sourceTableIds.map((tableId) => ({
        payload: { path: ["tableId"], equals: tableId },
      })),
    },
    select: {
      id: true,
      kind: true,
      status: true,
      runAt: true,
      claimToken: true,
    },
    orderBy: { id: "asc" },
  });
  const waitlists = await tx.waitlistEntry.findMany({
    where: {
      status: { in: ["WAITING", "OFFERED"] },
      OR: [
        { applicationId: { in: affectedIds } },
        // A replacement candidate is not a member of the source table yet.
        // Its offer still reserves this table and owns an expiry job.
        { tableId: { in: plan.sourceTableIds } },
      ],
    },
    orderBy: { id: "asc" },
  });
  const checks = [];
  for (const group of plan.groups)
    checks.push(await inspectAllocation(tx, group, plan.sourceTableIds));
  const issues = checks.flatMap((c, i) =>
    c.issues.map((issue) => `${i + 1}번 새 식탁: ${issue}`),
  );
  const incidents = await tx.exceptionCase.findMany({
    where: {
      kind: "ALLOCATION",
      status: "OPEN",
      objectId: { in: plan.sourceTableIds },
    },
    orderBy: { id: "asc" },
  });
  if (sources.some((t) => !incidents.some((e) => e.objectId === t.id)))
    issues.push("각 원본 식탁의 실제 운영 예외를 먼저 등록해 주세요.");
  if (
    sources.length !== plan.sourceTableIds.length ||
    new Set(plan.sourceTableIds).size !== plan.sourceTableIds.length
  )
    issues.push("원본 식탁을 다시 선택해 주세요.");
  if (
    sources.some(
      (t) =>
        t.status !== "CONFIRMED" ||
        t.event.startsAt <= new Date() ||
        t.event.status === "CANCELED",
    )
  )
    issues.push(
      "시작 전 확정 식탁만 수정할 수 있습니다. 대기 제안 진행 중인 식탁은 먼저 대기 전환을 마쳐 주세요.",
    );
  if (waitlists.length)
    issues.push("진행 중인 대기 등록·제안을 먼저 철회해 주세요.");
  if (
    affected.some(
      (a) =>
        a.tableId &&
        !plan.sourceTableIds.includes(a.tableId) &&
        a.table &&
        allocatedTableStatuses.includes(a.table.status),
    )
  )
    issues.push(
      "다른 확정 식탁의 참가자를 추가하려면 해당 원본 식탁도 선택해 주세요.",
    );
  if (
    affected.some(
      (a) =>
        a.applicationStatus !== "SUBMITTED" ||
        a.paymentStatus !== "PAID" ||
        a.attendanceStatus !== "SCHEDULED",
    )
  )
    issues.push("신청·결제가 완료되고 참석 예정인 신청만 변경할 수 있습니다.");
  const allAssigned = [...assignedIds, ...plan.unassignApplicationIds];
  if (new Set(allAssigned).size !== allAssigned.length)
    issues.push(
      "한 신청을 중복 배정하거나 배정과 해제를 동시에 할 수 없습니다.",
    );
  if (
    affected.length !== affectedIds.length ||
    sourceAppIds.some((appId) => !allAssigned.includes(appId))
  )
    issues.push(
      "원본 식탁의 모든 참가자에게 새 식탁 또는 배정 해제를 지정해 주세요.",
    );
  if (
    plan.unassignApplicationIds.some((appId) => !sourceAppIds.includes(appId))
  )
    issues.push("선택한 원본 식탁의 신청만 해제할 수 있습니다.");
  if (
    plan.operation === "UNASSIGN" &&
    (plan.groups.length ||
      plan.unassignApplicationIds.length !== sourceAppIds.length)
  )
    issues.push("전체 해제는 모든 원본 참가자의 배정을 해제해야 합니다.");
  if (plan.operation === "SPLIT" && plan.groups.length < 2)
    issues.push(
      "분리는 새 식탁 2개 이상이 필요합니다. 각 식탁은 4~6명이어야 합니다.",
    );
  if (
    plan.operation === "MERGE" &&
    (sources.length < 2 || plan.groups.length !== 1)
  )
    issues.push("병합은 원본 식탁 2개 이상을 새 식탁 1개로 합칩니다.");
  if (plan.operation === "MOVE" && !plan.groups.length)
    issues.push("이동할 새 식탁을 지정해 주세요.");
  for (const [i, check] of checks.entries()) {
    if (check.venue) {
      const demand = plan.groups.filter(
        (g) => g.venueSlotId === check.venue!.id,
      ).length;
      const occupied = check.occupiedTables.filter(
        (t) => t.venueSlotId === check.venue!.id,
      ).length;
      if (occupied + demand > check.venue.totalTables)
        issues.push(
          `${i + 1}번 새 식탁: 변경 전체가 식당 테이블 재고를 초과합니다.`,
        );
    }
    if (check.event) {
      const demand = plan.groups
        .filter((g) => g.eventId === check.event!.id)
        .reduce((n, g) => n + g.applicationIds.length, 0);
      const occupied = check.occupiedTables
        .filter((t) => t.eventId === check.event!.id)
        .reduce((n, t) => n + t.applications.length, 0);
      if (
        occupied + demand + check.offeredReservations.length >
        check.event.capacity
      )
        issues.push(`${i + 1}번 새 식탁: 변경 전체가 회차 정원을 초과합니다.`);
    }
  }
  for (let i = 0; i < checks.length; i++) {
    for (let j = i + 1; j < checks.length; j++) {
      const a = checks[i],
        b = checks[j];
      if (
        a.event &&
        b.event &&
        a.event.startsAt < b.event.endsAt &&
        a.event.endsAt > b.event.startsAt &&
        a.rows.some((row) =>
          b.rows.some((other) => row.userId === other.userId),
        )
      )
        issues.push(
          "서로 겹치는 새 식탁에 같은 참가자를 중복 배정할 수 없습니다.",
        );
    }
  }
  const version = hash({
    plan,
    incidents,
    sources,
    affected,
    jobs,
    waitlists,
    checks: checks.map((c) => ({
      event: c.event,
      venue: c.venue,
      rows: c.rows,
      relationships: c.relationships,
      occupiedTables: c.occupiedTables,
      offeredReservations: c.offeredReservations,
    })),
  });
  return {
    version,
    valid: !issues.length,
    issues: [...new Set(issues)],
    sources,
    affected,
    jobs,
    checks,
    incidents,
  };
}
export async function previewManualAllocation(
  tx: Tx,
  actor: Actor,
  raw: unknown,
) {
  await staff(tx, actor);
  const plan = planSchema.parse(raw);
  const state = await inspect(tx, plan);
  return {
    version: state.version,
    valid: state.valid,
    issues: state.issues,
    operation: plan.operation,
    reason: plan.reason,
    sourceTables: state.sources.map((t) => ({
      id: t.id,
      eventTitle: t.event.title,
      venueName: t.venueSlot?.name ?? "미지정",
      roomId: t.room?.id ?? null,
      memberNames: t.applications.map((a) => a.user.name),
    })),
    groups: state.checks.map((c, i) => ({
      eventTitle: c.event?.title ?? "회차 없음",
      startsAt: c.event?.startsAt.toISOString(),
      venueName: c.venue?.name ?? "식당 없음",
      members: c.rows.map((a) => ({ id: a.id, name: a.user.name })),
      issues: c.issues,
      index: i,
    })),
    unassigned: state.affected
      .filter((a) => plan.unassignApplicationIds.includes(a.id))
      .map((a) => ({ id: a.id, name: a.user.name })),
    canceledJobs: state.jobs
      .filter((j) => ["PENDING", "RUNNING", "FAILED"].includes(j.status))
      .map(({ id, kind, runAt }) => ({ id, kind, runAt: runAt.toISOString() })),
    effects: [
      "원본 단체방 접근을 닫고 새 배정마다 새 방을 만듭니다.",
      "이전 예약 안내를 취소하고 새 확정·리마인드·시작·종료 안내를 예약합니다.",
      "결제·이용권 원장을 유지합니다. 해제된 참가자는 일정 이동·보관·환불을 선택할 수 있습니다.",
    ],
  };
}
export type ManualAllocationPreview = Awaited<
  ReturnType<typeof previewManualAllocation>
>;
export async function commitManualAllocation(
  tx: Tx,
  actor: Actor,
  raw: unknown,
) {
  await staff(tx, actor);
  const parsed = planSchema
    .extend({ version: z.string().length(64), requestId: id })
    .parse(raw);
  const { version, requestId, ...plan } = parsed;
  const requestHash = hash(plan);
  const objectId = `manual:${actor.id}:${requestId}`;
  const prior = await tx.auditLog.findFirst({
    where: { action: "MANUAL_ALLOCATION", objectId },
  });
  if (prior) {
    const saved = prior.after as {
      requestHash: string;
      tableIds: string[];
      unassignedIds: string[];
    };
    ensure(
      saved.requestHash === requestHash,
      "같은 요청 번호로 다른 변경을 제출할 수 없습니다.",
      409,
    );
    return {
      tableIds: saved.tableIds,
      unassignedIds: saved.unassignedIds,
      duplicate: true,
    };
  }
  const state = await inspect(tx, plan);
  ensure(
    state.version === version,
    "미리보기 이후 상태가 변경되었습니다. 최신 미리보기를 확인해 주세요.",
    409,
  );
  ensure(state.valid, state.issues.join(" "));
  for (const application of state.affected) {
    const destination = plan.groups.find((group) =>
      group.applicationIds.includes(application.id),
    );
    await audit(
      tx,
      actor.id,
      "MANUAL_ALLOCATION_APPLIED",
      application.id,
      { tableId: application.tableId, matchStatus: application.matchStatus },
      {
        requestId,
        operation: plan.operation,
        reason: plan.reason,
        eventId: destination?.eventId ?? null,
        venueSlotId: destination?.venueSlotId ?? null,
        unassigned: !destination,
      },
    );
  }
  await retireAllocatedTables(tx, plan.sourceTableIds);
  const tableIds: string[] = [];
  for (const group of plan.groups) {
    const table = await createAllocatedTable(tx, {
      ...group,
      reason: plan.reason,
      actorId: actor.id,
      runId: objectId,
      source: "MANUAL",
    });
    tableIds.push(table.id);
  }
  for (const applicationId of plan.unassignApplicationIds) {
    const a = state.affected.find((a) => a.id === applicationId)!;
    const alternatives = await alternativeNotice(tx, a.table!.eventId, a.id);
    await tx.application.update({
      where: { id: a.id },
      data: {
        tableId: null,
        matchStatus: alternatives.count ? "ALTERNATIVE_OFFERED" : "NO_MATCH",
        paymentStatus: "REFUND_AVAILABLE",
        resolution: null,
        reason: `운영자가 배정을 해제했어요. ${plan.reason}`,
      },
    });
    await audit(
      tx,
      actor.id,
      "MATCH_UNRESOLVED",
      a.id,
      { tableId: a.tableId },
      {
        factsVersion: 1,
        failedAt: new Date().toISOString(),
        source: "MANUAL",
        reason: plan.reason,
      },
    );
    await notify(
      tx,
      a.userId,
      `${objectId}:unassigned:${a.id}`,
      "식탁 배정이 변경됐어요",
      `${plan.reason}\n${alternatives.body(plan.reason)}`,
      `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
    );
  }
  await audit(
    tx,
    actor.id,
    "MANUAL_ALLOCATION",
    objectId,
    {
      tables: state.sources.map((t) => ({
        id: t.id,
        eventId: t.eventId,
        venueSlotId: t.venueSlotId,
        roomId: t.room?.id,
        applicationIds: t.applications.map((a) => a.id),
      })),
      jobs: state.jobs,
    },
    {
      requestHash,
      operation: plan.operation,
      reason: plan.reason,
      tableIds,
      unassignedIds: plan.unassignApplicationIds,
      groups: plan.groups,
      version,
      exceptionIds: state.incidents.map((e) => e.id),
    },
  );
  await tx.exceptionCase.updateMany({
    where: { id: { in: state.incidents.map((e) => e.id) } },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolution: `운영 배정 변경 ${objectId}`,
    },
  });
  return {
    tableIds,
    unassignedIds: plan.unassignApplicationIds,
    duplicate: false,
  };
}
