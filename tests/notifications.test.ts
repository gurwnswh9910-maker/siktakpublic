import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EventSlot } from "@prisma/client";
import { atomic, db, type Actor } from "@/server/db";
import { command, invalidateTable } from "@/server/commands";
import { runMatch } from "@/server/match-run";
import { notifyNewEvent } from "@/server/new-event-notifications";
import { execute } from "@/worker/runner";
import {
  defaultNotificationTemplates,
  eventDateTime,
} from "@/domain/notification-templates";

const operator: Actor = { id: "admin", name: "운영자", role: "ADMIN" };
const actors: Actor[] = Array.from({ length: 8 }, (_, i) => ({
  id: `u${i}`,
  name: `참가자${i}`,
  role: "PARTICIPANT",
}));
const day = 86400000;

function eventData(id: string, startsAt: Date, region = "홍대") {
  return {
    id,
    title: `${id} 식탁`,
    region,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * 3600000),
    closesAt: new Date(startsAt.getTime() - day),
    matchAt: new Date(startsAt.getTime() - day),
    cancelRefundCutoffAt: new Date(startsAt.getTime() - 2 * day),
    capacity: 24,
  };
}

async function templates(value: unknown) {
  return command(operator, "setting", { key: "notificationTemplates", value });
}

async function fill(indices = [0, 1, 2, 3], eventId = "e0") {
  for (const i of indices) {
    await command(actors[i], "apply", {
      requestId: `a${i}`,
      eventIds: [eventId],
      ticketType: "SINGLE",
      consent: true,
    });
    await command(actors[i], "pay", {
      applicationId: `a${i}`,
      requestId: `p${i}`,
    });
  }
}

async function history(
  i: number,
  startsAt: Date,
  region = "홍대",
  returnIntent?: boolean,
  suffix = "",
) {
  const id = `past${i}${suffix}`;
  await db.eventSlot.create({
    data: { ...eventData(id, startsAt, region), status: "ENDED" },
  });
  const table = await db.diningTable.create({
    data: {
      eventId: id,
      runId: "history",
      score: 60,
      evaluation: {},
      explanation: "과거 참석",
    },
  });
  await db.application.create({
    data: {
      userId: actors[i].id,
      ticketType: "SINGLE",
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      matchStatus: "CONFIRMED",
      attendanceStatus: "ATTENDED",
      tableId: table.id,
      options: { create: { eventId: id } },
      ...(returnIntent === undefined
        ? {}
        : {
            feedback: {
              create: {
                atmosphere: 4,
                conversation: 4,
                venue: 4,
                returnIntent,
                recommend: 4,
                comment: "",
              },
            },
          }),
    },
  });
}

beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Wrong database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await db.user.create({ data: { ...operator, email: "admin@test.local" } });
  await db.user.create({
    data: {
      id: "safety",
      name: "안전",
      role: "SAFETY",
      email: "safety@test.local",
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
            birthYear: 1997,
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
  for (let i = 0; i < 2; i++)
    await db.eventSlot.create({
      data: {
        ...eventData(
          `e${i}`,
          new Date(Date.now() + (i + 4) * day),
          i ? "강남" : "홍대",
        ),
        venues: {
          create: {
            name: `가상 식당${i}`,
            address: "시연 주소",
            mapUrl: "https://map.naver.com",
            reservationName: "우연한 식탁",
            price: 25000,
            capacity: 6,
            totalTables: 4,
            dietaryNotes: "시연",
          },
        },
      },
    });
});
afterAll(() => db.$disconnect());

describe("operator templates and preferred next-event notices", () => {
  it("rejects participant and safety edits, including a forged operator role", async () => {
    for (const actor of [
      actors[0],
      { ...actors[0], role: "ADMIN" },
      { id: "safety", name: "안전", role: "ADMIN" },
    ])
      await expect(
        command(actor, "setting", {
          key: "notificationTemplates",
          value: { curation: "변경" },
        }),
      ).rejects.toMatchObject({ status: 403 });
    expect(await db.setting.count()).toBe(0);
  });

  it("validates known nonempty templates, preserves partial updates and audits the saved copy", async () => {
    for (const value of [
      { curation: "   " },
      { alternative: "x".repeat(1001) },
      { unknown: "문구" },
      {},
    ])
      await expect(templates(value)).rejects.toThrow();
    await templates({ reminder: " 이전 리마인드 " });
    await templates({ curation: "새 큐레이션", alternative: "새 대체 안내" });
    const setting = await db.setting.findUniqueOrThrow({
      where: { key: "notificationTemplates" },
    });
    expect(setting.value).toEqual({
      curation: "새 큐레이션",
      reminder: "이전 리마인드",
      alternative: "새 대체 안내",
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "SETTING_UPDATED" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.before).toEqual({
      ...defaultNotificationTemplates,
      reminder: "이전 리마인드",
    });
    expect(audit.after).toEqual(setting.value);
  });

  it("uses saved curation for confirmation and room messages, preserving snapshots on replay", async () => {
    await templates({ curation: "오늘의 큐레이션 문구" });
    await fill();
    await atomic((tx) => runMatch(tx, "e0"));
    const welcome = await db.message.findFirstOrThrow({
      where: { key: { startsWith: "welcome:" } },
    });
    const notices = await db.notification.findMany({
      where: { key: { startsWith: "confirmed:" } },
    });
    expect(notices).toHaveLength(4);
    expect(
      notices.every((n) => n.body.startsWith("오늘의 큐레이션 문구")),
    ).toBe(true);
    const event = await db.eventSlot.findUniqueOrThrow({ where: { id: "e0" } });
    for (const text of [
      "오늘의 큐레이션 문구",
      "4명이 모였어요",
      eventDateTime(event.startsAt),
      "가상 식당0",
      "예약명: 우연한 식탁",
      "안전 문제는 언제든 신고",
    ])
      expect(welcome.body).toContain(text);
    await templates({ curation: "변경 이후 큐레이션" });
    await atomic((tx) => runMatch(tx, "e0"));
    expect(await db.message.findUnique({ where: { id: welcome.id } })).toEqual(
      welcome,
    );
    expect(
      await db.notification.findMany({
        where: { key: { startsWith: "confirmed:" } },
        orderBy: { id: "asc" },
      }),
    ).toEqual([...notices].sort((a, b) => a.id.localeCompare(b.id)));
    await fill([4, 5, 6, 7], "e1");
    await atomic((tx) => runMatch(tx, "e1"));
    expect(
      await db.notification.count({
        where: { body: { startsWith: "변경 이후 큐레이션" } },
      }),
    ).toBe(4);
  });

  it("uses the current reminder when generated and keeps both saved channels unchanged on retry", async () => {
    await fill();
    await atomic((tx) => runMatch(tx, "e0"));
    await templates({ reminder: "생성 시점 리마인드" });
    const job = await db.job.findFirstOrThrow({ where: { kind: "REMINDER" } });
    await execute(job);
    const message = await db.message.findUniqueOrThrow({
      where: { key: job.key },
    });
    const event = await db.eventSlot.findUniqueOrThrow({ where: { id: "e0" } });
    for (const text of [
      "생성 시점 리마인드",
      eventDateTime(event.startsAt),
      "가상 식당0",
      "시연 주소",
      "예약명: 우연한 식탁",
      eventDateTime(event.cancelRefundCutoffAt),
      "노쇼",
      "안전 문제",
    ])
      expect(message.body).toContain(text);
    await templates({ reminder: "다음 생성부터 반영" });
    await execute(job);
    expect(
      await db.message.findUniqueOrThrow({ where: { key: job.key } }),
    ).toEqual(message);
    const notices = await db.notification.findMany({
      where: { key: { startsWith: `${job.key}:` } },
    });
    expect(notices).toHaveLength(4);
    expect(notices.every((n) => n.body === message.body)).toBe(true);
    expect(
      await db.job.count({
        where: { key: { startsWith: `push:${job.key}:` } },
      }),
    ).toBe(4);
  });

  it("renders alternative dates and rights, excludes canceled slots, and preserves the original notice", async () => {
    await templates({ alternative: "맞는 다음 날짜를 찾아보세요" });
    await db.eventSlot.create({
      data: {
        ...eventData("canceled", new Date(Date.now() + 7 * day)),
        status: "CANCELED",
      },
    });
    await fill([0]);
    // A recommendation now requires an actually feasible pool, not only OPEN.
    await fill([1, 2, 3], "e1");
    await atomic((tx) => runMatch(tx, "e0"));
    const notice = await db.notification.findFirstOrThrow({
      where: { key: { startsWith: "unmatched:" } },
    });
    for (const text of [
      "맞는 다음 날짜를 찾아보세요",
      "조건을 충족하는 테이블",
      "강남",
      "e1 식탁",
      "직접 동의",
      "보관 또는 환불",
    ])
      expect(notice.body).toContain(text);
    expect(notice.body).not.toContain("canceled 식탁");
    expect(notice.body).not.toContain("e0 식탁");
    await templates({ alternative: "나중에 바꾼 문구" });
    await atomic((tx) => runMatch(tx, "e0"));
    expect(
      await db.notification.findMany({
        where: { key: { startsWith: "unmatched:" } },
      }),
    ).toEqual([notice]);
  });

  it("offers retention and refund when the current slot is the only open event", async () => {
    await db.eventSlot.update({
      where: { id: "e1" },
      data: { status: "CANCELED" },
    });
    await fill([0]);
    await atomic((tx) => runMatch(tx, "e0"));
    const notice = await db.notification.findFirstOrThrow({
      where: { key: { startsWith: "unmatched:" } },
    });
    expect(notice.body).toContain("현재 적합성이 확인된 대체 일정은 없습니다");
    expect(notice.body).toContain("보관 또는 환불");
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "a0" } }))
        .matchStatus,
    ).toBe("NO_MATCH");
  });

  it("applies the alternative template when a started table needs repair", async () => {
    await fill();
    await atomic((tx) => runMatch(tx, "e0"));
    await templates({ alternative: "변경된 모임의 대안 안내" });
    await db.eventSlot.update({
      where: { id: "e0" },
      data: { startsAt: new Date(Date.now() - 1000) },
    });
    const table = await db.diningTable.findFirstOrThrow();
    await atomic((tx) => invalidateTable(tx, table.id, operator.id, true));
    const notices = await db.notification.findMany({
      where: { key: { startsWith: "repair-offer:" } },
    });
    expect(notices).toHaveLength(4);
    expect(
      notices.every(
        (n) =>
          n.body.includes("변경된 모임의 대안 안내") &&
          n.body.includes("보관 또는 환불"),
      ),
    ).toBe(true);
  });

  it("targets both preferred region and KST weekday with positive attendance, once per eligible user", async () => {
    const future = new Date(Date.now() + 14 * day);
    future.setUTCHours(15, 30, 0, 0);
    // Same KST weekday, but a different UTC weekday from the new event.
    const positiveDay = new Date(future.getTime() - 28 * day + 9 * 3600000);
    // Same UTC weekday, but the previous KST weekday.
    const wrongDay = new Date(future.getTime() - 28 * day - 3600000);
    await history(0, positiveDay);
    await history(1, positiveDay, "강남");
    await history(2, wrongDay);
    await history(3, positiveDay, "홍대", false);
    await history(4, positiveDay, "홍대", true);
    await history(6, positiveDay, "홍대", true);
    await history(7, positiveDay, "홍대", true);
    await history(7, positiveDay, "홍대", true, "repeat");
    await db.user.update({
      where: { id: "u4" },
      data: { restriction: "SUSPENDED" },
    });
    await db.user.update({
      where: { id: "u6" },
      data: { restriction: "WARNING" },
    });
    await command(actors[5], "apply", {
      requestId: "never-attended",
      eventIds: ["e0"],
      ticketType: "SINGLE",
      consent: true,
    });
    const { id: unused, ...input } = eventData("new", future);
    void unused;
    const event = (await command(
      operator,
      "event",
      Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key,
          value instanceof Date ? value.toISOString() : value,
        ]),
      ),
    )) as EventSlot;
    await atomic((tx) => notifyNewEvent(tx, event));
    const notices = await db.notification.findMany({
      where: { key: { startsWith: `new-event:${event.id}:` } },
      orderBy: { userId: "asc" },
    });
    expect(notices.map((n) => n.userId)).toEqual(["u0", "u6", "u7"]);
    expect(
      notices.every(
        (n) =>
          n.body.includes(eventDateTime(event.startsAt)) &&
          n.body.includes("홍대"),
      ),
    ).toBe(true);
    expect(
      await db.job.count({
        where: { key: { startsWith: `push:new-event:${event.id}:` } },
      }),
    ).toBe(3);
    await atomic((tx) =>
      notifyNewEvent(tx, {
        ...event,
        id: "closed",
        closesAt: new Date(Date.now() - 1),
      }),
    );
    await atomic((tx) =>
      notifyNewEvent(tx, { ...event, id: "canceled", status: "CANCELED" }),
    );
    expect(
      await db.notification.count({
        where: { key: { startsWith: "new-event:" } },
      }),
    ).toBe(3);
  });
});
