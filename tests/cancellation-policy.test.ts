import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cancellationCutoff,
  cancellationNotice,
  isCancellationRestricted,
} from "@/domain/cancellation-policy";
import { atomic, db, type Actor } from "@/server/db";
import { command } from "@/server/commands";
import { runMatch } from "@/server/match-run";
import { participantView } from "@/server/views";
import { execute } from "@/worker/runner";

const day = 86400000;
const base = new Date("2030-06-01T15:00:00.000Z");
const actors: Actor[] = Array.from({ length: 4 }, (_, i) => ({
  id: `cancel-user-${i}`,
  name: `취소 검증 ${i}`,
  role: "PARTICIPANT",
}));

describe("saved cancellation policy", () => {
  it("uses the earliest selected cutoff before confirmation and the assigned event afterward", () => {
    const options = [
      { event: { cancelRefundCutoffAt: "2030-06-03T09:00:00.000Z" } },
      { event: { cancelRefundCutoffAt: "2030-06-01T15:00:00.000Z" } },
    ];
    expect(cancellationCutoff({ options })?.toISOString()).toBe(
      "2030-06-01T15:00:00.000Z",
    );
    expect(
      cancellationCutoff({
        options,
        table: { event: options[0].event },
      })?.toISOString(),
    ).toBe("2030-06-03T09:00:00.000Z");
    expect(cancellationCutoff({ options: [] })).toBeNull();
  });

  it("includes the exact stored cutoff in Korea time across the UTC date boundary", () => {
    const copy = cancellationNotice("2030-06-01T15:00:00.001Z");
    expect(copy).toContain("2030년 6월 2일");
    expect(copy).toContain("오전 12:00:00.001");
    expect(copy).toContain("(한국 시간)부터 변심 환불이 제한됩니다.");
    expect(copy).not.toContain("2일 전");
    expect(cancellationNotice(null)).toContain("일정을 선택하면");
  });

  it("restricts exactly at the saved instant, with no invented cutoff for an empty draft", () => {
    expect(isCancellationRestricted(base, new Date(base.getTime() - 1))).toBe(
      false,
    );
    expect(isCancellationRestricted(base, base)).toBe(true);
    expect(
      isCancellationRestricted(
        base.toISOString(),
        new Date(base.getTime() + 1),
      ),
    ).toBe(true);
    expect(isCancellationRestricted(null, base)).toBe(false);
  });
});

describe("cancellation commands and saved notices", () => {
  beforeEach(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!url.pathname.endsWith("_test")) throw new Error("Wrong database");
    // Only Date is controlled: Prisma's I/O and transaction timers remain real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(base);
    await db.$executeRawUnsafe(
      'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
    );
    for (const [i, actor] of actors.entries())
      await db.user.create({
        data: {
          ...actor,
          email: `${actor.id}@test.local`,
          profile: {
            create: {
              contact: "01000000000",
              birthYear: 1995,
              gender: i % 2 ? "남성" : "여성",
              occupation: "시연",
              mbti: [i % 2 ? "ENFP" : "INTJ"],
              interests: ["음식", "여행"],
              traits: ["편안한 대화"],
              desiredTraits: ["편안한 대화"],
              budgets: ["2만~3만원"],
              foodRestrictions: "없음",
              allergies: "없음",
              consentVersion: "test",
              consentAt: base,
            },
          },
        },
      });
    for (const [i, id] of ["early", "later"].entries()) {
      const startsAt = new Date(base.getTime() + (3 + i) * day);
      await db.eventSlot.create({
        data: {
          id,
          title: `${id} 취소 검증`,
          region: "홍대",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 2 * 3600000),
          closesAt: new Date(startsAt.getTime() - day),
          matchAt: new Date(startsAt.getTime() - day),
          cancelRefundCutoffAt: new Date(startsAt.getTime() - 2 * day),
          venues: {
            create: {
              name: `가상 식당 ${id}`,
              address: "시연 주소",
              mapUrl: "https://maps.google.com/?q=Hongdae",
              capacity: 6,
              totalTables: 2,
              price: 25000,
              dietaryNotes: "시연",
              reservationName: "우연한 식탁",
            },
          },
        },
      });
    }
  }, 30000);
  afterEach(() => vi.useRealTimers());
  afterAll(() => db.$disconnect());

  async function applyAndPay(index = 0, eventIds = ["early"]) {
    const applicationId = `cancel-app-${index}`;
    await command(actors[index], "apply", {
      requestId: applicationId,
      eventIds,
      ticketType: "SINGLE",
      consent: true,
    });
    await command(actors[index], "pay", {
      applicationId,
      requestId: `cancel-payment-${index}`,
    });
    return applicationId;
  }

  it("records selected dates, payment methods and per-event deadlines without inventing a stricter combined deadline", async () => {
    await db.eventSlot.update({
      where: { id: "early" },
      data: { closesAt: new Date(base.getTime() + 3600000) },
    });
    await db.eventSlot.update({
      where: { id: "later" },
      data: { closesAt: new Date(base.getTime() + 2 * 3600000) },
    });
    for (let i = 0; i < 2; i++)
      await command(actors[i], "apply", {
        requestId: `cancel-app-${i}`,
        eventIds: ["later", "early"],
        ticketType: "SINGLE",
        consent: true,
      });
    const submitted = await db.notification.findUniqueOrThrow({
      where: { key: "submitted:cancel-app-0" },
    });
    const pending = await db.notification.findUniqueOrThrow({
      where: { key: "payment-pending:cancel-app-0" },
    });
    for (const notice of [submitted, pending]) {
      expect(notice.userId).toBe(actors[0].id);
      expect(notice.href).toBe("/app?tab=detail&application=cancel-app-0");
      expect(notice.body).toContain(
        "early 취소 검증 · 2030년 6월 5일 수 오전 12:00 · 홍대",
      );
      expect(notice.body).toContain(
        "later 취소 검증 · 2030년 6월 6일 목 오전 12:00 · 홍대",
      );
    }
    expect(submitted.body).toContain("참가권: 1회권 9,900원");
    expect(submitted.body).toContain("프로필 수정하기");
    expect(submitted.body).toContain("신청 취소 기록하기");
    expect(pending.body).toContain("모의 결제 완료하기");
    expect(pending.body).toContain("실제 금전 거래는 없습니다");
    expect(pending.body).toContain("결제 마감: 2030년 6월 2일 일 오전 1:00");
    expect(pending.body).toContain("결제 마감: 2030년 6월 2일 일 오전 2:00");
    vi.setSystemTime(base.getTime() + 90 * 60000);
    await command(actors[0], "pay", {
      applicationId: "cancel-app-0",
      requestId: "first-paid",
    });
    const paid = await db.notification.findUniqueOrThrow({
      where: { key: "paid:cancel-app-0" },
    });
    expect(paid.body).toContain("결제가 완료되었어요");
    expect(paid.body).toContain(
      "자동 매칭 예약: 2030년 6월 4일 화 오전 12:00 (한국 시간)",
    );
    expect(paid.body).toContain(
      "자동 매칭 예약: 2030년 6월 5일 수 오전 12:00 (한국 시간)",
    );
    vi.setSystemTime(base.getTime() + 2 * 3600000);
    await expect(
      command(actors[1], "pay", {
        applicationId: "cancel-app-1",
        requestId: "too-late",
      }),
    ).rejects.toThrow("신청 마감으로 결제할 수 없습니다.");
  });

  it.each([
    ["default 48 hours", -1, false],
    ["default 48 hours", 0, true],
    ["default 48 hours", 1, true],
    ["custom saved cutoff", -1, false],
    ["custom saved cutoff", 0, true],
    ["custom saved cutoff", 1, true],
  ] as const)(
    "enforces %s at offset %i ms",
    async (kind, offset, restricted) => {
      const applicationId = await applyAndPay();
      const cutoff = new Date(
        base.getTime() + (kind === "default 48 hours" ? day : 17 * 3600000),
      );
      if (kind === "custom saved cutoff")
        await db.eventSlot.update({
          where: { id: "early" },
          data: { cancelRefundCutoffAt: cutoff },
        });
      vi.setSystemTime(cutoff.getTime() + offset);
      const before = (await participantView(actors[0])).applications[0];
      expect(cancellationCutoff(before)?.toISOString()).toBe(
        cutoff.toISOString(),
      );
      expect(isCancellationRestricted(cancellationCutoff(before))).toBe(
        restricted,
      );
      await command(actors[0], "cancel", { applicationId });
      const after = await db.application.findUniqueOrThrow({
        where: { id: applicationId },
      });
      expect(after.attendanceStatus).toBe(
        restricted ? "CANCELED_LATE" : "CANCELED_EARLY",
      );
      expect(after.paymentStatus).toBe(
        restricted ? "PAID" : "REFUND_REQUESTED",
      );
      expect(await db.refund.count()).toBe(restricted ? 0 : 1);
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "APPLICATION_CANCELED", objectId: applicationId },
      });
      expect(audit.after).toEqual({
        late: restricted,
        eventId: null,
        eventStartsAt: null,
        canceledAt: new Date(cutoff.getTime() + offset).toISOString(),
      });
    },
  );

  it("uses the earliest cutoff for an unconfirmed multi-date application", async () => {
    await applyAndPay(0, ["later", "early"]);
    vi.setSystemTime(base.getTime() + day);
    const view = (await participantView(actors[0])).applications[0];
    expect(cancellationCutoff(view)?.toISOString()).toBe(
      "2030-06-02T15:00:00.000Z",
    );
    await command(actors[0], "cancel", { applicationId: view.id });
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: view.id } }))
        .attendanceStatus,
    ).toBe("CANCELED_LATE");
    expect(await db.refund.count()).toBe(0);
  });

  it("uses the selected table cutoff after real confirmation, including welcome and reminder copies", async () => {
    await applyAndPay(0, ["early", "later"]);
    for (let i = 1; i < actors.length; i++) await applyAndPay(i, ["later"]);
    const cutoff = new Date(base.getTime() + 2 * day + 7 * 3600000);
    await db.eventSlot.update({
      where: { id: "later" },
      data: { cancelRefundCutoffAt: cutoff },
    });
    await atomic((tx) => runMatch(tx, "later"));
    vi.setSystemTime(base.getTime() + day);
    const view = (await participantView(actors[0])).applications[0];
    expect(view.table?.event.id).toBe("later");
    expect(cancellationCutoff(view)?.toISOString()).toBe(
      "2030-06-03T22:00:00.000Z",
    );
    const expectedCopy =
      "2030년 6월 4일 화 오전 7:00 (한국 시간)부터 변심 환불이 제한됩니다.";
    const welcome = await db.message.findFirstOrThrow({
      where: { key: { startsWith: "welcome:" } },
    });
    expect(welcome.body).toContain(expectedCopy);
    expect(welcome.body).not.toContain("행사 2일 전");
    const reminder = await db.job.findFirstOrThrow({
      where: { kind: "REMINDER" },
    });
    await execute(reminder);
    const message = await db.message.findUniqueOrThrow({
      where: { key: reminder.key },
    });
    expect(message.body).toContain(expectedCopy);
    const notices = await db.notification.findMany({
      where: { key: { startsWith: `${reminder.key}:` } },
    });
    expect(notices).toHaveLength(4);
    expect(notices.every((notice) => notice.body === message.body)).toBe(true);
    // The original selected date is already restricted, but the confirmed
    // later table still permits the ordinary early refund.
    await command(actors[0], "cancel", { applicationId: view.id });
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: view.id } }))
        .attendanceStatus,
    ).toBe("CANCELED_EARLY");
    expect(await db.refund.count()).toBe(1);
    const cancellation = await db.auditLog.findFirstOrThrow({
      where: { action: "APPLICATION_CANCELED", objectId: view.id },
    });
    expect(cancellation.after).toEqual({
      late: false,
      eventId: "later",
      eventStartsAt: "2030-06-05T15:00:00.000Z",
      canceledAt: "2030-06-02T15:00:00.000Z",
    });
    // A canceled table and future schedule edits cannot rewrite the day on
    // which this participant canceled the originally confirmed event.
    await db.eventSlot.update({
      where: { id: "later" },
      data: { startsAt: new Date("2030-06-10T15:00:00.000Z") },
    });
    expect(
      await db.auditLog.findUniqueOrThrow({ where: { id: cancellation.id } }),
    ).toEqual(cancellation);
  });

  it("uses the new selected cutoff after an actual failed match and participant transfer", async () => {
    const applicationId = await applyAndPay();
    await atomic((tx) => runMatch(tx, "early"));
    vi.setSystemTime(base.getTime() + day);
    await command(actors[0], "resolve", {
      applicationId,
      choice: "TRANSFER",
      eventId: "later",
    });
    const view = (await participantView(actors[0])).applications[0];
    expect(view.options.map((option) => option.event.id)).toEqual(["later"]);
    const notice = await db.notification.findUniqueOrThrow({
      where: { key: `transfer:${applicationId}:later` },
    });
    expect(notice.body).toContain(
      "later 취소 검증 · 2030년 6월 6일 목 오전 12:00 · 홍대",
    );
    expect(notice.body).toContain(
      "자동 매칭 예약: 2030년 6월 5일 수 오전 12:00 (한국 시간)",
    );
    expect(notice.body).toContain(
      "2030년 6월 4일 화 오전 12:00 (한국 시간)부터 변심 환불이 제한됩니다.",
    );
    expect(notice.body).not.toContain("early 취소 검증");
    expect(cancellationCutoff(view)?.toISOString()).toBe(
      "2030-06-03T15:00:00.000Z",
    );
    await command(actors[0], "cancel", { applicationId });
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: applicationId } }))
        .attendanceStatus,
    ).toBe("CANCELED_EARLY");
    expect(await db.refund.count()).toBe(1);
  });

  it("keeps service-failure refunds available after the voluntary cutoff", async () => {
    const applicationId = await applyAndPay();
    vi.setSystemTime(base.getTime() + day);
    await atomic((tx) => runMatch(tx, "early"));
    await command(actors[0], "resolve", { applicationId, choice: "REFUND" });
    const refund = await db.refund.findFirstOrThrow();
    expect(refund.reason).toBe("SERVICE_NO_MATCH");
    expect(refund.amount).toBe(9900);
    await execute(await db.job.findFirstOrThrow({ where: { kind: "REFUND" } }));
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: applicationId } }))
        .paymentStatus,
    ).toBe("REFUNDED");
    expect(await db.refund.count()).toBe(1);
  });
});
