import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { db, atomic, type Actor } from "@/server/db";
import { command } from "@/server/commands";
import { runMatch } from "@/server/match-run";
import { participantView } from "@/server/views";
import { execute, tick } from "@/worker/runner";
import {
  inspectAllocation,
  createAllocatedTable,
  retireAllocatedTables,
} from "@/server/table-allocation";

const operator: Actor = { id: "wl-admin", name: "대기 운영자", role: "ADMIN" };
const people: Actor[] = Array.from({ length: 8 }, (_, i) => ({
  id: `wl-u${i}`,
  name: `대기 참가자 ${i}`,
  role: "PARTICIPANT",
}));
const appId = (i: number) => `wl-a${i}`;
const entry = (i: number) =>
  db.waitlistEntry.findUniqueOrThrow({ where: { applicationId: appId(i) } });
const respond = (i: number, choice: "ACCEPT" | "DECLINE") =>
  command(people[i], "waitlistRespond", { applicationId: appId(i), choice });
const cancel = (i: number) =>
  command(people[i], "cancel", { applicationId: appId(i) });

beforeEach(async () => {
  // These tests intentionally clear fixtures, so a production URL must fail closed.
  if (new URL(process.env.DATABASE_URL!).pathname !== "/siktak_test")
    throw new Error("Waitlist tests require isolated siktak_test");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await db.user.create({
    data: { ...operator, email: "wl-admin@example.test" },
  });
  for (const [i, person] of people.entries()) {
    await db.user.create({
      data: {
        ...person,
        email: `wl-${i}@example.test`,
        profile: {
          create: {
            contact: "01000000000",
            birthYear: 1997 + (i % 3),
            gender: i % 2 ? "남성" : "여성",
            occupation: "합성 검사",
            mbti: ["ENFP"],
            interests: ["여행", "음식"],
            traits: ["편안한 대화"],
            desiredTraits: ["편안한 대화"],
            budgets: ["2만~3만원"],
            foodRestrictions: "없음",
            allergies: "없음",
            consentVersion: "test",
            consentAt: new Date(),
          },
        },
      },
    });
  }
  const startsAt = new Date(Date.now() + 3 * 86400000);
  await db.eventSlot.create({
    data: {
      id: "wl-event",
      title: "대기 전환 검사",
      region: "홍대",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 7200000),
      closesAt: new Date(startsAt.getTime() - 86400000),
      matchAt: new Date(startsAt.getTime() - 86400000),
      cancelRefundCutoffAt: new Date(startsAt.getTime() - 172800000),
      capacity: 24,
      venues: {
        create: {
          id: "wl-venue",
          name: "가상 식당",
          address: "합성 검사",
          mapUrl: "https://map.naver.com",
          reservationName: "검사",
          price: 25000,
          capacity: 6,
          totalTables: 5,
          dietaryNotes: "검사",
        },
      },
    },
  });
  for (const [i, person] of people.entries()) {
    await command(person, "apply", {
      requestId: appId(i),
      eventIds: ["wl-event"],
      ticketType: "SINGLE",
      consent: true,
    });
    await command(person, "pay", {
      applicationId: appId(i),
      requestId: `wl-pay${i}`,
    });
  }
  // Enrolling before automatic matching must reserve these four people's choice.
  for (let i = 4; i < 8; i++) {
    await command(people[i], "waitlistJoin", {
      applicationId: appId(i),
      eventId: "wl-event",
    });
    await db.waitlistEntry.update({
      where: { applicationId: appId(i) },
      data: {
        id: `wl-entry${i}`,
        createdAt: new Date(1700000000000 + (i - 4) * 1000),
      },
    });
  }
  await atomic((tx) => runMatch(tx, "wl-event"));
});
afterAll(() => db.$disconnect());

async function originalTable() {
  return db.diningTable.findFirstOrThrow({
    where: { eventId: "wl-event", status: "CONFIRMED" },
    include: { room: true },
  });
}
async function offerJob(i: number) {
  const e = await entry(i);
  return db.job.findUniqueOrThrow({
    where: { key: `waitlist-offer:${e.id}:${e.expiresAt!.toISOString()}` },
  });
}
async function expireOffer(i: number) {
  const job = await offerJob(i);
  await db.waitlistEntry.update({
    where: { applicationId: appId(i) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await execute(job);
  return job;
}

async function futureEvent(eventId: string, matchAt: Date) {
  const original = await db.eventSlot.findUniqueOrThrow({
    where: { id: "wl-event" },
  });
  const venue = await db.venueSlot.findUniqueOrThrow({
    where: { id: "wl-venue" },
  });
  const startsAt = new Date(Date.now() + 4 * 86400000);
  const event = await db.eventSlot.create({
    data: {
      ...original,
      id: eventId,
      status: "OPEN",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 7200000),
      matchAt,
      closesAt: new Date(startsAt.getTime() - 86400000),
    },
  });
  await db.venueSlot.create({
    data: { ...venue, id: `${eventId}-venue`, eventId },
  });
  return event;
}

describe("sequential waitlist offers under real domain transactions", () => {
  it("excludes waiting applications from automatic allocation and hides a three-person held table", async () => {
    const old = await originalTable();
    expect(
      await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
    ).toBe(4);
    expect(await db.waitlistEntry.count({ where: { status: "WAITING" } })).toBe(
      4,
    );
    await cancel(0);
    expect(await entry(4)).toMatchObject({
      status: "OFFERED",
      tableId: old.id,
    });
    expect(
      await db.diningTable.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({ status: "WAITLIST_PENDING" });
    expect(
      await db.application.count({
        where: {
          tableId: old.id,
          applicationStatus: "SUBMITTED",
          matchStatus: "REALLOCATING",
        },
      }),
    ).toBe(3);
    const view = await participantView(people[1]);
    expect(view.applications[0].table).toBeNull();
    expect(view.applications[0].matchStatus).toBe("REALLOCATING");
    await atomic((tx) => runMatch(tx, "wl-event"));
    expect(await entry(4)).toMatchObject({
      status: "OFFERED",
      tableId: old.id,
    });
    expect(
      await db.application.count({
        where: { id: { in: [4, 5, 6, 7].map(appId) }, tableId: { not: null } },
      }),
    ).toBe(0);
    expect(await db.diningTable.count({ where: { status: "CONFIRMED" } })).toBe(
      0,
    );
  });

  it("offers in createdAt/ID order, declines then expires through the worker, and accepts into an immutable replacement", async () => {
    const old = await originalTable();
    const payments = await db.payment.findMany({
      where: { applicationId: { in: [1, 2, 3, 6].map(appId) } },
      orderBy: { id: "asc" },
    });
    const ledger = await db.ticketEntry.findMany({
      where: { applicationId: { in: [1, 2, 3, 6].map(appId) } },
      orderBy: { id: "asc" },
    });
    await cancel(0);
    await respond(4, "DECLINE");
    expect((await entry(4)).status).toBe("DECLINED");
    expect((await entry(5)).status).toBe("OFFERED");
    const staleJob = await expireOffer(5);
    expect((await entry(5)).status).toBe("EXPIRED");
    expect((await entry(6)).status).toBe("OFFERED");
    await execute(staleJob); // Retried old work must not skip a fresh live offer.
    expect((await entry(6)).status).toBe("OFFERED");
    expect(
      await db.notification.count({
        where: { userId: people[6].id, key: { startsWith: "waitlist-offer:" } },
      }),
    ).toBe(1);
    expect(await respond(6, "ACCEPT")).toMatchObject({ ok: true });
    const replacement = await originalTable();
    expect(replacement.id).not.toBe(old.id);
    const retained = await db.diningTable.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(retained.status).toBe("REPLACED");
    expect(retained.evaluation).toEqual(old.evaluation);
    expect(
      await db.application.count({
        where: {
          tableId: replacement.id,
          matchStatus: "CONFIRMED",
          applicationStatus: "SUBMITTED",
        },
      }),
    ).toBe(4);
    expect(
      await db.payment.findMany({
        where: { applicationId: { in: [1, 2, 3, 6].map(appId) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(payments);
    expect(
      await db.ticketEntry.findMany({
        where: { applicationId: { in: [1, 2, 3, 6].map(appId) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(ledger);
    await expect(
      command(people[1], "message", {
        roomId: old.room!.id,
        body: "old room",
        requestId: "wl-old-room",
      }),
    ).rejects.toThrow("참여 중인 단체방");
    await command(people[6], "message", {
      roomId: replacement.room!.id,
      body: "new room",
      requestId: "wl-new-room",
    });
    expect(
      await db.auditLog.count({ where: { action: "WAITLIST_ACCEPTED" } }),
    ).toBe(1);
    expect(
      await db.job.count({
        where: {
          status: "PENDING",
          payload: { path: ["tableId"], equals: old.id },
        },
      }),
    ).toBe(0);
  });

  it("breaks equal registration timestamps by entry ID", async () => {
    await db.waitlistEntry.updateMany({
      data: { createdAt: new Date(1700000000000) },
    });
    await cancel(0);
    expect((await entry(4)).status).toBe("OFFERED");
    await respond(4, "DECLINE");
    expect((await entry(5)).status).toBe("OFFERED");
  });

  it("keeps a live offer but hides a table when consecutive cancellations reduce five members to three", async () => {
    const initial = await originalTable();
    await command(people[4], "waitlistWithdraw", { applicationId: appId(4) });
    const five = await atomic(async (tx) => {
      await retireAllocatedTables(tx, [initial.id]);
      await tx.application.updateMany({
        where: { id: { in: [0, 1, 2, 3, 4].map(appId) } },
        data: { tableId: null, matchStatus: "REALLOCATING" },
      });
      return createAllocatedTable(tx, {
        eventId: "wl-event",
        venueSlotId: "wl-venue",
        applicationIds: [0, 1, 2, 3, 4].map(appId),
        actorId: operator.id,
        source: "MANUAL",
        reason: "연속 취소를 검사하는 정상 5인 배정",
      });
    });
    await cancel(0);
    const firstOffer = await entry(5);
    expect(firstOffer).toMatchObject({ status: "OFFERED", tableId: five.id });
    expect(
      await db.diningTable.findUniqueOrThrow({ where: { id: five.id } }),
    ).toMatchObject({ status: "CONFIRMED" });
    await cancel(1);
    expect(await entry(5)).toMatchObject({
      id: firstOffer.id,
      status: "OFFERED",
      tableId: five.id,
      expiresAt: firstOffer.expiresAt,
    });
    expect(
      await db.diningTable.findUniqueOrThrow({ where: { id: five.id } }),
    ).toMatchObject({ status: "WAITLIST_PENDING" });
    expect(
      await db.application.count({
        where: {
          id: { in: [2, 3, 4].map(appId) },
          tableId: five.id,
          matchStatus: "REALLOCATING",
        },
      }),
    ).toBe(3);
    expect((await participantView(people[2])).applications[0].table).toBeNull();
    expect(
      await db.notification.count({
        where: { userId: people[5].id, key: { startsWith: "waitlist-offer:" } },
      }),
    ).toBe(1);
    expect(await respond(5, "ACCEPT")).toMatchObject({ ok: true });
    expect(
      await db.application.count({
        where: {
          id: { in: [2, 3, 4, 5].map(appId) },
          matchStatus: "CONFIRMED",
          table: { status: "CONFIRMED" },
        },
      }),
    ).toBe(4);
    expect(
      await db.diningTable.findUniqueOrThrow({ where: { id: five.id } }),
    ).toMatchObject({ status: "REPLACED" });
  });

  it("serializes concurrent acceptance and preserves one confirmation and one new table", async () => {
    await cancel(0);
    const results = await Promise.all([
      respond(4, "ACCEPT"),
      respond(4, "ACCEPT"),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect((await entry(4)).status).toBe("ACCEPTED");
    expect(await db.diningTable.count({ where: { status: "CONFIRMED" } })).toBe(
      1,
    );
    expect(await db.diningTable.count()).toBe(2);
    expect(
      await db.auditLog.count({ where: { action: "WAITLIST_ACCEPTED" } }),
    ).toBe(1);
    expect(
      await db.notification.count({
        where: { userId: people[4].id, key: { startsWith: "confirmed:" } },
      }),
    ).toBe(1);
    await expect(respond(5, "ACCEPT")).rejects.toThrow("응답할 대기 제안");
  });

  it.each(["waitlistWithdraw", "cancel"])(
    "%s closes the active offer and advances immediately",
    async (action) => {
      await cancel(0);
      await command(people[4], action, { applicationId: appId(4) });
      expect((await entry(4)).status).toBe("WITHDRAWN");
      expect((await entry(5)).status).toBe("OFFERED");
      expect(
        await db.waitlistEntry.count({ where: { status: "OFFERED" } }),
      ).toBe(1);
    },
  );

  it("refund choice abandons a no-match offer and keeps the next candidate available", async () => {
    await db.application.update({
      where: { id: appId(4) },
      data: { matchStatus: "NO_MATCH", paymentStatus: "REFUND_AVAILABLE" },
    });
    await cancel(0);
    await command(people[4], "resolve", {
      applicationId: appId(4),
      choice: "REFUND",
    });
    expect((await entry(4)).status).toBe("WITHDRAWN");
    expect((await entry(5)).status).toBe("OFFERED");
    expect(
      await db.application.findUniqueOrThrow({ where: { id: appId(4) } }),
    ).toMatchObject({ applicationStatus: "CANCELED", resolution: "REFUND" });
    expect(
      await db.refund.count({
        where: { payment: { applicationId: appId(4) } },
      }),
    ).toBe(1);
  });

  it.each(["block", "payment", "consent", "restriction", "canceled"])(
    "rechecks %s immediately before accepting and advances a stale offer",
    async (change) => {
      await cancel(0);
      if (change === "block")
        await db.relationship.create({
          data: {
            fromId: people[4].id,
            toId: people[1].id,
            kind: "BLOCK",
            sourceId: "waitlist-test",
          },
        });
      if (change === "payment")
        await db.application.update({
          where: { id: appId(4) },
          data: { paymentStatus: "REFUNDED" },
        });
      if (change === "consent")
        await db.profile.delete({
          where: { userId: people[4].id },
        });
      if (change === "restriction")
        await db.user.update({
          where: { id: people[4].id },
          data: { restriction: "SUSPENDED" },
        });
      if (change === "canceled")
        await db.application.update({
          where: { id: appId(4) },
          data: { applicationStatus: "CANCELED" },
        });
      expect(await respond(4, "ACCEPT")).toMatchObject({ ok: false });
      expect((await entry(4)).status).toBe("EXPIRED");
      expect((await entry(5)).status).toBe("OFFERED");
      expect(
        await db.application.findUniqueOrThrow({ where: { id: appId(4) } }),
      ).toMatchObject({ tableId: null });
      expect(
        await db.diningTable.count({ where: { status: "CONFIRMED" } }),
      ).toBe(0);
    },
  );

  it("releases an unfillable held table into rematching without showing three people as confirmed", async () => {
    const old = await originalTable();
    await cancel(0);
    for (let i = 5; i < 8; i++)
      await command(people[i], "waitlistWithdraw", { applicationId: appId(i) });
    await respond(4, "DECLINE");
    expect(
      await db.diningTable.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({ status: "REALLOCATING" });
    expect(
      await db.application.count({
        where: {
          id: { in: [1, 2, 3].map(appId) },
          tableId: null,
          matchStatus: "REALLOCATING",
        },
      }),
    ).toBe(3);
    expect(
      await db.job.count({
        where: {
          key: `repair-waitlist:${old.id}`,
          kind: "MATCH",
          status: "PENDING",
        },
      }),
    ).toBe(1);
    expect(await db.diningTable.count({ where: { status: "CONFIRMED" } })).toBe(
      0,
    );
  });

  it("ends all offers at event start and gives both waiting applicants and an undersized table a refund path", async () => {
    const old = await originalTable();
    await cancel(0);
    await db.eventSlot.update({
      where: { id: "wl-event" },
      data: { startsAt: new Date(Date.now() - 1000) },
    });
    const closeJob = await db.job.findUniqueOrThrow({
      where: { key: "waitlist-close:wl-event" },
    });
    await execute(closeJob);
    expect(
      await db.waitlistEntry.count({
        where: { status: { in: ["WAITING", "OFFERED"] } },
      }),
    ).toBe(0);
    expect(
      await db.application.count({
        where: {
          id: { in: [1, 2, 3, 4, 5, 6, 7].map(appId) },
          tableId: null,
          matchStatus: "NO_MATCH",
          paymentStatus: "REFUND_AVAILABLE",
        },
      }),
    ).toBe(7);
    expect(
      await db.diningTable.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({ status: "REALLOCATING" });
    await expect(
      command(people[7], "waitlistJoin", {
        applicationId: appId(7),
        eventId: "wl-event",
      }),
    ).rejects.toThrow("종료된 회차");
    await execute(closeJob);
    expect(
      await db.notification.count({
        where: { key: { startsWith: `waitlist-release:${old.id}:` } },
      }),
    ).toBe(3);
  });

  it("resumes another consented future event when the waitlisted event starts", async () => {
    const next = await futureEvent("wl-next", new Date(Date.now() - 1000));
    await db.applicationOption.createMany({
      data: [4, 5, 6, 7].map((i) => ({
        applicationId: appId(i),
        eventId: next.id,
      })),
    });
    await cancel(0);
    await db.eventSlot.update({
      where: { id: "wl-event" },
      data: { startsAt: new Date(Date.now() - 1000) },
    });
    await execute(
      await db.job.findUniqueOrThrow({
        where: { key: "waitlist-close:wl-event" },
      }),
    );
    expect(
      await db.waitlistEntry.count({
        where: { status: { in: ["WAITING", "OFFERED"] } },
      }),
    ).toBe(0);
    const resume = await db.job.findFirstOrThrow({
      where: {
        kind: "MATCH",
        status: "PENDING",
        payload: { path: ["eventId"], equals: next.id },
      },
    });
    expect(resume.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    await execute(resume);
    expect(
      await db.application.count({
        where: {
          id: { in: [4, 5, 6, 7].map(appId) },
          matchStatus: "CONFIRMED",
          paymentStatus: "PAID",
          table: { eventId: next.id, status: "CONFIRMED" },
        },
      }),
    ).toBe(4);
  });

  it.each(["before", "after"])(
    "withdrawal %s the original match time schedules matching and resolves an unmatched applicant",
    async (phase) => {
      const matchAt = new Date(
        Date.now() + (phase === "before" ? 60000 : -60000),
      );
      const event = await futureEvent("wl-withdraw", matchAt);
      // Isolate a paid queued applicant in a round whose original match is pending or passed.
      await db.applicationOption.deleteMany({
        where: { applicationId: appId(7) },
      });
      await db.applicationOption.create({
        data: { applicationId: appId(7), eventId: event.id },
      });
      await db.waitlistEntry.update({
        where: { applicationId: appId(7) },
        data: { eventId: event.id },
      });
      await command(people[7], "waitlistWithdraw", { applicationId: appId(7) });
      expect((await entry(7)).status).toBe("WITHDRAWN");
      const resume = await db.job.findFirstOrThrow({
        where: {
          kind: "MATCH",
          status: "PENDING",
          payload: { path: ["eventId"], equals: event.id },
        },
      });
      if (phase === "before") expect(resume.runAt).toEqual(matchAt);
      else expect(resume.runAt.getTime()).toBeLessThanOrEqual(Date.now());
      // Advance only Date; database/network timers remain real. This is a local clock test.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(
        new Date(Math.max(Date.now(), resume.runAt.getTime()) + 1),
      );
      try {
        await execute(resume);
      } finally {
        vi.useRealTimers();
      }
      const app = await db.application.findUniqueOrThrow({
        where: { id: appId(7) },
      });
      expect(["NO_MATCH", "ALTERNATIVE_OFFERED"]).toContain(app.matchStatus);
      expect(app.paymentStatus).toBe("REFUND_AVAILABLE");
      await command(people[7], "resolve", {
        applicationId: app.id,
        choice: "REFUND",
      });
      expect(
        await db.application.findUniqueOrThrow({ where: { id: app.id } }),
      ).toMatchObject({ resolution: "REFUND", applicationStatus: "CANCELED" });
    },
  );

  it("reserves an offered seat against automatic and manual allocation capacity", async () => {
    for (let i = 5; i < 8; i++)
      await command(people[i], "waitlistWithdraw", { applicationId: appId(i) });
    const extra: Actor = {
      id: "wl-extra",
      name: "추가 신청자",
      role: "PARTICIPANT",
    };
    const profile = await db.profile.findUniqueOrThrow({
      where: { userId: people[7].id },
    });
    await db.user.create({
      data: { ...extra, email: "wl-extra@example.test" },
    });
    await db.profile.create({ data: { ...profile, userId: extra.id } });
    await db.eventSlot.update({
      where: { id: "wl-event" },
      data: { status: "OPEN", capacity: 7 },
    });
    await command(extra, "apply", {
      requestId: "wl-extra-app",
      eventIds: ["wl-event"],
      ticketType: "SINGLE",
      consent: true,
    });
    await command(extra, "pay", {
      applicationId: "wl-extra-app",
      requestId: "wl-extra-pay",
    });
    await cancel(0);
    expect((await entry(4)).status).toBe("OFFERED");
    const group = {
      eventId: "wl-event",
      venueSlotId: "wl-venue",
      applicationIds: [...[5, 6, 7].map(appId), "wl-extra-app"],
    };
    const preview = await atomic((tx) => inspectAllocation(tx, group));
    expect(preview.issues.join(" ")).toContain("정원");
    await expect(
      atomic((tx) =>
        createAllocatedTable(tx, {
          ...group,
          reason: "대기 예약 정원 초과 검사",
          actorId: operator.id,
          source: "MANUAL",
        }),
      ),
    ).rejects.toThrow("정원");
    await atomic((tx) => runMatch(tx, "wl-event"));
    expect(
      await db.diningTable.count({
        where: { eventId: "wl-event", status: "CONFIRMED" },
      }),
    ).toBe(0);
    expect((await entry(4)).status).toBe("OFFERED");
    expect(await respond(4, "ACCEPT")).toMatchObject({ ok: true });
    expect(
      await db.application.count({
        where: { applicationStatus: "SUBMITTED", matchStatus: "CONFIRMED" },
      }),
    ).toBe(4);
  });

  it("recovers an abandoned expiry job and does not notify the next candidate twice", async () => {
    await cancel(0);
    const job = await offerJob(4);
    await db.waitlistEntry.update({
      where: { applicationId: appId(4) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await db.job.updateMany({
      where: { id: { not: job.id } },
      data: { status: "CANCELED" },
    });
    await db.job.update({
      where: { id: job.id },
      data: {
        status: "RUNNING",
        claimToken: "abandoned-waitlist-claim",
        attempts: 1,
        lockedAt: new Date(Date.now() - 360000),
        runAt: new Date(Date.now() - 360000),
      },
    });
    await tick();
    expect(
      await db.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({ status: "DONE", attempts: 2, lastError: null });
    expect((await entry(4)).status).toBe("EXPIRED");
    expect((await entry(5)).status).toBe("OFFERED");
    await execute(job);
    expect(
      await db.notification.count({
        where: { userId: people[5].id, key: { startsWith: "waitlist-offer:" } },
      }),
    ).toBe(1);
  });

  it("enforces ownership, payment, consented dates and operator-only response settings", async () => {
    await expect(
      command(people[0], "waitlistWithdraw", { applicationId: appId(4) }),
    ).rejects.toThrow("신청을 찾을 수 없습니다");
    await expect(
      command(people[0], "waitlistJoin", {
        applicationId: appId(0),
        eventId: "wl-event",
      }),
    ).rejects.toThrow("대기 등록 가능한 신청");
    await expect(
      command(people[4], "waitlistSetting", {
        eventId: "wl-event",
        minutes: 1,
      }),
    ).rejects.toThrow();
    await expect(
      command(people[4], "waitlistJoin", {
        applicationId: appId(4),
        eventId: "another-event",
      }),
    ).rejects.toThrow("선택한 회차");
    await command(operator, "waitlistSetting", {
      eventId: "wl-event",
      minutes: 1,
    });
    const before = Date.now();
    await cancel(0);
    const offered = await entry(4);
    expect(offered.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 60000);
    expect(offered.expiresAt!.getTime()).toBeLessThanOrEqual(
      Date.now() + 60000,
    );
    await expect(
      command(operator, "waitlistSetting", { eventId: "wl-event", minutes: 0 }),
    ).rejects.toThrow();
    await expect(
      command(operator, "waitlistSetting", {
        eventId: "wl-event",
        minutes: 121,
      }),
    ).rejects.toThrow();
  });
});
