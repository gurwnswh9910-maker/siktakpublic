import { type Tx, audit, ensure } from "./db";
import type { Candidate } from "@/domain/matching";
import {
  composeExact,
  MatchingIncomplete,
  type MatchPool,
} from "@/domain/matching-exact";
import { MATCHING_VERSION } from "@/domain/matching-policy";
import {
  dateBounds,
  loadMatchingPolicy,
  matchDay,
  matchVersion,
} from "./matching-policy";
import { createAllocatedTable } from "./table-allocation";
import { runLegacyMatch } from "./match-run-legacy";
import { enqueue, notify } from "./jobs";
import { alternativeNotice } from "./notification-content";
import { reservationExpiries, coversEvent } from "./ticket-eligibility";

const active = ["WAITING", "MATCHING", "REALLOCATING"] as const;
export async function runMatch(tx: Tx, eventId: string) {
  if (matchVersion() !== MATCHING_VERSION) return runLegacyMatch(tx, eventId);
  const initial = await tx.eventSlot.findUniqueOrThrow({
    where: { id: eventId },
  });
  const now = new Date(),
    day = matchDay(initial.startsAt);
  const policy = await loadMatchingPolicy(tx);
  // Do not confirm another region before that region's own matching deadline.
  const events = await tx.eventSlot.findMany({
    where: {
      startsAt: { ...dateBounds(initial.startsAt), gt: now },
      status: { in: ["OPEN", "MATCHED"] },
      OR: [{ id: eventId }, { matchAt: { lte: now } }],
    },
    orderBy: { id: "asc" },
  });
  const eventIds = events.map((e) => e.id);
  const rows = await tx.application.findMany({
    where: {
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      tableId: null,
      matchStatus: { in: [...active] },
      OR: [
        { waitlist: null },
        { waitlist: { status: { notIn: ["WAITING", "OFFERED"] } } },
      ],
      options: {
        some: { eventId: { in: [...new Set([...eventIds, eventId])] } },
      },
    },
    include: {
      user: { include: { profile: true } },
      options: { include: { event: true } },
    },
    orderBy: { id: "asc" },
  });
  const expiries = await reservationExpiries(
    tx,
    rows.map((a) => a.id),
  );
  const eligible = rows.filter(
    (a) =>
      (!a.lastDeferredDate || a.lastDeferredDate < day) &&
      a.attendanceStatus === "SCHEDULED" &&
      a.user.profile?.consentAt &&
      ["NONE", "WARNING"].includes(a.user.restriction),
  );
  const relations = await tx.relationship.findMany({ where: { active: true } });
  const occupiedTables = await tx.diningTable.findMany({
    where: { status: { in: ["CONFIRMED", "WAITLIST_PENDING"] } },
    include: {
      event: true,
      applications: { where: { applicationStatus: "SUBMITTED" } },
    },
  });
  const venues = await tx.venueSlot.findMany({
    where: { eventId: { in: eventIds } },
    include: {
      tables: { where: { status: { in: ["CONFIRMED", "WAITLIST_PENDING"] } } },
    },
    orderBy: [{ capacity: "asc" }, { id: "asc" }],
  });
  const reservations = await tx.waitlistEntry.findMany({
    where: { eventId: { in: eventIds }, status: "OFFERED" },
  });
  const pools: MatchPool[] = events.map((event) => {
    const occupied = new Set(
      occupiedTables
        .filter(
          (t) =>
            t.event.startsAt < event.endsAt && t.event.endsAt > event.startsAt,
        )
        .flatMap((t) => t.applications.map((a) => a.userId)),
    );
    const candidates: Candidate[] = eligible
      .filter(
        (a) =>
          a.options.some((o) => o.eventId === event.id) &&
          coversEvent(expiries.get(a.id), event.startsAt) &&
          !occupied.has(a.userId),
      )
      .map((a) => ({
        id: a.id,
        userId: a.userId,
        age: Number(day.slice(0, 4)) - a.user.profile!.birthYear,
        gender: a.user.profile!.gender,
        mbti: a.user.profile!.mbti,
        interests: a.user.profile!.interests,
        traits: a.user.profile!.traits,
        desiredTraits: a.user.profile!.desiredTraits,
        deferredCount: a.deferredCount,
        hasLaterDate: a.options.some(
          (o) =>
            matchDay(o.event.startsAt) > day &&
            coversEvent(expiries.get(a.id), o.event.startsAt) &&
            o.event.startsAt > now &&
            ["OPEN", "MATCHED"].includes(o.event.status),
        ),
      }));
    return {
      eventId: event.id,
      candidates,
      maxParticipants: Math.max(
        0,
        event.capacity -
          occupiedTables
            .filter((t) => t.eventId === event.id)
            .reduce((s, t) => s + t.applications.length, 0) -
          reservations.filter((r) => r.eventId === event.id).length,
      ),
      tableCapacities: venues
        .filter((v) => v.eventId === event.id)
        .flatMap((v) =>
          Array.from(
            { length: Math.max(0, v.totalTables - v.tables.length) },
            () => v.capacity,
          ),
        ),
    };
  });
  const run = await tx.matchRun.create({
    data: {
      eventId,
      version: MATCHING_VERSION,
      status: "RUNNING",
      input: JSON.parse(
        JSON.stringify({
          day,
          policy,
          pools,
          relations,
          ageBasis: "KST calendar year minus birth year",
        }),
      ),
    },
  });
  for (const pool of pools) {
    if (
      pool.candidates.length >= 4 &&
      pool.maxParticipants >= 4 &&
      !pool.tableCapacities.some((capacity) => capacity >= 4)
    ) {
      await tx.exceptionCase.upsert({
        where: { key: `venue:${pool.eventId}` },
        create: {
          key: `venue:${pool.eventId}`,
          kind: "VENUE",
          objectId: pool.eventId,
          reason:
            "배정 가능한 식당 테이블 재고가 없습니다. 식당 여건을 확인해 주세요.",
        },
        update: { status: "OPEN", resolvedAt: null },
      });
    }
  }
  let result: Awaited<ReturnType<typeof composeExact>>;
  try {
    result = await composeExact(pools, relations, policy);
  } catch (error) {
    if (!(error instanceof MatchingIncomplete)) throw error;
    // Preserve evidence and paid applications for a retry; no partial assignment
    // or artificial deferral is produced from a non-optimal solve.
    await tx.matchRun.update({
      where: { id: run.id },
      data: {
        status: "INCOMPLETE",
        completedAt: new Date(),
        result: JSON.parse(
          JSON.stringify({
            reason: error.message,
            stages: error.stages,
            optimal: false,
          }),
        ),
      },
    });
    // A joint run can cover several events; retain a retry target for each.
    // A later run on the same date must not replace or clear an excluded event.
    for (const pool of pools)
      await tx.exceptionCase.upsert({
        where: { key: `matching-solver:event:${pool.eventId}` },
        create: {
          key: `matching-solver:event:${pool.eventId}`,
          kind: "MATCHING",
          objectId: pool.eventId,
          reason: error.message,
        },
        update: { reason: error.message, status: "OPEN", resolvedAt: null },
      });
    return;
  }
  const confirmed: string[] = [],
    tables: string[] = [];
  const allocations: {
    tableId: string;
    eventId: string;
    venueSlotId: string;
    applicationIds: string[];
    reason: string;
  }[] = [];
  const attempted = new Set(eligible.map((a) => a.id));
  for (const a of eligible)
    await audit(tx, "SYSTEM", "MATCH_STARTED", a.id, undefined, {
      eventId,
      runId: run.id,
      matchStatus: "MATCHING",
      factsVersion: 1,
    });
  // Largest groups first is a complete allocation for nested venue capacities.
  for (const proposal of [...result.tables].sort(
    (a, b) => b.members.length - a.members.length,
  )) {
    const venue = venues.find(
      (v) =>
        v.eventId === proposal.eventId &&
        v.capacity >= proposal.members.length &&
        v.tables.length < v.totalTables,
    );
    ensure(venue, "최적해의 식당 재고 재검증에 실패했습니다.");
    const common = [...new Set(proposal.members.flatMap((m) => m.interests))]
      .filter(
        (i) =>
          proposal.members.filter((m) => m.interests.includes(i)).length >= 2,
      )
      .slice(0, 3);
    const reason = `선택한 일정과 나이 조건이 맞는 ${proposal.members.length}명이 모였어요.${common.length ? ` ${common.join(" · ")} 이야기를 함께 나눠보세요.` : ""}`;
    const table = await createAllocatedTable(tx, {
      eventId: proposal.eventId,
      venueSlotId: venue.id,
      applicationIds: proposal.members.map((m) => m.id),
      reason,
      actorId: "SYSTEM",
      runId: run.id,
      source: "AUTO",
      scoring: result.context,
    });
    venue.tables.push(table);
    tables.push(table.id);
    allocations.push({
      tableId: table.id,
      eventId: proposal.eventId,
      venueSlotId: venue.id,
      applicationIds: proposal.members.map((m) => m.id),
      reason,
    });
    confirmed.push(...proposal.members.map((m) => m.id));
  }
  await tx.exceptionCase.updateMany({
    where: {
      key: {
        in: [
          ...pools.map((pool) => `matching-solver:event:${pool.eventId}`),
          ...confirmed.map((id) => `matching:${id}`),
          ...pools
            .filter((pool) => pool.tableCapacities.some((n) => n >= 4))
            .map((pool) => `venue:${pool.eventId}`),
        ],
      },
      status: "OPEN",
    },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolution: "후속 매칭 실행에서 해결되었습니다.",
    },
  });
  const confirmedIds = new Set(confirmed),
    unmatched: string[] = [],
    deferred: string[] = [];
  // An explicit operator retry may clear the eligibility date guard. The
  // immutable per-day miss history still prevents charging another deferral.
  const missedToday = new Set(
    (
      await tx.auditLog.findMany({
        where: {
          objectId: { in: rows.map((a) => a.id) },
          action: { in: ["MATCH_DEFERRED", "MATCH_UNRESOLVED"] },
          after: { path: ["day"], equals: day },
        },
        select: { objectId: true, after: true },
      })
    )
      .filter(
        (log) =>
          ((log.after as { deferredCount?: number } | null)?.deferredCount ??
            0) > 0,
      )
      .map((log) => log.objectId),
  );
  for (const a of rows.filter(
    (a) =>
      !confirmedIds.has(a.id) &&
      (!a.lastDeferredDate || a.lastDeferredDate < day),
  )) {
    const notice = await alternativeNotice(tx, eventId, a.id);
    const invalid = !attempted.has(a.id);
    const venueUnavailable =
      !invalid &&
      pools.some(
        (pool) =>
          pool.candidates.length >= 4 &&
          pool.candidates.some((candidate) => candidate.id === a.id) &&
          pool.maxParticipants >= 4 &&
          !pool.tableCapacities.some((n) => n >= 4),
      );
    const later = a.options
      .map((o) => o.event)
      .filter(
        (e) =>
          e.startsAt > now &&
          coversEvent(expiries.get(a.id), e.startsAt) &&
          matchDay(e.startsAt) > day &&
          ["OPEN", "MATCHED"].includes(e.status),
      )
      .sort((a, b) => a.matchAt.getTime() - b.matchAt.getTime());
    const pendingSameDay = a.options.some(
      (o) =>
        !eventIds.includes(o.eventId) &&
        matchDay(o.event.startsAt) === day &&
        o.event.startsAt > now &&
        coversEvent(expiries.get(a.id), o.event.startsAt) &&
        o.event.status === "OPEN" &&
        o.event.matchAt > now,
    );
    if (!invalid && pendingSameDay) continue;
    const count = a.deferredCount + (invalid || missedToday.has(a.id) ? 0 : 1);
    // A first miss may wait for an already selected later date. A second miss
    // always offers an explicit choice, even if an individual candidate existed.
    if (
      !invalid &&
      !venueUnavailable &&
      a.deferredCount === 0 &&
      later.length
    ) {
      await tx.application.update({
        where: { id: a.id },
        data: {
          deferredCount: count,
          lastDeferredDate: day,
          matchStatus: "WAITING",
          reason:
            "이번 일정에는 배정되지 않아 선택한 다음 일정에서 우선 배정을 살펴볼게요.",
        },
      });
      await audit(tx, "SYSTEM", "MATCH_DEFERRED", a.id, undefined, {
        day,
        runId: run.id,
        nextEventId: later[0].id,
        deferredCount: count,
        factsVersion: 1,
      });
      await enqueue(
        tx,
        `deferred:${a.id}:${day}`,
        "MATCH",
        { eventId: later[0].id },
        new Date(Math.max(Date.now(), later[0].matchAt.getTime())),
      );
      await notify(
        tx,
        a.userId,
        `deferred:${a.id}:${day}`,
        "선택한 다음 일정을 살펴볼게요",
        "이번 일정에는 조건에 맞는 자리를 배정하지 못했어요. 선택한 다음 일정에서 우선 배정을 살펴볼게요.",
        `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
      );
      deferred.push(a.id);
      continue;
    }
    const reason = invalid
      ? "필수 프로필 또는 참가 자격을 확인하고 있어요."
      : venueUnavailable
        ? "배정 가능한 식당 재고를 운영자가 확인하고 있어요."
        : result.feasibleIds.has(a.id)
          ? "참가 조건과 남은 자리의 경합으로 이번에는 배정하지 못했어요."
          : "선택한 일정에서 참가 조건과 식당 여건을 충족하는 테이블을 찾지 못했어요.";
    await tx.application.update({
      where: { id: a.id },
      data: {
        matchStatus:
          invalid || venueUnavailable ? "EXCEPTION" : "ALTERNATIVE_OFFERED",
        paymentStatus: "REFUND_AVAILABLE",
        reason,
        deferredCount: count,
        lastDeferredDate: day,
      },
    });
    const conditionCollision =
      !invalid &&
      !venueUnavailable &&
      !result.feasibleIds.has(a.id) &&
      pools.some(
        (pool) =>
          pool.candidates.some((c) => c.id === a.id) &&
          pool.candidates.length >= 4 &&
          pool.maxParticipants >= 4 &&
          pool.tableCapacities.some((n) => n >= 4),
      );
    if (
      invalid ||
      conditionCollision ||
      (!venueUnavailable && a.deferredCount > 0)
    )
      await tx.exceptionCase.upsert({
        where: { key: `matching:${a.id}` },
        create: {
          key: `matching:${a.id}`,
          kind: invalid
            ? "DATA"
            : conditionCollision
              ? "CONDITION"
              : "MATCHING",
          objectId: a.id,
          reason,
        },
        update: {
          reason,
          kind: invalid
            ? "DATA"
            : conditionCollision
              ? "CONDITION"
              : "MATCHING",
          status: "OPEN",
          resolvedAt: null,
        },
      });
    await audit(tx, "SYSTEM", "MATCH_UNRESOLVED", a.id, undefined, {
      eventId,
      day,
      runId: run.id,
      deferredCount: count,
      factsVersion: 1,
      failedAt: new Date().toISOString(),
      reason,
    });
    await notify(
      tx,
      a.userId,
      `unmatched:${run.id}:${a.id}`,
      "다음 만남을 선택해 주세요",
      notice.body(reason),
      `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
    );
    unmatched.push(a.id);
  }
  await tx.eventSlot.updateMany({
    where: { id: { in: eventIds }, status: { in: ["OPEN", "MATCHED"] } },
    data: { status: "MATCHED" },
  });
  const outcomes = await tx.application.findMany({
    where: { id: { in: rows.map((a) => a.id) } },
    select: {
      id: true,
      matchStatus: true,
      tableId: true,
      reason: true,
      deferredCount: true,
      lastDeferredDate: true,
    },
    orderBy: { id: "asc" },
  });
  await tx.matchRun.update({
    where: { id: run.id },
    data: {
      status: "DONE",
      completedAt: new Date(),
      result: JSON.parse(
        JSON.stringify({
          confirmed,
          tables,
          allocations,
          outcomes,
          unmatched,
          deferred,
          visited: result.visited,
          proposalCount: result.proposalCount,
          stages: result.stages,
          femaleTarget: result.context.femaleTarget,
          optimal: true,
          limited: false,
        }),
      ),
    },
  });
}
