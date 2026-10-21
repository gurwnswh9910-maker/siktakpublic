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
import { atomic, db } from "@/server/db";
import { retireAllocatedTables } from "@/server/table-allocation";
import { execute, tickDetailed } from "@/worker/runner";

const userId = "retired-table-push-user";
const eventId = "retired-table-push-event";
const tableId = "retired-table-push-table";
const noticeId = "retired-table-push-notice";
const jobId = "retired-table-push-job";
const receipt = { statusCode: 201, body: "", headers: {} };

beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Retirement push tests require an isolated test database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Notification", "PushSubscription", "Job", "Setting", "AuditLog" CASCADE',
  );
  vi.clearAllMocks();
  vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic");
  vi.stubEnv("VAPID_PRIVATE_KEY", "synthetic");
  vi.mocked(webpush.sendNotification).mockResolvedValue(receipt);
  await db.user.create({
    data: {
      id: userId,
      name: "배정 안내 참가자",
      email: "retired-table-push@example.test",
    },
  });
  const future = (minutes: number) => new Date(Date.now() + minutes * 60000);
  await db.eventSlot.create({
    data: {
      id: eventId,
      title: "배정 변경 회차",
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
      runId: "retired-table-push",
      status: "CONFIRMED",
      score: 0,
      evaluation: {},
      explanation: "변경 전 테이블",
    },
  });
  await db.notification.create({
    data: {
      id: noticeId,
      userId,
      key: `confirmed:${tableId}:${userId}`,
      title: "모임 확정",
      body: "이전 테이블 안내",
      href: "/app",
    },
  });
  for (const device of ["phone", "tablet"]) {
    await db.pushSubscription.create({
      data: {
        userId,
        endpoint: `https://fcm.googleapis.com/retired-table-${device}`,
        p256dh: "test",
        auth: "test",
      },
    });
  }
  await db.job.create({
    data: {
      id: jobId,
      key: "retired-table-push",
      kind: "PUSH",
      payload: { notificationId: noticeId },
      runAt: new Date(),
    },
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());

describe("table retirement during push delivery", () => {
  it.each(["confirmed", "reminder"])(
    "revokes a running %s PUSH claim after the first device and preserves expiry",
    async (kind) => {
      await db.notification.update({
        where: { id: noticeId },
        data: { key: `${kind}:${tableId}:${userId}` },
      });
      vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
        const running = await db.job.findUniqueOrThrow({
          where: { id: jobId },
        });
        expect(running.status).toBe("RUNNING");
        expect(running.claimToken).toBeTruthy();
        await atomic((tx) => retireAllocatedTables(tx, [tableId]));
        return receipt;
      });
      expect(await tickDetailed()).toEqual({ outcome: "lost" });
      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
      expect(
        await db.job.findUniqueOrThrow({ where: { id: jobId } }),
      ).toMatchObject({ status: "CANCELED", claimToken: null, lockedAt: null });
      expect(
        (await db.notification.findUniqueOrThrow({ where: { id: noticeId } }))
          .pushStatus,
      ).toBe("EXPIRED");
      const attempt = await db.auditLog.findFirstOrThrow({
        where: { objectId: jobId, action: "JOB_ATTEMPT_FINISHED" },
      });
      expect(attempt.after).toMatchObject({
        outcome: "INTERRUPTED",
        reason: "CLAIM_LOST",
      });
      expect(await tickDetailed()).toEqual({ outcome: "empty" });
    },
  );

  it("rechecks table validity between devices even when no claim callback is supplied", async () => {
    vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
      await atomic((tx) => retireAllocatedTables(tx, [tableId]));
      return receipt;
    });
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(await execute(job)).toBe("EXPIRED");
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: noticeId } }))
        .pushStatus,
    ).toBe("EXPIRED");
  });

  it("does not overwrite expiry when retirement finishes during the last device send", async () => {
    await db.pushSubscription.deleteMany({
      where: { endpoint: { endsWith: "tablet" } },
    });
    vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
      await atomic((tx) => retireAllocatedTables(tx, [tableId]));
      return receipt;
    });
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(await execute(job)).toBe("EXPIRED");
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: noticeId } }))
        .pushStatus,
    ).toBe("EXPIRED");
  });
});
