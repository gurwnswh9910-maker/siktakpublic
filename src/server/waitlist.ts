import { z } from "zod";
import { randomUUID } from "node:crypto";
import { reservationExpiries, coversEvent } from "./ticket-eligibility";
import { type Tx, type Actor, ensure, audit, admin } from "./db";
import { enqueue, notify } from "./jobs";
import { validateGroup, type Candidate } from "@/domain/matching";
import {
  allocationContext,
  evaluateAllocation,
  retainedTableQuality,
} from "./matching-policy";
import {
  createAllocatedTable,
  retireAllocatedTables,
} from "./table-allocation";
const live = ["CONFIRMED", "WAITLIST_PENDING"];
const open = ["WAITING", "OFFERED"];
const id = z.string().min(1).max(150);
const tableInclude = {
  event: true,
  venueSlot: true,
  applications: {
    where: {
      applicationStatus: "SUBMITTED" as const,
      matchStatus: { in: ["CONFIRMED" as const, "REALLOCATING" as const] },
    },
    include: { user: { include: { profile: true } }, options: true },
  },
};
async function loadTable(tx: Tx, tableId: string) {
  return tx.diningTable.findUnique({
    where: { id: tableId },
    include: tableInclude,
  });
}
type Table = NonNullable<Awaited<ReturnType<typeof loadTable>>>;
async function eligible(tx: Tx, table: Table, applicationId: string) {
  const candidate = await tx.application.findUnique({
    where: { id: applicationId },
    include: { user: { include: { profile: true } }, options: true },
  });
  if (
    !candidate ||
    candidate.applicationStatus !== "SUBMITTED" ||
    !["PAID", "REFUND_AVAILABLE"].includes(candidate.paymentStatus) ||
    candidate.attendanceStatus !== "SCHEDULED" ||
    candidate.matchStatus === "CONFIRMED" ||
    candidate.tableId ||
    candidate.resolution
  )
    return false;
  const rows = [...table.applications, candidate];
  if (
    rows.some(
      (a) =>
        a.attendanceStatus !== "SCHEDULED" ||
        !a.user.profile?.consentAt ||
        !["NONE", "WARNING"].includes(a.user.restriction) ||
        !["PAID", "REFUND_AVAILABLE"].includes(a.paymentStatus) ||
        !a.options.some((o) => o.eventId === table.eventId),
    )
  )
    return false;
  if (!table.venueSlot || rows.length > table.venueSlot.capacity) return false;
  const year = Number(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
    }).format(table.event.startsAt),
  );
  const members: Candidate[] = rows.map((a) => ({
    id: a.id,
    userId: a.userId,
    age: year - a.user.profile!.birthYear,
    gender: a.user.profile!.gender,
    mbti: a.user.profile!.mbti,
    interests: a.user.profile!.interests,
    traits: a.user.profile!.traits,
    desiredTraits: a.user.profile!.desiredTraits,
  }));
  const relations = await tx.relationship.findMany({
    where: {
      active: true,
      fromId: { in: rows.map((a) => a.userId) },
      toId: { in: rows.map((a) => a.userId) },
    },
  });
  if (validateGroup(members, relations).length) return false;
  const expiries = await reservationExpiries(
    tx,
    rows.map((a) => a.id),
  );
  if (rows.some((a) => !coversEvent(expiries.get(a.id), table.event.startsAt)))
    return false;
  const context = await allocationContext(tx, table.event.startsAt, members);
  if (!evaluateAllocation(members, relations, context).passes) return false;
  const conflicts = await tx.application.count({
    where: {
      userId: { in: rows.map((a) => a.userId) },
      applicationStatus: "SUBMITTED",
      id: { notIn: rows.map((a) => a.id) },
      table: {
        status: { in: live },
        event: {
          startsAt: { lt: table.event.endsAt },
          endsAt: { gt: table.event.startsAt },
        },
      },
    },
  });
  if (conflicts) return false;
  const assigned = await tx.application.count({
    where: {
      applicationStatus: "SUBMITTED",
      table: { eventId: table.eventId, status: { in: live } },
    },
  });
  const reserved = await tx.waitlistEntry.count({
    where: {
      eventId: table.eventId,
      status: "OFFERED",
      tableId: { not: table.id },
    },
  });
  if (assigned + reserved + 1 > table.event.capacity) return false;
  return true;
}
export async function closeTableOffers(tx: Tx, tableId: string) {
  const entries = await tx.waitlistEntry.findMany({
    where: { tableId, status: "OFFERED" },
  });
  await tx.waitlistEntry.updateMany({
    where: { tableId, status: "OFFERED" },
    data: { status: "CLOSED" },
  });
  for (const entry of entries)
    await resumeAfterWaitlist(tx, entry.applicationId);
}

async function resumeAfterWaitlist(tx: Tx, applicationId: string) {
  const app = await tx.application.findUnique({
    where: { id: applicationId },
    include: { options: { include: { event: true } } },
  });
  if (
    !app ||
    app.applicationStatus !== "SUBMITTED" ||
    app.paymentStatus !== "PAID" ||
    app.tableId ||
    app.resolution ||
    app.matchStatus === "CONFIRMED"
  )
    return;
  const expiry = (await reservationExpiries(tx, [app.id])).get(app.id);
  const future = app.options
    .map((o) => o.event)
    .filter(
      (e) =>
        e.startsAt > new Date() &&
        ["OPEN", "MATCHED"].includes(e.status) &&
        coversEvent(expiry, e.startsAt),
    )
    .sort((a, b) => a.matchAt.getTime() - b.matchAt.getTime());
  if (future.length) {
    await tx.application.update({
      where: { id: app.id },
      data: {
        matchStatus: "WAITING",
        reason: "대기를 종료하고 선택한 일정의 자동 매칭을 다시 진행합니다.",
      },
    });
    await enqueue(
      tx,
      `waitlist-resume:${app.id}:${randomUUID()}`,
      "MATCH",
      { eventId: future[0].id },
      new Date(Math.max(Date.now(), future[0].matchAt.getTime())),
    );
  } else {
    await tx.application.update({
      where: { id: app.id },
      data: {
        matchStatus: "NO_MATCH",
        paymentStatus: "REFUND_AVAILABLE",
        reason:
          "대기가 종료되었어요. 다른 일정으로 이동하거나 이용권 보관·환불을 선택해 주세요.",
      },
    });
    await notify(
      tx,
      app.userId,
      `waitlist-ended:${app.id}:${randomUUID()}`,
      "대기 종료 안내",
      "대기하던 회차가 마감되었어요. 모임 상세에서 이동·보관·환불을 선택해 주세요.",
      `/app?tab=detail&application=${app.id}`,
    );
  }
  await audit(tx, "SYSTEM", "WAITLIST_RESUMED", app.id, undefined, {
    futureEventId: future[0]?.id ?? null,
  });
}
async function releaseHeld(tx: Tx, table: Table) {
  if (table.status !== "WAITLIST_PENDING") return;
  await closeTableOffers(tx, table.id);
  await tx.diningTable.update({
    where: { id: table.id },
    data: { status: "REALLOCATING" },
  });
  for (const a of table.applications) {
    await tx.application.update({
      where: { id: a.id },
      data: {
        tableId: null,
        matchStatus:
          table.event.startsAt > new Date() ? "REALLOCATING" : "NO_MATCH",
        ...(table.event.startsAt <= new Date()
          ? { paymentStatus: "REFUND_AVAILABLE" as const }
          : {}),
        reason:
          "대기 충원이 마감되어 다른 식탁 또는 이동·보관·환불을 안내합니다.",
      },
    });
    await notify(
      tx,
      a.userId,
      `waitlist-release:${table.id}:${a.id}`,
      "모임 변경 안내",
      "대기 충원이 마감되어 다시 배정하거나 이동·보관·환불을 안내합니다.",
      `/app?tab=detail&application=${a.id}`,
    );
  }
  if (table.event.startsAt > new Date())
    await enqueue(tx, `repair-waitlist:${table.id}`, "MATCH", {
      eventId: table.eventId,
    });
  await audit(tx, "SYSTEM", "WAITLIST_TABLE_RELEASED", table.id);
}
// Called under the same domain transaction as cancellation and worker execution.
export async function advanceWaitlist(
  tx: Tx,
  tableId: string,
): Promise<boolean> {
  const table = await loadTable(tx, tableId);
  if (!table || !live.includes(table.status)) return false;
  const quality = await retainedTableQuality(tx, tableId);
  if (!quality.passes && table.status === "CONFIRMED") {
    await tx.diningTable.update({
      where: { id: tableId },
      data: { status: "WAITLIST_PENDING" },
    });
    table.status = "WAITLIST_PENDING";
    await tx.application.updateMany({
      where: { id: { in: table.applications.map((a) => a.id) } },
      data: {
        matchStatus: "REALLOCATING",
        reason: "참가자 변경 후 조건에 맞는 구성을 다시 확인하고 있어요.",
      },
    });
  }
  const offer = await tx.waitlistEntry.findFirst({
    where: { tableId, status: "OFFERED" },
  });
  const now = new Date();
  if (
    offer &&
    offer.expiresAt &&
    offer.expiresAt > now &&
    table.event.startsAt > now &&
    table.event.status !== "CANCELED" &&
    (await eligible(tx, table, offer.applicationId))
  ) {
    if (!quality.passes) {
      await tx.diningTable.update({
        where: { id: tableId },
        data: { status: "WAITLIST_PENDING" },
      });
      await tx.application.updateMany({
        where: { id: { in: table.applications.map((a) => a.id) } },
        data: {
          matchStatus: "REALLOCATING",
          reason:
            "취소석의 대기 참가자 응답을 기다리고 있어요. 충원 전에는 모임이 확정되지 않습니다.",
        },
      });
    }
    return true;
  }
  if (offer) {
    await tx.waitlistEntry.update({
      where: { id: offer.id },
      data: { status: "EXPIRED" },
    });
    await audit(tx, "SYSTEM", "WAITLIST_EXPIRED", offer.id);
    await resumeAfterWaitlist(tx, offer.applicationId);
  }
  const snapshot = table.evaluation as {
    members?: unknown[];
    waitlistTargetSize?: number;
  };
  const baseline = snapshot.waitlistTargetSize ?? snapshot.members?.length ?? 4;
  if (
    table.event.startsAt <= now ||
    table.event.status === "CANCELED" ||
    table.applications.length < 3 ||
    table.applications.length >= Math.min(6, baseline)
  ) {
    await releaseHeld(tx, table);
    return false;
  }
  const entries = await tx.waitlistEntry.findMany({
    where: { eventId: table.eventId, status: "WAITING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const entry of entries) {
    if (!(await eligible(tx, table, entry.applicationId))) continue;
    const setting = await tx.setting.findUnique({
      where: { key: `waitlist:${table.eventId}` },
    });
    const configured = (setting?.value as { minutes?: number } | null)?.minutes;
    const minutes =
      typeof configured === "number" && configured >= 1 && configured <= 120
        ? configured
        : 30;
    const expiresAt = new Date(
      Math.min(now.getTime() + minutes * 60000, table.event.startsAt.getTime()),
    );
    await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { tableId, status: "OFFERED", expiresAt },
    });
    if (!quality.passes) {
      await tx.diningTable.update({
        where: { id: tableId },
        data: { status: "WAITLIST_PENDING" },
      });
      await tx.application.updateMany({
        where: { id: { in: table.applications.map((a) => a.id) } },
        data: {
          matchStatus: "REALLOCATING",
          reason:
            "취소석의 대기 참가자 응답을 기다리고 있어요. 충원 전에는 모임이 확정되지 않습니다.",
        },
      });
    }
    await enqueue(
      tx,
      `waitlist-offer:${entry.id}:${expiresAt.toISOString()}`,
      "WAITLIST",
      { tableId, eventId: table.eventId },
      expiresAt,
    );
    const app = await tx.application.findUniqueOrThrow({
      where: { id: entry.applicationId },
    });
    await notify(
      tx,
      app.userId,
      `waitlist-offer:${entry.id}:${expiresAt.toISOString()}`,
      "대기하던 식탁에 자리가 생겼어요",
      `${table.event.title} · ${table.event.region}. ${expiresAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}까지 모임 상세에서 수락하거나 거절해 주세요. 응답이 없으면 다음 대기자에게 안내합니다.`,
      `/app?tab=detail&application=${app.id}`,
    );
    await audit(tx, "SYSTEM", "WAITLIST_OFFERED", entry.id, undefined, {
      tableId,
      expiresAt,
    });
    return true;
  }
  await releaseHeld(tx, table);
  return false;
}
export async function withdrawWaitlist(
  tx: Tx,
  applicationId: string,
  status = "WITHDRAWN",
) {
  const entry = await tx.waitlistEntry.findUnique({ where: { applicationId } });
  if (!entry || !open.includes(entry.status)) return;
  await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status } });
  await audit(tx, "SYSTEM", `WAITLIST_${status}`, entry.id);
  await resumeAfterWaitlist(tx, applicationId);
  if (entry.tableId) await advanceWaitlist(tx, entry.tableId);
}
export async function expireEventWaitlist(tx: Tx, eventId: string) {
  const event = await tx.eventSlot.findUnique({ where: { id: eventId } });
  if (!event || (event.startsAt > new Date() && event.status !== "CANCELED"))
    return;
  const tables = await tx.diningTable.findMany({
    where: { eventId, status: "WAITLIST_PENDING" },
    select: { id: true },
  });
  const entries = await tx.waitlistEntry.findMany({
    where: { eventId, status: { in: open } },
  });
  await tx.waitlistEntry.updateMany({
    where: { eventId, status: { in: open } },
    data: { status: "EXPIRED" },
  });
  for (const entry of entries)
    await resumeAfterWaitlist(tx, entry.applicationId);
  for (const t of tables) await advanceWaitlist(tx, t.id);
}
export async function waitlistCommand(
  tx: Tx,
  actor: Actor,
  action: string,
  raw: unknown,
) {
  if (action === "waitlistSetting") {
    admin(actor);
    const p = z
      .object({ eventId: id, minutes: z.number().int().min(1).max(120) })
      .parse(raw);
    ensure(
      await tx.eventSlot.findUnique({ where: { id: p.eventId } }),
      "회차를 찾을 수 없습니다.",
    );
    await tx.setting.upsert({
      where: { key: `waitlist:${p.eventId}` },
      create: { key: `waitlist:${p.eventId}`, value: { minutes: p.minutes } },
      update: { value: { minutes: p.minutes } },
    });
    await audit(tx, actor.id, "WAITLIST_SETTING", p.eventId, undefined, p);
    return { ok: true };
  }
  const p = z
    .object({
      applicationId: id,
      eventId: id.optional(),
      choice: z.enum(["ACCEPT", "DECLINE"]).optional(),
    })
    .parse(raw);
  const app = await tx.application.findUnique({
    where: { id: p.applicationId },
    include: { options: true, user: { include: { profile: true } } },
  });
  ensure(app && app.userId === actor.id, "신청을 찾을 수 없습니다.", 404);
  if (action === "waitlistWithdraw") {
    await withdrawWaitlist(tx, app.id);
    return { ok: true };
  }
  if (action === "waitlistJoin") {
    ensure(
      p.eventId && app.options.some((o) => o.eventId === p.eventId),
      "선택한 회차에만 대기할 수 있습니다.",
    );
    ensure(
      app.applicationStatus === "SUBMITTED" &&
        ["PAID", "REFUND_AVAILABLE"].includes(app.paymentStatus) &&
        !app.resolution &&
        !app.tableId &&
        app.attendanceStatus === "SCHEDULED" &&
        app.matchStatus !== "CONFIRMED",
      "대기 등록 가능한 신청이 아닙니다.",
    );
    ensure(
      app.user.profile?.consentAt &&
        ["NONE", "WARNING"].includes(app.user.restriction),
      "참가 자격을 확인해 주세요.",
    );
    const event = await tx.eventSlot.findUnique({ where: { id: p.eventId } });
    ensure(
      event &&
        event.startsAt > new Date() &&
        ["OPEN", "MATCHED"].includes(event.status),
      "대기가 종료된 회차입니다.",
    );
    const prior = await tx.waitlistEntry.findUnique({
      where: { applicationId: app.id },
    });
    if (prior && open.includes(prior.status)) {
      ensure(prior.eventId === event.id, "기존 대기를 먼저 철회해 주세요.");
      return { ok: true };
    }
    await tx.waitlistEntry.upsert({
      where: { applicationId: app.id },
      create: { applicationId: app.id, eventId: event.id },
      update: {
        eventId: event.id,
        status: "WAITING",
        tableId: null,
        expiresAt: null,
        createdAt: new Date(),
      },
    });
    await enqueue(
      tx,
      `waitlist-close:${event.id}`,
      "WAITLIST",
      { eventId: event.id },
      event.startsAt,
    );
    const tables = await tx.diningTable.findMany({
      where: { eventId: event.id, status: { in: live } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const t of tables) await advanceWaitlist(tx, t.id);
    await audit(tx, actor.id, "WAITLIST_JOINED", app.id, undefined, {
      eventId: event.id,
    });
    return { ok: true };
  }
  ensure(action === "waitlistRespond" && p.choice, "잘못된 대기 요청입니다.");
  const entry = await tx.waitlistEntry.findUnique({
    where: { applicationId: app.id },
  });
  if (entry?.status === "ACCEPTED" && p.choice === "ACCEPT")
    return { ok: true };
  ensure(
    entry?.status === "OFFERED" && entry.tableId && entry.expiresAt,
    "응답할 대기 제안이 없습니다.",
    409,
  );
  if (p.choice === "DECLINE") {
    await withdrawWaitlist(tx, app.id, "DECLINED");
    return { ok: true };
  }
  const table = await loadTable(tx, entry.tableId);
  // Expiry is committed and the next person is notified even for a stale click.
  if (
    !table ||
    entry.expiresAt <= new Date() ||
    table.event.startsAt <= new Date() ||
    table.event.status === "CANCELED" ||
    !live.includes(table.status) ||
    !(await eligible(tx, table, app.id))
  ) {
    await withdrawWaitlist(tx, app.id, "EXPIRED");
    return {
      ok: false,
      message: "제안이 만료되었거나 참가 조건이 변경되었습니다.",
    };
  }
  await tx.waitlistEntry.update({
    where: { id: entry.id },
    data: { status: "ACCEPTED" },
  });
  await retireAllocatedTables(tx, [table.id]);
  const ids = [...table.applications.map((a) => a.id), app.id];
  await tx.application.updateMany({
    where: { id: { in: ids } },
    data: { tableId: null, matchStatus: "REALLOCATING", paymentStatus: "PAID" },
  });
  const replacement = await createAllocatedTable(tx, {
    eventId: table.eventId,
    venueSlotId: table.venueSlotId!,
    applicationIds: ids,
    reason: "대기 참가자 수락으로 식탁을 다시 확정했어요.",
    actorId: actor.id,
    runId: `waitlist:${randomUUID()}`,
    source: "WAITLIST",
  });
  const priorSnapshot = table.evaluation as {
    members?: unknown[];
    waitlistTargetSize?: number;
  };
  await tx.diningTable.update({
    where: { id: replacement.id },
    data: {
      evaluation: {
        ...(replacement.evaluation as object),
        waitlistTargetSize:
          priorSnapshot.waitlistTargetSize ??
          priorSnapshot.members?.length ??
          4,
      },
    },
  });
  await advanceWaitlist(tx, replacement.id);
  await audit(
    tx,
    actor.id,
    "WAITLIST_ACCEPTED",
    entry.id,
    { tableId: table.id },
    { tableId: replacement.id },
  );
  return { ok: true };
}
