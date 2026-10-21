import { afterAll, beforeEach, expect, it, vi, afterEach } from "vitest";
import { db, atomic, type Actor } from "@/server/db";
import { command } from "@/server/commands";
import { suitableAlternatives } from "@/server/alternative-events";
import { ticketExpiry } from "@/domain/ticket-products";
import { preferenceFulfillment } from "@/domain/matching-policy";
import { noShowMetric } from "@/domain/attendance-metrics";
import { notificationDayMs } from "@/server/notification-timing";
import { participantView, adminView } from "@/server/views";
import {
  inspectAllocation,
  createAllocatedTable,
} from "@/server/table-allocation";
import { previewManualAllocation } from "@/server/manual-allocation";
import { runMatch } from "@/server/match-run";
const admin: Actor = { id: "ai-admin", name: "운영", role: "ADMIN" };
const user = (i = 0): Actor => ({
  id: `ai-u${i}`,
  name: `가상${i}`,
  role: "PARTICIPANT",
});
beforeEach(async () => {
  vi.stubEnv("MATCH_EVALUATOR", "decisions-v1");
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw Error("test DB only");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await db.user.create({ data: { ...admin, email: "ai-admin@example.test" } });
  for (let i = 0; i < 4; i++)
    await db.user.create({
      data: {
        ...user(i),
        email: `ai-u${i}@example.test`,
        profile: {
          create: {
            contact: "01000000000",
            birthYear: 1995,
            gender: i % 2 ? "남성" : "여성",
            occupation: "합성",
            mbti: [i % 2 ? "ENTJ" : "INTJ"],
            interests: ["여행"],
            traits: ["차분한 사람"],
            desiredTraits: ["차분한 사람"],
            budgets: ["2만원"],
            allergies: "없음",
            foodRestrictions: "없음",
            consentVersion: "test",
            consentAt: new Date(),
          },
        },
      },
    });
  const startsAt = new Date(Date.now() + 5 * 86400000);
  for (const id of ["ai-event", "ai-other"])
    await db.eventSlot.create({
      data: {
        id,
        title: id,
        region: "홍대",
        startsAt,
        endsAt: new Date(+startsAt + 7200000),
        closesAt: new Date(+startsAt - 86400000),
        matchAt: new Date(+startsAt - 86400000),
        cancelRefundCutoffAt: new Date(+startsAt - 172800000),
        capacity: 12,
        venues: {
          create: {
            id: `v-${id}`,
            name: "합성 식당",
            address: "가상",
            mapUrl: "https://example.test",
            reservationName: "검사",
            price: 20000,
            capacity: 6,
            totalTables: 3,
            dietaryNotes: "없음",
          },
        },
      },
    });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(() => db.$disconnect());
async function apply(
  i: number,
  ticketType = "SINGLE",
  eventId = "ai-event",
  suffix = "",
) {
  const id = `ai-a${i}${suffix}`;
  await command(user(i), "apply", {
    requestId: id,
    eventIds: [eventId],
    ticketType,
    consent: true,
  });
  await command(user(i), "pay", { applicationId: id, requestId: `p-${id}` });
  return id;
}
it("prices new products, preserves the offer, and refunds only unused membership units", async () => {
  const id = await apply(0, "MEMBERSHIP_1");
  const a = await db.application.findUniqueOrThrow({
    where: { id },
    include: { payments: true },
  });
  expect(a.payments[0].amount).toBe(39600);
  expect((await participantView(user())).ticketBalance).toBe(3);
  await apply(0, "EXISTING", "ai-other", "-second");
  await command(user(), "cancel", { applicationId: id });
  const refund = await db.refund.findFirstOrThrow();
  expect(refund.amount).toBe(29700);
  expect(
    await db.ticketEntry.count({
      where: { key: "reserve:ai-a0-second", units: -1 },
    }),
  ).toBe(1);
  const fresh = await apply(1);
  expect(
    (await db.payment.findFirstOrThrow({ where: { applicationId: fresh } }))
      .amount,
  ).toBe(9900);
  await db.application.create({
    data: {
      id: "old",
      userId: user(2).id,
      ticketType: "SINGLE",
      applicationStatus: "SUBMITTED",
      options: { create: { eventId: "ai-event" } },
    },
  });
  await command(user(2), "pay", {
    applicationId: "old",
    requestId: "old-payment",
  });
  expect(
    (await db.payment.findFirstOrThrow({ where: { applicationId: "old" } }))
      .amount,
  ).toBe(8000);
});
it.each([
  { code: "MEMBERSHIP_3", amount: 118800, units: 12, months: 3 },
  { code: "MEMBERSHIP_6", amount: 237600, units: 24, months: 6 },
])(
  "connects $code price, usable balance, and expiry to its saved offer",
  async (offer) => {
    const before = new Date();
    const id = await apply(0, offer.code);
    const after = new Date();
    const application = await db.application.findUniqueOrThrow({
      where: { id },
      include: { payments: true },
    });
    expect(application.ticketOffer).toMatchObject(offer);
    expect(application.payments).toHaveLength(1);
    expect(application.payments[0].amount).toBe(offer.amount);
    const purchase = await db.ticketEntry.findFirstOrThrow({
      where: { applicationId: id, kind: "PURCHASE" },
    });
    expect(purchase.units).toBe(offer.units);
    expect(+purchase.expiresAt!).toBeGreaterThanOrEqual(
      +ticketExpiry(before, offer.months),
    );
    expect(+purchase.expiresAt!).toBeLessThanOrEqual(
      +ticketExpiry(after, offer.months),
    );
    expect((await participantView(user())).ticketBalance).toBe(offer.units - 1);
  },
);
it("clamps month end in KST and rejects events beyond membership expiry atomically", async () => {
  expect(ticketExpiry(new Date("2026-01-30T16:30:00Z"), 1).toISOString()).toBe(
    "2026-02-27T16:30:00.000Z",
  );
  await db.eventSlot.update({
    where: { id: "ai-event" },
    data: {
      startsAt: new Date(Date.now() + 40 * 86400000),
      endsAt: new Date(Date.now() + 40 * 86400000 + 7200000),
    },
  });
  await expect(apply(0, "MEMBERSHIP_1")).rejects.toThrow("만료");
  expect(await db.payment.count()).toBe(0);
  expect(await db.ticketEntry.count()).toBe(0);
});
it("rechecks ticket validity during manual allocation and automatic matching", async () => {
  for (let i = 0; i < 4; i++) await apply(i);
  await db.ticketEntry.update({
    where: { key: "reserve:ai-a0" },
    data: { expiresAt: new Date(Date.now() + 86400000) },
  });
  const group = {
    eventId: "ai-event",
    venueSlotId: "v-ai-event",
    applicationIds: [0, 1, 2, 3].map((i) => `ai-a${i}`),
  };
  const check = await atomic((tx) => inspectAllocation(tx, group));
  expect(check.issues.join(" ")).toContain("유효기간");
  await atomic((tx) => runMatch(tx, "ai-event"));
  expect(await db.diningTable.count()).toBe(0);
});
it("queues genuine condition collisions and recovers after repair without changing policy", async () => {
  for (let i = 0; i < 4; i++) {
    await apply(i);
    await db.profile.update({
      where: { userId: user(i).id },
      data: {
        gender: "여성",
        mbti: ["INTJ"],
        interests: [`각자 ${i}`],
        desiredTraits: ["없는 성향"],
      },
    });
  }
  await atomic((tx) => runMatch(tx, "ai-event"));
  expect(
    await db.exceptionCase.count({
      where: { kind: "CONDITION", status: "OPEN" },
    }),
  ).toBe(4);
  expect(
    await db.application.count({
      where: { matchStatus: "ALTERNATIVE_OFFERED" },
    }),
  ).toBe(4);
  await db.profile.updateMany({
    data: {
      gender: "기타",
      interests: ["여행"],
      desiredTraits: ["차분한 사람"],
    },
  });
  for (const ex of await db.exceptionCase.findMany({
    where: { kind: "CONDITION" },
  }))
    await command(admin, "retryMatch", { exceptionId: ex.id });
  await atomic((tx) => runMatch(tx, "ai-event"));
  expect(
    await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
  ).toBe(4);
  expect(
    await db.exceptionCase.count({
      where: { kind: "CONDITION", status: "OPEN" },
    }),
  ).toBe(0);
});
it("distinguishes feasible alternatives from blocked, low-quality, and unavailable pools", async () => {
  await apply(0);
  for (let i = 1; i < 4; i++) await apply(i, "SINGLE", "ai-other");
  const inspect = async () =>
    (await suitableAlternatives(db, "ai-a0", "ai-event"))[0];
  expect((await inspect()).status).toBe("FEASIBLE");
  await db.relationship.create({
    data: {
      fromId: "ai-u0",
      toId: "ai-u1",
      kind: "BLOCK",
      active: true,
      sourceId: "test",
    },
  });
  expect((await inspect()).status).toBe("WAITING");
  await db.relationship.deleteMany();
  for (let i = 0; i < 4; i++)
    await db.profile.update({
      where: { userId: user(i).id },
      data: {
        gender: "여성",
        mbti: ["INTJ"],
        interests: [`서로 다른 관심사 ${i}`],
        desiredTraits: ["없는 성향"],
      },
    });
  expect((await inspect()).status).toBe("WAITING");
  await db.venueSlot.update({
    where: { id: "v-ai-other" },
    data: { totalTables: 0 },
  });
  expect((await inspect()).status).toBe("UNAVAILABLE");
});
it("snapshots preference fulfillment and exposes only the owner's private conditions", async () => {
  for (let i = 0; i < 4; i++) await apply(i);
  await db.profile.update({
    where: { userId: "ai-u1" },
    data: { desiredTraits: ["다른 참가자의 비공개 바람"] },
  });
  await atomic((tx) => runMatch(tx, "ai-event"));
  const view = await participantView(user());
  const saved = view.applications[0].table?.preferenceFulfillment;
  expect(saved).toEqual([
    {
      desire: "차분한 사람",
      satisfied: true,
      reason: {
        version: 1,
        kind: "TRAIT",
        matchedCount: 3,
        comparedCount: 3,
        message:
          "원하신 ‘차분한 사람’과 같은 성향으로 분류되는 항목을 프로필에서 선택한 분이 3명 있어요.",
      },
    },
  ]);
  await db.profile.updateMany({
    data: { desiredTraits: ["깊은 대화"], traits: ["활발한 사람"] },
  });
  expect(
    (await participantView(user())).applications[0].table
      ?.preferenceFulfillment,
  ).toEqual(saved);
  expect(JSON.stringify(view.applications[0].table)).not.toContain(
    "desiredTraits",
  );
  expect(JSON.stringify(view.applications[0].table)).not.toContain(
    "다른 참가자의 비공개 바람",
  );
  const c = {
    id: "x",
    userId: "x",
    age: 30,
    gender: "여성",
    mbti: [],
    interests: [],
    traits: ["차분"],
    desiredTraits: ["차분"],
  };
  expect(preferenceFulfillment(c, [c])).toMatchObject([
    {
      desire: "차분",
      satisfied: false,
      reason: { kind: "INSUFFICIENT_DATA", matchedCount: 0 },
    },
  ]);
});
it("requires a registered operator exception, rejects participants, and rechecks closure", async () => {
  for (let i = 0; i < 4; i++) await apply(i);
  const group = {
    eventId: "ai-event",
    venueSlotId: "v-ai-event",
    applicationIds: [0, 1, 2, 3].map((i) => `ai-a${i}`),
  };
  const table = await atomic((tx) =>
    createAllocatedTable(tx, {
      ...group,
      actorId: admin.id,
      source: "AUTO",
      reason: "합성",
    }),
  );
  const plan = {
    operation: "MOVE",
    sourceTableIds: [table.id],
    groups: [group],
    unassignApplicationIds: [],
    reason: "실제 예약 식당 문제",
  };
  expect(
    (await atomic((tx) => previewManualAllocation(tx, admin, plan))).valid,
  ).toBe(false);
  await expect(
    command(user(), "allocationException", {
      tableIds: [table.id],
      reason: plan.reason,
    }),
  ).rejects.toThrow("권한");
  await command(admin, "allocationException", {
    tableIds: [table.id],
    reason: plan.reason,
  });
  const preview = await atomic((tx) =>
    previewManualAllocation(tx, admin, plan),
  );
  expect(preview.valid).toBe(true);
  await db.exceptionCase.updateMany({
    where: { objectId: table.id },
    data: { status: "RESOLVED" },
  });
  await expect(
    command(admin, "manualAllocationCommit", {
      ...plan,
      version: preview.version,
      requestId: "test",
    }),
  ).rejects.toThrow("상태가 변경");
});
it("blocks self-cancellation on the KST meeting day without losing room access", async () => {
  for (let i = 0; i < 4; i++) await apply(i);
  await atomic((tx) => runMatch(tx, "ai-event"));
  const event = await db.eventSlot.findUniqueOrThrow({
    where: { id: "ai-event" },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(event.startsAt);
  await expect(
    command(user(), "cancel", { applicationId: "ai-a0" }),
  ).rejects.toThrow("행사 당일");
  expect(
    (await participantView(user())).applications[0].table?.room,
  ).not.toBeNull();
  await expect(
    command(user(), "recordLateCancellation", {
      applicationId: "ai-a0",
      reason: "확인",
    }),
  ).rejects.toThrow("권한");
  await command(admin, "recordLateCancellation", {
    applicationId: "ai-a0",
    reason: "본인의 실제 당일 불참을 확인했습니다.",
  });
  expect(
    (await db.application.findUniqueOrThrow({ where: { id: "ai-a0" } }))
      .attendanceStatus,
  ).toBe("CANCELED_LATE");
  expect(
    await db.auditLog.count({
      where: {
        actorId: admin.id,
        objectId: "ai-a0",
        action: "APPLICATION_CANCELED",
      },
    }),
  ).toBe(1);
});
it("counts same-day cancellations in the no-show denominator and flags unknown historical dates", () => {
  const startsAt = new Date("2026-10-20T10:00:00Z"),
    endsAt = new Date("2026-10-20T12:00:00Z");
  const row = (attendanceStatus: string, canceledAt: Date | null = null) => ({
    startsAt,
    endsAt,
    attendanceStatus,
    canceledAt,
  });
  expect(
    noShowMetric(
      [
        row("ATTENDED"),
        row("NO_SHOW"),
        row("CANCELED_LATE", new Date("2026-10-20T00:00:00Z")),
        row("CANCELED_LATE", new Date("2026-10-19T14:59:59Z")),
        row("CANCELED_EARLY"),
      ],
      new Date("2026-10-21T00:00:00Z"),
    ),
  ).toMatchObject({ n: 1, d: 3, unknown: 1 });
});
it("limits the minute clock to local demo test databases", () => {
  vi.stubEnv("SIKTAK_NOTIFICATION_MINUTE", "true");
  expect(notificationDayMs()).toBe(60000);
  vi.stubEnv("DEMO_MODE", "false");
  expect(() => notificationDayMs()).toThrow("로컬");
});
it("connects independent no-show counts and explicit allocation traces to admin output", async () => {
  for (let i = 0; i < 4; i++) await apply(i);
  await atomic((tx) => runMatch(tx, "ai-event"));
  const event = await db.eventSlot.findUniqueOrThrow({
    where: { id: "ai-event" },
  });
  const run = await db.matchRun.findFirstOrThrow();
  const result = run.result as any;
  expect(result.allocations[0].applicationIds.sort()).toEqual(
    [0, 1, 2, 3].map((i) => `ai-a${i}`),
  );
  expect(result.outcomes).toHaveLength(4);
  await db.application.update({
    where: { id: "ai-a0" },
    data: { attendanceStatus: "NO_SHOW" },
  });
  await db.application.update({
    where: { id: "ai-a1" },
    data: { attendanceStatus: "ATTENDED" },
  });
  for (const i of [2, 3]) {
    await db.application.update({
      where: { id: `ai-a${i}` },
      data: {
        attendanceStatus: "CANCELED_LATE",
        applicationStatus: "CANCELED",
      },
    });
    await db.auditLog.create({
      data: {
        actorId: admin.id,
        objectId: `ai-a${i}`,
        action: "APPLICATION_CANCELED",
        after: {
          canceledAt: new Date(
            +event.startsAt - (i === 2 ? 0 : 86400000),
          ).toISOString(),
        },
      },
    });
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(+event.endsAt + 1000);
  const view = await adminView(admin);
  expect(view.metrics.find((m) => m.label === "노쇼율")).toMatchObject({
    n: 1,
    d: 3,
    unknown: 0,
  });
});
it("records private deletion requests once and never equates review with completed deletion", async () => {
  await command(user(), "privacyRequest", { scope: "DELETE" });
  await command(user(), "privacyRequest", { scope: "DELETE" });
  const request = await db.exceptionCase.findFirstOrThrow({
    where: { kind: "PRIVACY" },
  });
  expect(await db.exceptionCase.count({ where: { kind: "PRIVACY" } })).toBe(1);
  await expect(
    command(user(1), "privacyReview", {
      exceptionId: request.id,
      note: "검토",
      decision: "REVIEWING",
    }),
  ).rejects.toThrow("관리자");
  await command(admin, "privacyReview", {
    exceptionId: request.id,
    note: "진행 중 권리부터 확인합니다.",
    decision: "REVIEWING",
  });
  expect((await participantView(user())).privacyRequests[0].status).toBe(
    "REVIEWING",
  );
  expect((await participantView(user(1))).privacyRequests).toHaveLength(0);
  await expect(
    command(admin, "resolveException", {
      exceptionId: request.id,
      note: "삭제 완료",
      seconds: 1,
    }),
  ).rejects.toThrow("전용");
  expect(await db.profile.count({ where: { userId: user().id } })).toBe(1);
  await db.user.create({
    data: {
      id: "ai-ops",
      name: "운영",
      role: "OPERATIONS",
      email: "ai-ops@example.test",
    },
  });
  const ops = await adminView({
    id: "ai-ops",
    name: "운영",
    role: "OPERATIONS",
  });
  expect(ops.exceptions.some((e) => e.kind === "PRIVACY")).toBe(false);
  expect(ops.audits.some((a) => a.action.startsWith("PRIVACY_"))).toBe(false);
});
it("rejects a different pending privacy scope instead of silently discarding it", async () => {
  await command(user(), "privacyRequest", { scope: "DELETE" });
  await expect(
    command(user(), "privacyRequest", { scope: "WITHDRAW" }),
  ).rejects.toThrow("다른 종류");
  expect(await db.exceptionCase.count({ where: { kind: "PRIVACY" } })).toBe(1);
  expect(
    await db.auditLog.count({ where: { action: "PRIVACY_REQUESTED" } }),
  ).toBe(1);
});
