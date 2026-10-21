import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, type Actor } from "@/server/db";
import { adminView } from "@/server/views";

const admin: Actor = { id: "summary-admin", name: "운영자", role: "ADMIN" };
const operations: Actor = {
  id: "summary-operations",
  name: "운영",
  role: "OPERATIONS",
};
const safety: Actor = { id: "summary-safety", name: "안전", role: "SAFETY" };
const participant: Actor = {
  id: "summary-participant",
  name: "참가자",
  role: "PARTICIPANT",
};

async function application(
  id: string,
  tableId: string | null,
  eventId = "event-a",
) {
  return db.application.create({
    data: {
      id,
      userId: participant.id,
      ticketType: "SINGLE",
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      matchStatus: "CONFIRMED",
      tableId,
      options: { create: { eventId } },
    },
  });
}

beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Wrong database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  for (const actor of [admin, operations, safety, participant])
    await db.user.create({
      data: { ...actor, email: `${actor.id}@test.local` },
    });
  for (const [id, start] of [
    ["event-a", "2030-06-02T15:30:00.000Z"],
    ["event-b", "2030-06-04T15:30:00.000Z"],
  ]) {
    const startsAt = new Date(start);
    await db.eventSlot.create({
      data: {
        id,
        title: id,
        region: "홍대",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 7200000),
        closesAt: new Date(startsAt.getTime() - 86400000),
        matchAt: new Date(startsAt.getTime() - 86400000),
        cancelRefundCutoffAt: new Date(startsAt.getTime() - 172800000),
      },
    });
  }
  const venue = await db.venueSlot.create({
    data: {
      eventId: "event-a",
      name: "배정된 가상 식당",
      address: "시연 주소",
      mapUrl: "https://example.test/map",
      reservationName: "식탁",
      price: 25000,
      dietaryNotes: "시연",
    },
  });
  for (const [id, eventId, status, venueSlotId] of [
    ["a-missing", "event-a", "CONFIRMED", null],
    ["a-assigned", "event-a", "CONFIRMED", venue.id],
    ["a-closed", "event-a", "REALLOCATING", null],
    ["b-missing", "event-b", "CONFIRMED", null],
  ] as const)
    await db.diningTable.create({
      data: {
        id,
        eventId,
        status,
        venueSlotId,
        runId: "test-run",
        score: 0,
        evaluation: {},
        explanation: "집계 fixture",
      },
    });
  await application("a-live", "a-missing");
  await application("a-canceled", "a-missing");
  await db.application.update({
    where: { id: "a-canceled" },
    data: { applicationStatus: "CANCELED", attendanceStatus: "CANCELED_LATE" },
  });
  await application("a-reallocating", "a-missing");
  await db.application.update({
    where: { id: "a-reallocating" },
    data: { matchStatus: "REALLOCATING" },
  });
  await application("a-has-venue", "a-assigned");
  await application("b-live", "b-missing", "event-b");
  for (const [key, kind, objectId, status] of [
    ["a-data", "DATA", "a-live", "OPEN"],
    ["a-condition", "CONDITION", "a-missing", "OPEN"],
    ["a-resolved", "DATA", "a-live", "RESOLVED"],
    ["a-venue", "VENUE", "event-a", "OPEN"],
    ["a-safety", "SAFETY", "a-live", "OPEN"],
    ["b-condition", "CONDITION", "b-live", "OPEN"],
    ["b-venue", "VENUE", "event-b", "OPEN"],
  ])
    await db.exceptionCase.create({
      data: { key, kind, objectId, status, reason: "집계 fixture" },
    });
}, 30000);
afterAll(() => db.$disconnect());

describe("operational dashboard summary", () => {
  it("scopes actual unresolved cases and unassigned tables, including old failed jobs beyond the display limits", async () => {
    await db.notification.create({
      data: {
        id: "old-a-notice",
        userId: participant.id,
        key: "old-a",
        title: "이전 안내",
        body: "fixture",
        href: "/app?tab=detail&application=a-live",
        createdAt: new Date("2030-01-01T00:00:00Z"),
      },
    });
    await db.notification.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        id: `new-b-notice-${i}`,
        userId: participant.id,
        key: `new-b-${i}`,
        title: "최근 안내",
        body: "fixture",
        href: "/app?tab=detail&application=b-live",
        createdAt: new Date("2030-06-01T00:00:00Z"),
      })),
    });
    await db.job.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        id: `new-job-${i}`,
        key: `new-job-${i}`,
        kind: "PUSH",
        payload: {},
        runAt: new Date("2030-06-01T00:00:00Z"),
        status: "DONE",
      })),
    });
    for (const [id, kind, payload, status] of [
      ["old-a-push", "PUSH", { notificationId: "old-a-notice" }, "FAILED"],
      ["old-a-reminder", "REMINDER", { tableId: "a-missing" }, "FAILED"],
      ["old-b-push", "PUSH", { notificationId: "new-b-notice-0" }, "FAILED"],
      ["old-a-start", "START", { tableId: "a-missing" }, "FAILED"],
      ["old-a-done", "REMINDER", { tableId: "a-missing" }, "DONE"],
    ] as const)
      await db.job.create({
        data: {
          id,
          key: id,
          kind,
          payload,
          status,
          runAt: new Date("2030-01-01T00:00:00Z"),
        },
      });
    const a = await adminView(admin, "event-a");
    expect(a.jobs).toHaveLength(200);
    expect(a.jobs.some((job) => job.id === "old-a-push")).toBe(false);
    expect(a.notifications.some((notice) => notice.id === "old-a-notice")).toBe(
      false,
    );
    expect(a.operationalSummary).toEqual({
      unresolvedConditionCases: 2,
      venueCases: 1,
      unassignedVenueTables: 1,
      unassignedVenueApplications: 1,
      noticeFailures: 2,
      sameDayCancellations: 0,
    });
    expect((await adminView(admin, "event-b")).operationalSummary).toEqual({
      unresolvedConditionCases: 1,
      venueCases: 1,
      unassignedVenueTables: 1,
      unassignedVenueApplications: 1,
      noticeFailures: 1,
      sameDayCancellations: 0,
    });
    expect((await adminView(admin)).operationalSummary).toEqual({
      unresolvedConditionCases: 3,
      venueCases: 2,
      unassignedVenueTables: 2,
      unassignedVenueApplications: 2,
      noticeFailures: 3,
      sameDayCancellations: 0,
    });
  });

  it("counts distinct actual KST same-day cancellations from immutable snapshots, with a legacy fallback", async () => {
    const records = [
      // The database transaction began before Korean midnight, while the
      // cancellation instant was after midnight. The saved instant governs.
      [
        "a-canceled",
        "2030-06-02T14:59:59.999Z",
        {
          late: true,
          eventId: "event-a",
          eventStartsAt: "2030-06-02T15:30:00.000Z",
          canceledAt: "2030-06-02T15:00:00.000Z",
        },
      ],
      [
        "a-canceled",
        "2030-06-02T14:59:59.998Z",
        {
          late: true,
          eventId: "event-a",
          eventStartsAt: "2030-06-02T15:30:00.000Z",
          canceledAt: "2030-06-02T15:00:00.000Z",
        },
      ],
      [
        "a-prior-day",
        "2030-06-02T14:59:00.000Z",
        {
          late: true,
          eventId: "event-a",
          eventStartsAt: "2030-06-02T15:30:00.000Z",
          canceledAt: "2030-06-02T14:59:00.000Z",
        },
      ],
      [
        "a-early-day",
        "2030-06-02T15:10:00.000Z",
        {
          late: false,
          eventId: "event-a",
          eventStartsAt: "2030-06-02T15:30:00.000Z",
          canceledAt: "2030-06-02T15:10:00.000Z",
        },
      ],
      ["a-legacy", "2030-06-02T15:05:00.000Z", { late: true }],
      [
        "a-unconfirmed",
        "2030-06-02T15:05:00.000Z",
        {
          late: true,
          eventId: null,
          eventStartsAt: null,
          canceledAt: "2030-06-02T15:05:00.000Z",
        },
      ],
      [
        "b-live",
        "2030-06-04T15:05:00.000Z",
        {
          late: true,
          eventId: "event-b",
          eventStartsAt: "2030-06-04T15:30:00.000Z",
          canceledAt: "2030-06-04T15:05:00.000Z",
        },
      ],
    ] as const;
    for (const id of ["a-prior-day", "a-early-day", "a-legacy"]) {
      await application(id, "a-missing");
      await db.application.update({
        where: { id },
        data: {
          applicationStatus: "CANCELED",
          attendanceStatus:
            id === "a-early-day" ? "CANCELED_EARLY" : "CANCELED_LATE",
        },
      });
    }
    for (const [objectId, createdAt, after] of records)
      await db.auditLog.create({
        data: {
          actorId: participant.id,
          action: "APPLICATION_CANCELED",
          objectId,
          createdAt: new Date(createdAt),
          after,
        },
      });
    // A later relationship import cannot turn a cancellation recorded without
    // any confirmed event into a same-day cancellation of that event.
    await application("a-unconfirmed", "a-missing");
    expect(
      (await adminView(admin, "event-a")).operationalSummary
        ?.sameDayCancellations,
    ).toBe(3);
    expect(
      (await adminView(admin, "event-b")).operationalSummary
        ?.sameDayCancellations,
    ).toBe(1);
    expect(
      (await adminView(admin)).operationalSummary?.sameDayCancellations,
    ).toBe(4);
    await db.eventSlot.update({
      where: { id: "event-a" },
      data: { startsAt: new Date("2030-07-20T15:30:00.000Z") },
    });
    // Two recorded snapshots remain on their original day. Legacy rows have
    // no historical event snapshot and cannot reconstruct the former date.
    expect(
      (await adminView(admin, "event-a")).operationalSummary
        ?.sameDayCancellations,
    ).toBe(2);
  });

  it("returns operational aggregates to operations roles, while safety and participant access stay restricted", async () => {
    const full = await adminView(admin, "event-a");
    expect((await adminView(operations, "event-a")).operationalSummary).toEqual(
      full.operationalSummary,
    );
    const safetyView = await adminView(safety, "event-a");
    expect(safetyView.operationalSummary).toBeNull();
    expect(safetyView.jobs).toEqual([]);
    expect(safetyView.tables).toEqual([]);
    expect(safetyView.metrics).toEqual([]);
    await expect(adminView(participant, "event-a")).rejects.toMatchObject({
      status: 403,
    });
  });
});
