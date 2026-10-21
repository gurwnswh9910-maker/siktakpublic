import {
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import webpush from "web-push";
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));
import { db, atomic, Actor } from "@/server/db";
import { command } from "@/server/commands";
import { runMatch } from "@/server/match-run";
import { participantView, adminView } from "@/server/views";
import { tick, execute } from "@/worker/runner";
const operator: Actor = { id: "admin", name: "운영자", role: "ADMIN" };
const actors: Actor[] = Array.from({ length: 9 }, (_, i) => ({
  id: `u${i}`,
  name: `참가자${i}`,
  role: "PARTICIPANT",
}));
async function apply(i: number, eventIds = ["e0"], ticketType = "SINGLE") {
  const id = `a${i}`;
  await command(actors[i], "apply", {
    requestId: id,
    eventIds,
    ticketType,
    consent: true,
  });
  return id;
}
async function pay(i: number) {
  return command(actors[i], "pay", {
    applicationId: `a${i}`,
    requestId: `p${i}`,
  });
}
async function fill(n = 4) {
  for (let i = 0; i < n; i++) {
    await apply(i);
    await pay(i);
  }
}
async function match() {
  await atomic((tx) => runMatch(tx, "e0"));
}
async function drain() {
  for (let i = 0; i < 200 && (await tick()); i++);
}
async function pushFixture() {
  vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic");
  vi.stubEnv("VAPID_PRIVATE_KEY", "synthetic");
  for (const device of ["phone", "tablet"])
    await db.pushSubscription.create({
      data: {
        userId: "u0",
        endpoint: `https://fcm.googleapis.com/lease-${device}`,
        p256dh: "test",
        auth: "test",
      },
    });
  const n = await db.notification.create({
    data: {
      userId: "u0",
      key: "lease-notice",
      title: "알림",
      body: "본문",
      href: "/app",
    },
  });
  return db.job.create({
    data: {
      key: "lease-job",
      kind: "PUSH",
      payload: { notificationId: n.id },
      runAt: new Date(),
    },
  });
}
const pushReceipt = { statusCode: 201, body: "", headers: {} };
beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes("siktak_test"))
    throw new Error("Wrong database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await db.user.create({
    data: {
      id: "admin",
      name: "운영자",
      email: "admin@test.local",
      role: "ADMIN",
    },
  });
  for (let i = 0; i < actors.length; i++)
    await db.user.create({
      data: {
        ...actors[i],
        email: `u${i}@test.local`,
        profile: {
          create: {
            contact: "01000000000",
            birthYear: 1997 + (i % 3),
            gender: i % 2 ? "남성" : "여성",
            occupation: "시연",
            mbti: [i % 2 ? "ENFP" : "INTJ"],
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
  for (let i = 0; i < 2; i++) {
    const start = new Date(Date.now() + (i + 3) * 86400000);
    await db.eventSlot.create({
      data: {
        id: `e${i}`,
        title: "테스트 식탁",
        region: i ? "강남" : "홍대",
        startsAt: start,
        endsAt: new Date(start.getTime() + 7200000),
        closesAt: new Date(start.getTime() - 86400000),
        matchAt: new Date(start.getTime() - 86400000),
        cancelRefundCutoffAt: new Date(start.getTime() - 172800000),
        capacity: 24,
        venues: {
          create: {
            name: "가상 식당",
            address: "시연",
            mapUrl: "https://map.naver.com",
            reservationName: "시연",
            price: 25000,
            capacity: 6,
            totalTables: 5,
            dietaryNotes: "시연",
          },
        },
      },
    });
  }
});
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("persisted participant and operator journeys", () => {
  it.each(["success", "failure"])(
    "ignores stale worker %s after another claim completes",
    async (outcome) => {
      const job = await pushFixture();
      let resolve!: (value: typeof pushReceipt) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<typeof pushReceipt>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      vi.mocked(webpush.sendNotification)
        .mockReset()
        .mockResolvedValue(pushReceipt)
        .mockImplementationOnce(() => pending);
      const oldWorker = tick();
      try {
        await vi.waitFor(() =>
          expect(webpush.sendNotification).toHaveBeenCalledTimes(1),
        );
        await db.job.update({
          where: { id: job.id },
          data: { lockedAt: new Date(Date.now() - 360000) },
        });
        await tick();
        if (outcome === "success") resolve(pushReceipt);
        else reject(new Error("Delayed old delivery failed"));
        await oldWorker;
        expect(
          (await db.job.findUniqueOrThrow({ where: { id: job.id } })).status,
        ).toBe("DONE");
        expect(await db.exceptionCase.count()).toBe(0);
        expect(webpush.sendNotification).toHaveBeenCalledTimes(3);
        expect(
          (
            await db.notification.findUniqueOrThrow({
              where: { key: "lease-notice" },
            })
          ).pushStatus,
        ).toBe("SENT");
      } finally {
        resolve(pushReceipt);
        await oldWorker;
      }
    },
  );
  it("renews the lease while an external delivery is still running", async () => {
    const job = await pushFixture();
    let resolve!: (value: typeof pushReceipt) => void;
    const pending = new Promise<typeof pushReceipt>((yes) => {
      resolve = yes;
    });
    vi.mocked(webpush.sendNotification)
      .mockReset()
      .mockResolvedValue(pushReceipt)
      .mockImplementationOnce(() => pending);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const worker = tick();
    try {
      await vi.waitFor(() =>
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1),
      );
      const old = new Date(Date.now() - 240000);
      await db.job.update({ where: { id: job.id }, data: { lockedAt: old } });
      await vi.advanceTimersByTimeAsync(60000);
      await vi.waitFor(async () => {
        const current = await db.job.findUniqueOrThrow({
          where: { id: job.id },
        });
        expect(current.lockedAt!.getTime()).toBeGreaterThan(old.getTime());
      });
      expect(await tick()).toBe(false);
    } finally {
      resolve(pushReceipt);
      await worker;
      vi.useRealTimers();
    }
  });
  it.each(["report", "block"])(
    "revokes an upcoming shared table immediately after %s",
    async (action) => {
      await fill(6);
      await match();
      const table = await db.diningTable.findFirstOrThrow({
        include: { room: true },
      });
      await command(actors[0], action, {
        applicationId: "a0",
        targetId: "u1",
        reason: "안전 확인",
      });
      for (const actor of [actors[0], actors[1]])
        expect((await participantView(actor)).applications[0].table).toBeNull();
      await expect(
        command(actors[1], "message", {
          roomId: table.room!.id,
          body: "접근 확인",
          requestId: "revoked",
        }),
      ).rejects.toThrow();
      await drain();
      const confirmed = await db.diningTable.findMany({
        where: { status: "CONFIRMED" },
        include: { applications: true },
      });
      expect(
        confirmed.every(
          (t) =>
            !["u0", "u1"].every((id) =>
              t.applications.some((a) => a.userId === id),
            ),
        ),
      ).toBe(true);
      expect(
        (await db.diningTable.findUniqueOrThrow({ where: { id: table.id } }))
          .status,
      ).toBe("REALLOCATING");
    },
  );
  it.each([4, 5])(
    "confirms a smaller group when only %i event seats are available",
    async (capacity) => {
      await fill(6);
      await db.eventSlot.update({ where: { id: "e0" }, data: { capacity } });
      await match();
      expect(
        await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
      ).toBe(capacity);
    },
  );
  it("fits groups to smaller venue tables while preserving usable inventory", async () => {
    await fill(8);
    await db.venueSlot.updateMany({
      where: { eventId: "e0" },
      data: { capacity: 4, totalTables: 2 },
    });
    await match();
    expect(
      await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
    ).toBe(8);
    expect(await db.diningTable.count()).toBe(2);
    expect(await db.exceptionCase.count({ where: { kind: "VENUE" } })).toBe(0);
  });
  it("fits six applicants into a single four-seat venue", async () => {
    await fill(6);
    await db.venueSlot.updateMany({
      where: { eventId: "e0" },
      data: { capacity: 4, totalTables: 1 },
    });
    await match();
    expect(
      await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
    ).toBe(4);
  });
  it("discloses venue details only through the participant's confirmed table", async () => {
    const before = await participantView(actors[0]);
    expect(JSON.stringify(before)).not.toContain("reservationName");
    expect(JSON.stringify(before)).not.toContain("totalTables");
    await fill();
    await match();
    const after = await participantView(actors[0]);
    expect(after.applications[0].table?.venue?.reservationName).toBe("시연");
    expect(
      JSON.stringify((await participantView(actors[8])).events),
    ).not.toContain("reservationName");
  });
  it("never confirms a canceled event and preserves its canceled status", async () => {
    await fill();
    await db.eventSlot.update({
      where: { id: "e0" },
      data: { status: "CANCELED" },
    });
    await match();
    expect(await db.diningTable.count()).toBe(0);
    expect(
      (await db.eventSlot.findUniqueOrThrow({ where: { id: "e0" } })).status,
    ).toBe("CANCELED");
    expect(
      await db.application.count({
        where: { paymentStatus: "REFUND_AVAILABLE" },
      }),
    ).toBe(4);
    await command(actors[0], "resolve", {
      applicationId: "a0",
      choice: "REFUND",
    });
    await drain();
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .paymentStatus,
    ).toBe("REFUNDED");
  });
  it("skips canceled alternatives during automatic reallocation", async () => {
    await apply(0, ["e0", "e1"]);
    await pay(0);
    for (let i = 1; i < 4; i++) {
      await apply(i, ["e1"]);
      await pay(i);
    }
    await db.eventSlot.update({
      where: { id: "e1" },
      data: { status: "CANCELED" },
    });
    await match();
    expect(await db.diningTable.count()).toBe(0);
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .paymentStatus,
    ).toBe("REFUND_AVAILABLE");
    expect(
      (await db.eventSlot.findUniqueOrThrow({ where: { id: "e1" } })).status,
    ).toBe("CANCELED");
  });
  it("offers a resolution when a delayed matching job runs after the event starts", async () => {
    await fill();
    await db.eventSlot.update({
      where: { id: "e0" },
      data: { startsAt: new Date(Date.now() - 1000) },
    });
    await match();
    expect(await db.diningTable.count()).toBe(0);
    expect(
      await db.application.count({
        where: { paymentStatus: "REFUND_AVAILABLE" },
      }),
    ).toBe(4);
    await command(actors[0], "resolve", {
      applicationId: "a0",
      choice: "REFUND",
    });
    await drain();
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .paymentStatus,
    ).toBe("REFUNDED");
  });
  it("finishes a ticket restoration consistently without refunding the original cash purchase", async () => {
    await apply(0, ["e0"], "TRIPLE");
    await pay(0);
    const purchase = await db.payment.findUniqueOrThrow({
      where: { key: "p0" },
    });
    await command(actors[0], "apply", {
      requestId: "reuse",
      eventIds: ["e1"],
      ticketType: "EXISTING",
      consent: true,
    });
    await command(actors[0], "pay", {
      applicationId: "reuse",
      requestId: "reuse-payment",
    });
    await atomic((tx) => runMatch(tx, "e1"));
    await command(actors[0], "resolve", {
      applicationId: "reuse",
      choice: "REFUND",
    });
    await command(actors[0], "resolve", {
      applicationId: "reuse",
      choice: "REFUND",
    });
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "reuse" } }))
        .paymentStatus,
    ).toBe("REFUNDED");
    expect(
      (await db.payment.findUniqueOrThrow({ where: { key: "reuse-payment" } }))
        .status,
    ).toBe("REFUNDED");
    expect(
      (await db.payment.findUniqueOrThrow({ where: { id: purchase.id } }))
        .status,
    ).toBe("PAID");
    expect(await db.refund.count()).toBe(0);
    expect(
      await db.ticketEntry.count({ where: { key: "release:reuse" } }),
    ).toBe(1);
    expect(
      (await participantView(actors[0])).notifications.some(
        (n) => n.title === "이용권이 복원되었어요",
      ),
    ).toBe(true);
    expect(
      await db.auditLog.count({
        where: { action: "TICKET_RESTORED", objectId: "reuse" },
      }),
    ).toBe(1);
  });
  it("detaches only the current user's selected push device, idempotently", async () => {
    for (const [i, device] of [
      [0, "phone"],
      [0, "tablet"],
      [1, "other"],
    ] as const) {
      await command(actors[i], "subscribe", {
        endpoint: `https://fcm.googleapis.com/${device}`,
        keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
      });
    }
    await command(actors[0], "unsubscribe", {
      endpoint: "https://fcm.googleapis.com/other",
    });
    expect(await db.pushSubscription.count()).toBe(3);
    for (let i = 0; i < 2; i++)
      await command(actors[0], "unsubscribe", {
        endpoint: "https://fcm.googleapis.com/phone",
      });
    const remaining = await db.pushSubscription.findMany({
      orderBy: { endpoint: "asc" },
    });
    expect(remaining.map((s) => s.endpoint)).toEqual([
      "https://fcm.googleapis.com/other",
      "https://fcm.googleapis.com/tablet",
    ]);
  });

  it("freezes remaining package tickets as soon as a refund is requested", async () => {
    await apply(0, ["e0"], "TRIPLE");
    await pay(0);
    expect((await participantView(actors[0])).ticketBalance).toBe(2);
    await command(actors[0], "cancel", { applicationId: "a0" });
    await command(actors[0], "apply", {
      requestId: "during-refund",
      eventIds: ["e1"],
      ticketType: "EXISTING",
      consent: true,
    });
    await expect(
      command(actors[0], "pay", {
        applicationId: "during-refund",
        requestId: "reuse-refunding-package",
      }),
    ).rejects.toThrow("사용 가능한 이용권이 없습니다.");
    expect((await participantView(actors[0])).ticketBalance).toBe(0);
    expect(
      await db.payment.count({ where: { applicationId: "during-refund" } }),
    ).toBe(0);
    await drain();
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .paymentStatus,
    ).toBe("REFUNDED");
    expect((await participantView(actors[0])).ticketBalance).toBe(0);
    expect(await db.refund.count()).toBe(1);
  });

  it("rechecks participation restrictions before creating a payment", async () => {
    await apply(0);
    await db.user.update({
      where: { id: actors[0].id },
      data: { restriction: "BANNED" },
    });
    await expect(pay(0)).rejects.toThrow("현재 참가가 제한된 계정입니다.");
    expect(await db.payment.count()).toBe(0);
    expect(await db.ticketEntry.count()).toBe(0);
  });

  it("rejects payment when all chosen events are no longer open", async () => {
    await apply(0);
    await db.eventSlot.update({
      where: { id: "e0" },
      data: { status: "CANCELED" },
    });
    await expect(pay(0)).rejects.toThrow("신청 마감으로 결제할 수 없습니다.");
    expect(await db.payment.count()).toBe(0);
  });

  it("A01 / A09: creates a complete table, venue, room and notices without duplicates", async () => {
    await fill();
    await match();
    await match();
    const tables = await db.diningTable.findMany({
      include: { room: { include: { messages: true } } },
    });
    expect(tables).toHaveLength(1);
    expect(tables[0].venueSlotId).toBeTruthy();
    expect(tables[0].room?.messages).toHaveLength(1);
    expect(
      await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
    ).toBe(4);
    await drain();
    expect(
      await db.notification.count({
        where: { title: "함께할 식탁이 정해졌어요" },
      }),
    ).toBe(4);
  });
  it("A02: excludes unpaid and failed payments; retry is persistent", async () => {
    // Retry remains possible for the other chosen event that is still open.
    for (let i = 0; i < 5; i++) await apply(i, ["e0", "e1"]);
    for (let i = 0; i < 3; i++) await pay(i);
    await command(actors[3], "pay", {
      applicationId: "a3",
      requestId: "bad",
      simulateFailure: true,
    });
    await match();
    expect(await db.diningTable.count()).toBe(0);
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a3" } }))
        .paymentStatus,
    ).toBe("FAILED");
    await pay(3);
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a3" } }))
        .paymentStatus,
    ).toBe("PAID");
  });
  it("A08: duplicate payment and concurrent resolution cannot mint duplicate rights", async () => {
    await apply(0);
    await Promise.all([pay(0), pay(0)]);
    expect(await db.payment.count({ where: { status: "PAID" } })).toBe(1);
    await match();
    const results = await Promise.allSettled([
      command(actors[0], "resolve", { applicationId: "a0", choice: "KEEP" }),
      command(actors[0], "resolve", { applicationId: "a0", choice: "REFUND" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const kept = results[0].status === "fulfilled";
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .resolution,
    ).toBe(kept ? "KEEP" : "REFUND");
    expect((await participantView(actors[0])).ticketBalance).toBe(kept ? 1 : 0);
    expect(await db.refund.count()).toBe(kept ? 0 : 1);
  });
  it("A07 / A08: service failure refund works after voluntary cancellation cutoff", async () => {
    await apply(0);
    await pay(0);
    await db.eventSlot.update({
      where: { id: "e0" },
      data: { cancelRefundCutoffAt: new Date(Date.now() - 1000) },
    });
    await match();
    await Promise.all([
      command(actors[0], "resolve", { applicationId: "a0", choice: "REFUND" }),
      command(actors[0], "resolve", { applicationId: "a0", choice: "REFUND" }),
    ]);
    await drain();
    expect(await db.refund.count()).toBe(1);
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .paymentStatus,
    ).toBe("REFUNDED");
    expect((await participantView(actors[0])).ticketBalance).toBe(0);
  });
  it("A06 / A07: transfer requires a choice and preserves payment with a matching history", async () => {
    await apply(0);
    await pay(0);
    await match();
    await command(actors[0], "resolve", {
      applicationId: "a0",
      choice: "TRANSFER",
      eventId: "e1",
    });
    const a = await db.application.findUniqueOrThrow({
      where: { id: "a0" },
      include: { options: true },
    });
    expect(a.matchStatus).toBe("WAITING");
    expect(a.options.map((x) => x.eventId)).toEqual(["e1"]);
    expect(await db.payment.count()).toBe(1);
    expect(
      await db.auditLog.count({ where: { action: "MATCH_TRANSFERRED" } }),
    ).toBe(1);
  });
  it("A04 / A15: report immediately separates later matching and hides report contents", async () => {
    await fill();
    await match();
    await command(actors[0], "report", {
      applicationId: "a0",
      targetId: "u1",
      reason: "private safety message",
    });
    const view = JSON.stringify(await participantView(actors[1]));
    expect(view).not.toContain("private safety message");
    expect(view).not.toContain('01000000000","birthYear":1997');
    const relation = await db.relationship.findFirst({
      where: { kind: "REPORT" },
    });
    expect(relation?.active).toBe(true);
    await expect(
      command(actors[1], "message", {
        roomId: (await db.chatRoom.findFirstOrThrow()).id,
        body: "hi",
        requestId: "chat",
      }),
    ).rejects.toThrow("참여 중인 단체방이 아닙니다");
  });
  it("A10: cancellation invalidates a four-person table and revokes room access", async () => {
    await fill();
    await match();
    await command(actors[0], "cancel", { applicationId: "a0" });
    expect((await db.diningTable.findFirstOrThrow()).status).toBe(
      "REALLOCATING",
    );
    expect((await participantView(actors[1])).applications[0].table).toBeNull();
    await drain();
    expect(
      await db.application.count({
        where: { matchStatus: "CONFIRMED", applicationStatus: "SUBMITTED" },
      }),
    ).toBe(0);
  });
  it("A12 / A13 / A14: content, attendance candidates, feedback and future exclusions", async () => {
    await fill();
    await match();
    const t = await db.diningTable.findFirstOrThrow();
    await command(operator, "demoAdvance", { eventId: "e0", phase: "START" });
    await drain();
    expect(await db.message.count({ where: { kind: "CONTENT" } })).toBe(3);
    await command(actors[0], "checkin", { applicationId: "a0" });
    await command(operator, "demoAdvance", { eventId: "e0", phase: "END" });
    await drain();
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a1" } }))
        .attendanceReviewRequired,
    ).toBe(true);
    expect(
      await db.application.count({ where: { attendanceStatus: "NO_SHOW" } }),
    ).toBe(0);
    await command(operator, "attendance", {
      applicationId: "a1",
      status: "ATTENDED",
      reason: "현장에서 참석 확인",
    });
    await command(actors[0], "feedback", {
      applicationId: "a0",
      atmosphere: 5,
      conversation: 4,
      venue: 4,
      returnIntent: true,
      recommend: 8,
      comment: "좋은 저녁",
      liked: [],
      avoided: ["u1"],
    });
    expect(
      (await db.relationship.findFirst({ where: { kind: "AVOID" } }))?.toId,
    ).toBe("u1");
    expect(
      (await participantView(actors[1])).applications[0].feedback,
    ).toBeNull();
    expect(t.id).toBeTruthy();
  });
  it("A15: protects another participant application and operator actions", async () => {
    await apply(0);
    await expect(
      command(actors[1], "pay", { applicationId: "a0", requestId: "attack" }),
    ).rejects.toThrow("신청을 찾을 수 없습니다");
    await expect(adminView(actors[0])).rejects.toThrow("접근 권한");
    await expect(
      command(actors[0], "demoAdvance", { eventId: "e0", phase: "MATCH" }),
    ).rejects.toThrow("접근 권한");
  });
  it("A16: recovers a stale running job", async () => {
    await db.job.create({
      data: {
        key: "recovery",
        kind: "MATCH",
        payload: { eventId: "e0" },
        runAt: new Date(),
        status: "RUNNING",
        lockedAt: new Date(Date.now() - 360000),
      },
    });
    await tick();
    expect(
      (await db.job.findUniqueOrThrow({ where: { key: "recovery" } })).status,
    ).toBe("DONE");
  });
  it("A17: denominators are visible and empty metrics are not fabricated", async () => {
    const view = await adminView(operator);
    expect(view.metrics.every((m) => m.d === 0 && m.value === null)).toBe(true);
    await fill();
    await match();
    const v = await adminView(operator);
    expect(v.metrics.find((m) => m.label === "매칭 성공률")).toMatchObject({
      n: 4,
      d: 4,
      value: 1,
    });
  });
  it("keeps prepaid grants separate from survey choices and supports reuse", async () => {
    await apply(0, ["e0"], "TRIPLE");
    await pay(0);
    expect((await participantView(actors[0])).ticketBalance).toBe(2);
    await match();
    await command(actors[0], "resolve", {
      applicationId: "a0",
      choice: "KEEP",
    });
    expect((await participantView(actors[0])).ticketBalance).toBe(3);
    await command(actors[0], "apply", {
      requestId: "next",
      eventIds: ["e1"],
      ticketType: "EXISTING",
      consent: true,
    });
    await command(actors[0], "pay", {
      applicationId: "next",
      requestId: "next-pay",
    });
    expect((await participantView(actors[0])).ticketBalance).toBe(2);
  });
  it("late check-ins and operator attendance reviews rebuild actual meeting history", async () => {
    await fill();
    await match();
    await command(operator, "demoAdvance", { eventId: "e0", phase: "START" });
    await command(actors[0], "checkin", { applicationId: "a0" });
    await command(operator, "demoAdvance", { eventId: "e0", phase: "END" });
    await drain();
    await command(actors[1], "checkin", { applicationId: "a1" });
    expect(await db.relationship.count({ where: { kind: "MET" } })).toBe(2);
    await command(operator, "attendance", {
      applicationId: "a2",
      status: "ATTENDED",
      reason: "현장 확인",
    });
    expect(await db.relationship.count({ where: { kind: "MET" } })).toBe(6);
    await expect(
      command(actors[0], "cancel", { applicationId: "a0" }),
    ).rejects.toThrow("참석 결과");
  });
  it("keeps historical event metrics after transfer and after more than 200 audit records", async () => {
    await apply(0);
    await pay(0);
    await match();
    await command(actors[0], "resolve", {
      applicationId: "a0",
      choice: "TRANSFER",
      eventId: "e1",
    });
    await db.auditLog.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        actorId: "SYSTEM",
        action: "NOISE",
        objectId: `noise${i}`,
      })),
    });
    const view = await adminView(operator, "e0");
    expect(
      view.metrics.find((m) => m.label === "대체 일정 전환율"),
    ).toMatchObject({ n: 1, d: 1 });
    expect(view.applications.map((a) => a.id)).toContain("a0");
    expect(view.audits).toHaveLength(200);
  });
  it("cannot confirm without venue inventory and recovers after adding inventory", async () => {
    await fill();
    const venue = await db.venueSlot.findFirstOrThrow({
      where: { eventId: "e0" },
    });
    await db.venueSlot.delete({ where: { id: venue.id } });
    await match();
    expect(await db.diningTable.count()).toBe(0);
    expect(
      await db.application.count({ where: { matchStatus: "EXCEPTION" } }),
    ).toBe(4);
    const ex = await db.exceptionCase.findFirstOrThrow({
      where: { kind: "VENUE" },
    });
    await db.venueSlot.create({ data: venue });
    await command(operator, "retryMatch", { exceptionId: ex.id });
    await drain();
    expect(
      await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
    ).toBe(4);
    await command(operator, "resolveException", {
      exceptionId: ex.id,
      note: "식당 재고 보완 후 매칭 완료",
      seconds: 12,
    });
    const view = await adminView(operator, "e0");
    expect(view.metrics.find((m) => m.label === "운영자 개입률")).toMatchObject(
      { n: 4, d: 4 },
    );
    expect(view.metrics.find((m) => m.label === "자동 확정률")).toMatchObject({
      n: 0,
      d: 1,
    });
    expect(view.operatingSeconds).toBe(12);
  });
  it("does not expose operational data or private audit payloads to the safety role", async () => {
    await fill();
    await match();
    const user = await db.user.create({
      data: {
        id: "safety",
        name: "안전담당",
        email: "safety@test.local",
        role: "SAFETY",
      },
    });
    const view = await adminView(user);
    expect(view.applications).toEqual([]);
    expect(view.events).toEqual([]);
    expect(view.jobs).toEqual([]);
    expect(view.metrics).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("PAYMENT_COMPLETED");
    expect(JSON.stringify(view)).not.toContain("01000000000");
  });
  it("A11: push retries escalate only after repeated failure and recover without duplicate notifications", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic");
    vi.stubEnv("VAPID_PRIVATE_KEY", "synthetic");
    await db.pushSubscription.create({
      data: {
        userId: "u0",
        endpoint: "https://fcm.googleapis.com/test-only",
        p256dh: "test",
        auth: "test",
      },
    });
    const n = await db.notification.create({
      data: {
        userId: "u0",
        key: "push-test",
        title: "알림",
        body: "본문",
        href: "/app",
      },
    });
    const job = await db.job.create({
      data: {
        key: "push-test",
        kind: "PUSH",
        payload: { notificationId: n.id },
        runAt: new Date(),
      },
    });
    await db.setting.create({
      data: { key: "automation", value: { maxAttempts: 2, retrySeconds: 1 } },
    });
    vi.mocked(webpush.sendNotification).mockRejectedValue(
      new Error("Temporary delivery failure"),
    );
    await tick();
    expect(await db.exceptionCase.count()).toBe(0);
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
    await tick();
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: job.id } })).status,
    ).toBe("FAILED");
    expect(await db.exceptionCase.count({ where: { kind: "JOB" } })).toBe(1);
    vi.mocked(webpush.sendNotification).mockResolvedValue({
      statusCode: 201,
      body: "",
      headers: {},
    });
    await command(operator, "retryJob", { jobId: job.id });
    await tick();
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: n.id } }))
        .pushStatus,
    ).toBe("SENT");
    await execute(job);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(3);
    expect(await db.notification.count()).toBe(1);
  });
  it.each([1, 2, 3, 4])(
    "A06: reallocates only within consented combinations at priority %i",
    async (rank) => {
      const source = await db.eventSlot.findUniqueOrThrow({
        where: { id: "e0" },
      });
      const targetStart = new Date(
        source.startsAt.getTime() + (rank >= 3 ? 86400000 : 0),
      );
      await db.eventSlot.update({
        where: { id: "e1" },
        data: {
          region: rank % 2 ? "홍대" : "강남",
          startsAt: targetStart,
          endsAt: new Date(targetStart.getTime() + 7200000),
        },
      });
      for (let i = 0; i < 4; i++) {
        await apply(i, i < 3 ? ["e0", "e1"] : ["e1"]);
        await pay(i);
      }
      await match();
      const table = await db.diningTable.findFirstOrThrow();
      expect(table.eventId).toBe("e1");
      expect(
        (table.evaluation as { reallocationRank: number }).reallocationRank,
      ).toBe(rank);
      expect(
        await db.auditLog.count({ where: { action: "REALLOCATED" } }),
      ).toBe(3);
      expect(
        await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
      ).toBe(4);
    },
  );
  it("A06/A10: concurrent overlapping event runs cannot confirm the same person twice", async () => {
    const source = await db.eventSlot.findUniqueOrThrow({
      where: { id: "e0" },
    });
    await db.eventSlot.update({
      where: { id: "e1" },
      data: { startsAt: source.startsAt, endsAt: source.endsAt },
    });
    await fill();
    for (let i = 4; i < 7; i++) {
      await apply(i, ["e1"]);
      await pay(i);
    }
    await command(actors[0], "apply", {
      requestId: "second-intent",
      eventIds: ["e1"],
      ticketType: "SINGLE",
      consent: true,
    });
    await command(actors[0], "pay", {
      applicationId: "second-intent",
      requestId: "second-payment",
    });
    await Promise.all([
      atomic((tx) => runMatch(tx, "e0")),
      atomic((tx) => runMatch(tx, "e1")),
    ]);
    expect(
      await db.application.count({
        where: { userId: "u0", matchStatus: "CONFIRMED" },
      }),
    ).toBe(1);
    expect(await db.diningTable.count()).toBe(1);
  });
  it("A07: no alternative slots still preserves the service-failure refund choice", async () => {
    await apply(0);
    await pay(0);
    await db.eventSlot.updateMany({
      data: { closesAt: new Date(Date.now() - 1000) },
    });
    await match();
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .matchStatus,
    ).toBe("NO_MATCH");
    await command(actors[0], "resolve", {
      applicationId: "a0",
      choice: "REFUND",
    });
    await drain();
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .paymentStatus,
    ).toBe("REFUNDED");
  });
});
