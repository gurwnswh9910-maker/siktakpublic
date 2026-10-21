import { freezeTableContent } from "./content-catalog";
import { reservationExpiries, coversEvent } from "./ticket-eligibility";
import { notificationDayMs } from "./notification-timing";
import { Tx, audit } from "./db";
import { compose, evaluate, Candidate } from "@/domain/matching";
import { enqueue, notify } from "./jobs";
import { eventDateTime } from "@/domain/notification-templates";
import { cancellationNotice } from "@/domain/cancellation-policy";
import { applicationMatchHistory, captureMatchFacts } from "./match-facts";
import {
  alternativeNotice,
  loadNotificationTemplates,
} from "./notification-content";
const active = ["WAITING", "MATCHING", "REALLOCATING"] as const;
export async function runLegacyMatch(tx: Tx, eventId: string) {
  const initial = await tx.eventSlot.findUniqueOrThrow({
    where: { id: eventId },
  });
  const version = process.env.MATCH_EVALUATOR ?? "balanced-v1";
  const templates = await loadNotificationTemplates(tx);
  const run = await tx.matchRun.create({
    data: {
      eventId,
      version,
      status: "RUNNING",
      input: {
        eventId,
        version,
        minimum: version === "demo-full-score-v1" ? 100 : 45,
        ageBasis: "KST calendar year minus birth year",
      },
    },
  });
  const original = await tx.application.findMany({
    where: {
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      matchStatus: { in: [...active] },
      tableId: null,
      OR: [
        { waitlist: null },
        { waitlist: { status: { notIn: ["WAITING", "OFFERED"] } } },
      ],
      options: { some: { eventId } },
    },
    include: { options: { include: { event: true } } },
  });
  const eventIds = new Set(
    original.flatMap((a) => a.options.map((o) => o.eventId)),
  );
  const events = await tx.eventSlot.findMany({
    where: {
      id: { in: [...eventIds] },
      startsAt: { gt: new Date() },
      status: { in: ["OPEN", "MATCHED"] },
    },
  });
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const order = (e: typeof initial) =>
    e.id === eventId
      ? 0
      : day(e.startsAt) === day(initial.startsAt)
        ? e.region === initial.region
          ? 1
          : 2
        : e.region === initial.region
          ? 3
          : 4;
  events.sort(
    (a, b) =>
      order(a) - order(b) ||
      a.startsAt.getTime() - b.startsAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const relations = await tx.relationship.findMany({ where: { active: true } });
  const confirmed: string[] = [];
  const tables: string[] = [];
  let visited = 0,
    limited = false;
  const originalIds = new Set(original.map((a) => a.id));
  await tx.application.updateMany({
    where: { id: { in: [...originalIds] } },
    data: { matchStatus: "MATCHING" },
  });
  for (const a of original)
    await audit(
      tx,
      "SYSTEM",
      "MATCH_STARTED",
      a.id,
      { matchStatus: a.matchStatus },
      { matchStatus: "MATCHING", eventId, runId: run.id, factsVersion: 1 },
    );
  const venueBlocked = new Set<string>();
  const inputs: unknown[] = [];
  for (const event of events) {
    if (event.id !== eventId) {
      const relocating = await tx.application.findMany({
        where: { id: { in: [...originalIds] }, matchStatus: "MATCHING" },
      });
      for (const a of relocating) {
        await tx.application.update({
          where: { id: a.id },
          data: { matchStatus: "REALLOCATING" },
        });
        await audit(
          tx,
          "SYSTEM",
          "REALLOCATION_STARTED",
          a.id,
          { eventId },
          { matchStatus: "REALLOCATING", runId: run.id },
        );
        await notify(
          tx,
          a.userId,
          `reallocating:${run.id}:${a.id}`,
          "다른 식탁을 살펴보고 있어요",
          "선택한 날짜와 지역 안에서 조건에 맞는 만남을 다시 찾고 있어요.",
          `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
        );
      }
    }
    const rows = await tx.application.findMany({
      where: {
        applicationStatus: "SUBMITTED",
        paymentStatus: "PAID",
        matchStatus: { in: [...active] },
        tableId: null,
        OR: [
          { waitlist: null },
          { waitlist: { status: { notIn: ["WAITING", "OFFERED"] } } },
        ],
        options: { some: { eventId: event.id } },
        user: { restriction: { in: ["NONE", "WARNING"] } },
      },
      include: {
        user: { include: { profile: true } },
        options: { include: { event: true } },
      },
    });
    const conflicts = await tx.application.findMany({
      where: {
        applicationStatus: "SUBMITTED",
        matchStatus: { in: ["CONFIRMED", "REALLOCATING"] },
        table: {
          status: { in: ["CONFIRMED", "WAITLIST_PENDING"] },
          event: {
            startsAt: { lt: event.endsAt },
            endsAt: { gt: event.startsAt },
          },
        },
      },
      select: { userId: true },
    });
    const occupied = new Set(conflicts.map((x) => x.userId));
    const year = Number(
      new Intl.DateTimeFormat("en", {
        timeZone: "Asia/Seoul",
        year: "numeric",
      }).format(event.startsAt),
    );
    const expiries = await reservationExpiries(
      tx,
      rows.map((a) => a.id),
    );
    const candidates: Candidate[] = rows
      .filter(
        (a) =>
          a.user.profile &&
          a.user.profile.consentAt &&
          !occupied.has(a.userId) &&
          coversEvent(expiries.get(a.id), event.startsAt),
      )
      .map((a) => ({
        id: a.id,
        userId: a.userId,
        age: year - a.user.profile!.birthYear,
        gender: a.user.profile!.gender,
        mbti: a.user.profile!.mbti,
        interests: a.user.profile!.interests,
        traits: a.user.profile!.traits,
        desiredTraits: a.user.profile!.desiredTraits,
      }));
    for (const row of rows.filter((a) => !a.user.profile)) {
      await tx.application.update({
        where: { id: row.id },
        data: {
          matchStatus: "EXCEPTION",
          reason: "필수 프로필을 확인하고 있어요.",
        },
      });
      await tx.exceptionCase.upsert({
        where: { key: `profile:${row.id}` },
        create: {
          key: `profile:${row.id}`,
          kind: "DATA",
          objectId: row.id,
          reason: "결제된 신청의 필수 프로필 누락",
        },
        update: {},
      });
      await audit(tx, "SYSTEM", "MATCH_UNRESOLVED", row.id, undefined, {
        runId: run.id,
        eventId: event.id,
        factsVersion: 1,
        failedAt: new Date().toISOString(),
        reason: "필수 프로필을 확인하고 있어요.",
      });
    }
    const venues = await tx.venueSlot.findMany({
      where: { eventId: event.id },
      include: {
        tables: {
          where: { status: { in: ["CONFIRMED", "WAITLIST_PENDING"] } },
        },
      },
      orderBy: [{ capacity: "asc" }, { id: "asc" }],
    });
    let assigned = await tx.application.count({
      where: {
        applicationStatus: "SUBMITTED",
        matchStatus: { in: ["CONFIRMED", "REALLOCATING"] },
        table: {
          eventId: event.id,
          status: { in: ["CONFIRMED", "WAITLIST_PENDING"] },
        },
      },
    });
    assigned += await tx.waitlistEntry.count({
      where: { eventId: event.id, status: "OFFERED" },
    });
    const maxParticipants = Math.max(0, event.capacity - assigned);
    const tableCapacities = venues
      .flatMap((v) =>
        Array.from(
          { length: Math.max(0, v.totalTables - v.tables.length) },
          () => v.capacity,
        ),
      )
      .sort((a, b) => b - a);
    const minimum = version === "demo-full-score-v1" ? 100 : 45;
    const capacityResult = compose(candidates, relations, version, minimum, {
      maxParticipants,
    });
    const sizes = capacityResult.tables
      .map((t) => t.members.length)
      .sort((a, b) => b - a);
    const result = sizes.every((size, i) => size <= (tableCapacities[i] ?? 0))
      ? capacityResult
      : compose(candidates, relations, version, minimum, {
          maxParticipants,
          tableCapacities,
        });
    const selected = new Set(
      result.tables.flatMap((t) => t.members.map((m) => m.id)),
    );
    const otherwiseMatched = capacityResult.tables.flatMap((t) => t.members);
    if (otherwiseMatched.length > selected.size) {
      const blocked = otherwiseMatched.filter(
        (m) => originalIds.has(m.id) && !selected.has(m.id),
      );
      blocked.forEach((m) => venueBlocked.add(m.id));
      if (blocked.length)
        await tx.exceptionCase.upsert({
          where: { key: `venue:${event.id}` },
          create: {
            key: `venue:${event.id}`,
            kind: "VENUE",
            objectId: event.id,
            reason:
              "조건에 맞는 가상 식당 재고를 추가한 뒤 매칭을 재시도해 주세요.",
          },
          update: {},
        });
    }
    inputs.push({
      eventId: event.id,
      candidates,
      excludedOccupied: [...occupied],
      generator: "fair-window-resource-v2",
      maxParticipants,
      tableCapacities,
    });
    visited +=
      capacityResult.visited + (result === capacityResult ? 0 : result.visited);
    limited ||= capacityResult.limited || result.limited;
    for (const proposal of result.tables) {
      if (
        !proposal.members.some((m) => originalIds.has(m.id)) &&
        event.id !== eventId
      )
        continue;
      if (assigned + proposal.members.length > event.capacity) continue;
      const venue = venues.find(
        (v) =>
          v.capacity >= proposal.members.length &&
          v.tables.length < v.totalTables,
      );
      if (!venue) {
        proposal.members.forEach((m) => venueBlocked.add(m.id));
        await tx.exceptionCase.upsert({
          where: { key: `venue:${event.id}` },
          create: {
            key: `venue:${event.id}`,
            kind: "VENUE",
            objectId: event.id,
            reason:
              "조건에 맞는 가상 식당 재고를 추가한 뒤 매칭을 재시도해 주세요.",
          },
          update: {},
        });
        continue;
      }
      // Global transaction lock protects this final validation against payment,
      // report, cancellation and profile writes from all domain commands.
      const ids = proposal.members.map((m) => m.id);
      const latest = await tx.application.findMany({
        where: {
          id: { in: ids },
          applicationStatus: "SUBMITTED",
          paymentStatus: "PAID",
          matchStatus: { in: [...active] },
          tableId: null,
          OR: [
            { waitlist: null },
            { waitlist: { status: { notIn: ["WAITING", "OFFERED"] } } },
          ],
          options: { some: { eventId: event.id } },
        },
      });
      if (latest.length !== ids.length) continue;
      const evaluation = evaluate(proposal.members, relations, version);
      if (!evaluation.valid) continue;
      const common = [...new Set(proposal.members.flatMap((m) => m.interests))]
        .filter(
          (x) =>
            proposal.members.filter((m) => m.interests.includes(x)).length >= 2,
        )
        .slice(0, 3);
      const explanation = `선택한 ${event.region} 일정과 나이 조건이 맞는 ${ids.length}명이 모였어요.${common.length ? ` ${common.join(" · ")} 이야기를 함께 나눠보세요.` : ""}`;
      const curation = `${templates.curation}\n${explanation}`;
      for (const a of latest.filter((a) => !originalIds.has(a.id)))
        await audit(tx, "SYSTEM", "MATCH_STARTED", a.id, undefined, {
          matchStatus: "MATCHING",
          eventId: event.id,
          runId: run.id,
          factsVersion: 1,
        });
      const priorAudits = await tx.auditLog.findMany({
        where: { objectId: { in: ids } },
        orderBy: { createdAt: "asc" },
      });
      const confirmedAt = new Date();
      const reallocationReasons = new Map<string, string>();
      const histories = new Map(
        latest.map((a) => {
          const history = applicationMatchHistory(a.id, priorAudits);
          const replacedTable = priorAudits.some(
            (log) => log.objectId === a.id && log.action === "MATCH_CONFIRMED",
          );
          const movedEvent = event.id !== eventId && originalIds.has(a.id);
          if (replacedTable || movedEvent) {
            const reason = replacedTable
              ? "이전 확정 테이블을 대체해 필수 조건을 충족하는 테이블로 다시 확정했어요."
              : "기준 회차에서 확정되지 않아 동의한 다른 날짜·지역 조합으로 배정했어요.";
            reallocationReasons.set(a.id, reason);
            history.reallocationCount =
              history.reallocationCount === null
                ? null
                : history.reallocationCount + 1;
            history.recordedReallocationCount++;
            history.lastReallocationAt = confirmedAt.toISOString();
            history.lastReallocationReason = reason;
          }
          history.confirmedAt = confirmedAt.toISOString();
          history.finalReason = explanation;
          return [a.id, history] as const;
        }),
      );
      const facts = captureMatchFacts({
        event,
        members: proposal.members.map((m) => {
          const row = rows.find((r) => r.id === m.id)!;
          const profile = row.user.profile!;
          return {
            ...m,
            name: row.user.name,
            budgets: profile.budgets,
            foodRestrictions: profile.foodRestrictions,
            allergies: profile.allergies,
            selectedEvents: row.options.map((o) => o.event),
            paymentStatus: row.paymentStatus,
            applicationStatus: row.applicationStatus,
            consented: !!profile.consentAt,
            restriction: row.user.restriction,
            history: histories.get(m.id)!,
          };
        }),
        relations,
        occupiedUserIds: occupied,
        confirmedAt,
        finalReason: explanation,
      });
      if (!Object.values(facts.constraints).every(Boolean)) continue;
      const t = await tx.diningTable.create({
        data: {
          eventId: event.id,
          venueSlotId: venue.id,
          runId: run.id,
          score: evaluation.score,
          createdAt: confirmedAt,
          evaluation: JSON.parse(
            JSON.stringify({
              ...evaluation,
              members: proposal.members,
              reallocationRank: order(event),
              facts,
              foodConditions: rows
                .filter((r) => ids.includes(r.id))
                .map((r) => ({
                  userId: r.userId,
                  budgets: r.user.profile?.budgets,
                  foodRestrictions: r.user.profile?.foodRestrictions,
                  allergies: r.user.profile?.allergies,
                })),
              dietaryNotes: venue.dietaryNotes,
            }),
          ),
          explanation,
          room: { create: {} },
        },
        include: { room: true },
      });
      venue.tables.push(t);
      assigned += ids.length;
      tables.push(t.id);
      confirmed.push(...ids);
      await tx.application.updateMany({
        where: { id: { in: ids } },
        data: {
          matchStatus: "CONFIRMED",
          tableId: t.id,
          reason: explanation,
          resolution: null,
        },
      });
      for (const a of latest) {
        if (reallocationReasons.has(a.id))
          await audit(
            tx,
            "SYSTEM",
            "REALLOCATED",
            a.id,
            { eventId },
            {
              eventId: event.id,
              rank: order(event),
              runId: run.id,
              factsVersion: 1,
              reallocatedAt: confirmedAt.toISOString(),
              reason: reallocationReasons.get(a.id),
            },
          );
        await audit(tx, "SYSTEM", "MATCH_CONFIRMED", a.id, undefined, {
          tableId: t.id,
          runId: run.id,
          version,
          factsVersion: 1,
          confirmedAt: confirmedAt.toISOString(),
          reason: explanation,
        });
        await notify(
          tx,
          a.userId,
          `confirmed:${t.id}:${a.id}`,
          "함께할 식탁이 정해졌어요",
          `${curation}\n${eventDateTime(event.startsAt)} · ${event.region} · ${venue.name}. 모임 상세와 단체방을 확인해 주세요.`,
          `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
        );
      }
      await tx.message.create({
        data: {
          roomId: t.room!.id,
          kind: "SYSTEM",
          key: `welcome:${t.id}`,
          body: `${curation}\n${eventDateTime(event.startsAt)}\n${venue.name} · ${venue.address}\n예약명: ${venue.reservationName} · 식비 약 ${venue.price.toLocaleString()}원, 현장 개별 결제\n가상 식당·모의 예약입니다. 식이 조건은 식당 안내에서 확인해 주세요.\n${cancellationNotice(event.cancelRefundCutoffAt)} 안전 문제는 언제든 신고할 수 있어요.`,
        },
      });
      await enqueue(
        tx,
        `reminder:${t.id}`,
        "REMINDER",
        { tableId: t.id },
        new Date(
          Math.max(Date.now(), event.startsAt.getTime() - notificationDayMs()),
        ),
      );
      await enqueue(
        tx,
        `start:${t.id}`,
        "START",
        { tableId: t.id },
        event.startsAt,
      );
      await enqueue(tx, `end:${t.id}`, "END", { tableId: t.id }, event.endsAt);
      await enqueue(
        tx,
        `feedback-reminder:${t.id}`,
        "FEEDBACK_REMINDER",
        { tableId: t.id },
        new Date(event.endsAt.getTime() + notificationDayMs()),
      );
      await freezeTableContent(tx, t.id);
    }
  }
  const remaining = await tx.application.findMany({
    where: {
      id: { in: [...originalIds] },
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      matchStatus: { in: [...active] },
      tableId: null,
      OR: [
        { waitlist: null },
        { waitlist: { status: { notIn: ["WAITING", "OFFERED"] } } },
      ],
    },
  });
  for (const a of remaining) {
    const notice = await alternativeNotice(tx, eventId, a.id);
    const alternatives = notice.count;
    const exception = venueBlocked.has(a.id);
    const reason = exception
      ? "조건에 맞는 식당을 운영자가 확인하고 있어요. 기다리거나 다른 일정·보관·환불을 선택할 수 있어요."
      : "선택한 일정에서 모든 조건을 충족하는 테이블을 찾지 못했어요.";
    await tx.application.update({
      where: { id: a.id },
      data: {
        matchStatus: exception
          ? "EXCEPTION"
          : alternatives
            ? "ALTERNATIVE_OFFERED"
            : "NO_MATCH",
        paymentStatus: "REFUND_AVAILABLE",
        reason,
      },
    });
    await notify(
      tx,
      a.userId,
      `unmatched:${run.id}:${a.id}`,
      "다음 만남을 선택해 주세요",
      notice.body(reason),
      `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
    );
    await audit(tx, "SYSTEM", "MATCH_UNRESOLVED", a.id, undefined, {
      runId: run.id,
      eventId,
      alternatives,
      factsVersion: 1,
      failedAt: new Date().toISOString(),
      reason,
    });
  }
  // Delayed or canceled runs still settle paid applicants through alternatives
  // and refund choices, but must never reopen a canceled event.
  if (["OPEN", "MATCHED"].includes(initial.status))
    await tx.eventSlot.update({
      where: { id: eventId },
      data: { status: "MATCHED" },
    });
  await tx.matchRun.update({
    where: { id: run.id },
    data: {
      status: "DONE",
      input: JSON.parse(
        JSON.stringify({
          eventId,
          version,
          minimum: version === "demo-full-score-v1" ? 100 : 45,
          ageBasis: "KST calendar year minus birth year",
          slots: inputs,
          relations,
        }),
      ),
      completedAt: new Date(),
      result: {
        confirmed,
        tables,
        unmatched: remaining.map((x) => x.id),
        visited,
        limited,
      },
    },
  });
}
