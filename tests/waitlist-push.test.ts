import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import webpush from "web-push";
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));
import { db } from "@/server/db";
import { execute } from "@/worker/runner";

const userId = "waitlist-push-user";
const appId = "waitlist-push-app";
const eventId = "waitlist-push-event";
const tableId = "waitlist-push-table";
const entryId = "waitlist-push-entry";
const noticeId = "waitlist-push-notice";
const jobId = "waitlist-push-job";
const receipt = { statusCode: 201, body: "", headers: {} };

beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Waitlist push tests require an isolated test database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Notification", "PushSubscription", "Job" CASCADE',
  );
  vi.clearAllMocks();
  vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic");
  vi.stubEnv("VAPID_PRIVATE_KEY", "synthetic");
  vi.mocked(webpush.sendNotification).mockResolvedValue(receipt);
  await db.user.create({
    data: {
      id: userId,
      name: "대기 알림 참가자",
      email: "waitlist-push@example.test",
      profile: {
        create: {
          contact: "01000000000",
          birthYear: 1997,
          gender: "기타",
          occupation: "디자이너",
          mbti: ["ENFP"],
          interests: ["여행"],
          traits: ["차분한"],
          desiredTraits: ["차분한"],
          budgets: ["2~3만원"],
          foodRestrictions: "없음",
          allergies: "없음",
          consentVersion: "test",
          consentAt: new Date(),
        },
      },
    },
  });
  const future = (minutes: number) => new Date(Date.now() + minutes * 60000);
  await db.eventSlot.create({
    data: {
      id: eventId,
      title: "대기 알림 회차",
      region: "서울",
      startsAt: future(10),
      endsAt: future(100),
      closesAt: future(5),
      matchAt: future(6),
      cancelRefundCutoffAt: future(5),
    },
  });
  await db.diningTable.create({
    data: {
      id: tableId,
      eventId,
      runId: "waitlist-push",
      status: "WAITLIST_PENDING",
      score: 0,
      evaluation: {},
      explanation: "대기 충원 중",
    },
  });
  await db.application.create({
    data: {
      id: appId,
      userId,
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      ticketType: "SINGLE",
      options: { create: { eventId } },
    },
  });
  const expiresAt = future(1);
  await db.waitlistEntry.create({
    data: {
      id: entryId,
      applicationId: appId,
      eventId,
      tableId,
      status: "OFFERED",
      expiresAt,
    },
  });
  await db.notification.create({
    data: {
      id: noticeId,
      userId,
      key: `waitlist-offer:${entryId}:${expiresAt.toISOString()}`,
      title: "대기 제안",
      body: "응답 기한 안에 수락해 주세요.",
      href: `/app?tab=detail&application=${appId}`,
    },
  });
  await db.pushSubscription.create({
    data: {
      userId,
      endpoint: "https://fcm.googleapis.com/waitlist-phone",
      p256dh: "test",
      auth: "test",
    },
  });
  await db.job.create({
    data: {
      id: jobId,
      key: "waitlist-push",
      kind: "PUSH",
      payload: { notificationId: noticeId },
      runAt: new Date(),
    },
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());
async function push() {
  return execute(await db.job.findUniqueOrThrow({ where: { id: jobId } }));
}
async function expectExpired() {
  expect(await push()).toBe("EXPIRED");
  expect(webpush.sendNotification).not.toHaveBeenCalled();
  expect(
    (await db.notification.findUniqueOrThrow({ where: { id: noticeId } }))
      .pushStatus,
  ).toBe("EXPIRED");
}

describe("waitlist offer push freshness", () => {
  it("sends a current offer with TTL bounded by its response deadline and deduplicates replay", async () => {
    expect(await push()).toBe("SENT");
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const options = vi.mocked(webpush.sendNotification).mock.calls[0][2]!;
    expect(options.TTL).toBeGreaterThan(0);
    expect(options.TTL).toBeLessThanOrEqual(60);
    expect(await push()).toBe("ALREADY_SENT");
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it.each(["DECLINED", "EXPIRED", "WITHDRAWN", "ACCEPTED", "CLOSED"])(
    "does not send a delayed offer after %s",
    async (status) => {
      await db.waitlistEntry.update({
        where: { id: entryId },
        data: { status },
      });
      await expectExpired();
    },
  );

  it("does not send a past response deadline even before the expiry worker runs", async () => {
    const expiresAt = new Date(Date.now() - 1000);
    await db.waitlistEntry.update({
      where: { id: entryId },
      data: { expiresAt },
    });
    await db.notification.update({
      where: { id: noticeId },
      data: { key: `waitlist-offer:${entryId}:${expiresAt.toISOString()}` },
    });
    await expectExpired();
  });

  it("rejects the previous notification when the same waitlist entry has a new offer deadline", async () => {
    await db.waitlistEntry.update({
      where: { id: entryId },
      data: { expiresAt: new Date(Date.now() + 120000) },
    });
    await expectExpired();
  });

  it.each([
    "table",
    "event",
    "started",
    "payment",
    "application",
    "assigned",
    "restriction",
    "recipient",
    "missing",
  ])(
    "expires stale %s state before contacting the provider",
    async (changed) => {
      if (changed === "table")
        await db.diningTable.update({
          where: { id: tableId },
          data: { status: "REPLACED" },
        });
      if (changed === "event")
        await db.eventSlot.update({
          where: { id: eventId },
          data: { status: "CANCELED" },
        });
      if (changed === "started")
        await db.eventSlot.update({
          where: { id: eventId },
          data: { startsAt: new Date(Date.now() - 1000) },
        });
      if (changed === "payment")
        await db.application.update({
          where: { id: appId },
          data: { paymentStatus: "REFUND_REQUESTED" },
        });
      if (changed === "application")
        await db.application.update({
          where: { id: appId },
          data: { applicationStatus: "CANCELED" },
        });
      if (changed === "assigned")
        await db.application.update({
          where: { id: appId },
          data: { tableId, matchStatus: "CONFIRMED" },
        });
      if (changed === "restriction")
        await db.user.update({
          where: { id: userId },
          data: { restriction: "BANNED" },
        });
      if (changed === "recipient") {
        await db.user.create({
          data: {
            id: "wrong-waitlist-recipient",
            name: "다른 참가자",
            email: "wrong-waitlist@example.test",
          },
        });
        await db.notification.update({
          where: { id: noticeId },
          data: { userId: "wrong-waitlist-recipient" },
        });
      }
      if (changed === "missing")
        await db.waitlistEntry.delete({ where: { id: entryId } });
      await expectExpired();
    },
  );

  it("rechecks the offer between devices when a response arrives during delivery", async () => {
    await db.pushSubscription.create({
      data: {
        userId,
        endpoint: "https://fcm.googleapis.com/waitlist-tablet",
        p256dh: "test",
        auth: "test",
      },
    });
    vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
      await db.waitlistEntry.update({
        where: { id: entryId },
        data: { status: "DECLINED" },
      });
      return receipt;
    });
    expect(await push()).toBe("EXPIRED");
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});
