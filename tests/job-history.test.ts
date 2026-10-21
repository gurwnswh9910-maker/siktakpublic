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
import { db, type Actor } from "@/server/db";
import { command } from "@/server/commands";
import { projectJobHistory } from "@/server/job-history";
import { tickDetailed } from "@/worker/runner";

const receipt = { statusCode: 201, body: "", headers: {} };
const operator: Actor = { id: "history-admin", name: "운영자", role: "ADMIN" };
const sensitive = "synthetic-private-key-do-not-persist";

beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Wrong database");
  await db.$executeRawUnsafe(
    'ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS job_history_reject',
  );
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await db.user.create({ data: { ...operator, email: "history@test.local" } });
  vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic-public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", sensitive);
  vi.mocked(webpush.setVapidDetails).mockReset();
  vi.mocked(webpush.sendNotification).mockReset().mockResolvedValue(receipt);
});
afterEach(async () => {
  await db.$executeRawUnsafe(
    'ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS job_history_reject',
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => db.$disconnect());

async function fixture(subscribed = true) {
  const notification = await db.notification.create({
    data: {
      userId: "history-recipient",
      key: "history-notification",
      title: "합성 알림",
      body: `비공개 본문 ${sensitive}`,
      href: "/app",
    },
  });
  if (subscribed)
    await db.pushSubscription.create({
      data: {
        userId: notification.userId,
        endpoint: `https://fcm.googleapis.com/history-${sensitive}`,
        p256dh: sensitive,
        auth: sensitive,
      },
    });
  const job = await db.job.create({
    data: {
      id: "history-job",
      key: `history-job-${sensitive}`,
      kind: "PUSH",
      payload: { notificationId: notification.id, credential: sensitive },
      runAt: new Date(0),
    },
  });
  return { job, notification };
}
async function history(jobId = "history-job") {
  return projectJobHistory(jobId, await db.auditLog.findMany());
}
async function retryNow(jobId = "history-job") {
  await db.job.update({ where: { id: jobId }, data: { runAt: new Date(0) } });
}

describe("persistent worker attempt history", () => {
  it("keeps a failed delivery and its retry schedule after a later success clears lastError", async () => {
    const { job } = await fixture();
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(
      new Error(sensitive),
    );
    expect(await tickDetailed()).toEqual({ outcome: "retrying" });
    const prior = await history();
    expect(prior.map((entry) => entry.outcome)).toEqual([
      "STARTED",
      "RETRYING",
    ]);
    expect(prior[1]).toMatchObject({
      attempt: 1,
      reason: "PUSH_DELIVERY_FAILED",
    });
    expect(prior[1].nextRunAt).toBe(
      (
        await db.job.findUniqueOrThrow({ where: { id: job.id } })
      ).runAt.toISOString(),
    );
    await retryNow();
    expect(await tickDetailed()).toEqual({ outcome: "succeeded" });
    const after = await history();
    expect(after.slice(0, 2)).toEqual(prior);
    expect(after.map((entry) => entry.outcome)).toEqual([
      "STARTED",
      "RETRYING",
      "STARTED",
      "SUCCEEDED",
    ]);
    expect(after[3]).toMatchObject({ attempt: 2, result: "SENT" });
    expect(after[2].attemptId).not.toBe(prior[0].attemptId);
    expect(after[0].attemptId).toBe(after[1].attemptId);
    expect(after[2].attemptId).toBe(after[3].attemptId);
    expect(
      await db.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({
      status: "DONE",
      lastError: null,
    });
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(
      sensitive,
    );
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a new claim after an operator resets the retry counter", async () => {
    const { job } = await fixture();
    await db.setting.create({
      data: { key: "automation", value: { maxAttempts: 1 } },
    });
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(await tickDetailed()).toEqual({ outcome: "failed" });
    const failed = await history();
    expect(failed[1]).toMatchObject({
      attempt: 1,
      reason: "PUSH_UNCONFIGURED",
    });
    await command(operator, "retryJob", { jobId: job.id });
    vi.stubEnv("VAPID_PRIVATE_KEY", sensitive);
    expect(await tickDetailed()).toEqual({ outcome: "succeeded" });
    const entries = await history();
    expect(entries.slice(0, 2)).toEqual(failed);
    expect(entries[3]).toMatchObject({
      attempt: 1,
      outcome: "SUCCEEDED",
      result: "SENT",
    });
    expect(entries[3].attemptId).not.toBe(failed[1].attemptId);
    expect(
      await db.auditLog.findFirst({
        where: { objectId: job.id, action: "JOB_RETRY", actorId: operator.id },
      }),
    ).not.toBeNull();
  });

  it.each(["NOT_SUBSCRIBED", "EXPIRED"] as const)(
    "records %s without claiming an external push was delivered",
    async (result) => {
      await fixture(result === "EXPIRED");
      if (result === "EXPIRED")
        vi.mocked(webpush.sendNotification).mockRejectedValueOnce({
          statusCode: 410,
          body: sensitive,
        });
      expect(await tickDetailed()).toEqual({ outcome: "succeeded" });
      expect((await history())[1]).toMatchObject({
        outcome: "SUCCEEDED",
        result,
      });
      expect(webpush.sendNotification).toHaveBeenCalledTimes(
        result === "EXPIRED" ? 1 : 0,
      );
    },
  );

  it("drops arbitrary provider error text, payload and secret material from the persisted result", async () => {
    await fixture();
    vi.mocked(webpush.setVapidDetails).mockImplementationOnce(() => {
      throw new Error(`invalid private key: ${sensitive}`);
    });
    expect(await tickDetailed()).toEqual({ outcome: "retrying" });
    expect((await history())[1]).toMatchObject({ reason: "EXECUTION_FAILED" });
    const audits = await db.auditLog.findMany();
    const job = await db.job.findUniqueOrThrow({
      where: { id: "history-job" },
    });
    expect(JSON.stringify(audits)).not.toContain(sensitive);
    expect(job.lastError).not.toContain(sensitive);
    expect(JSON.stringify(audits)).not.toContain("credential");
    expect(JSON.stringify(audits)).not.toContain("endpoint");
  });

  it("retains the interrupted attempt when a delayed old worker returns after recovery", async () => {
    const { job } = await fixture();
    let release!: (value: typeof receipt) => void;
    const pending = new Promise<typeof receipt>((resolve) => {
      release = resolve;
    });
    vi.mocked(webpush.sendNotification).mockImplementationOnce(() => pending);
    const oldWorker = tickDetailed();
    try {
      await vi.waitFor(() =>
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1),
      );
      const started = await history();
      expect(started).toHaveLength(1);
      expect(started[0].outcome).toBe("STARTED");
      await db.job.update({
        where: { id: job.id },
        data: { lockedAt: new Date(Date.now() - 360000) },
      });
      expect(await tickDetailed()).toEqual({ outcome: "succeeded" });
      const recovered = await history();
      const oldResult = recovered.find(
        (entry) =>
          entry.attemptId === started[0].attemptId &&
          entry.outcome !== "STARTED",
      );
      expect(oldResult).toMatchObject({
        outcome: "INTERRUPTED",
        reason: "LEASE_EXPIRED",
      });
      release(receipt);
      expect(await oldWorker).toEqual({ outcome: "lost" });
      expect(await history()).toEqual(recovered);
      expect(
        await db.job.findUniqueOrThrow({ where: { id: job.id } }),
      ).toMatchObject({ status: "DONE", attempts: 2 });
    } finally {
      release(receipt);
      await oldWorker;
    }
  });

  it("rolls back a claim when its start record cannot be persisted", async () => {
    const { job } = await fixture();
    await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ADD CONSTRAINT job_history_reject
      CHECK ("objectId" <> 'history-job' OR action <> 'JOB_ATTEMPT_STARTED')`);
    await expect(tickDetailed()).rejects.toThrow();
    expect(
      await db.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({
      status: "PENDING",
      attempts: 0,
      claimToken: null,
      lockedAt: null,
    });
    expect(await history()).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    await db.$executeRawUnsafe(
      'ALTER TABLE "AuditLog" DROP CONSTRAINT job_history_reject',
    );
    expect(await tickDetailed()).toEqual({ outcome: "succeeded" });
  });

  it("cannot acknowledge success without its result record and recovers without repeating a completed push", async () => {
    const { job, notification } = await fixture();
    await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ADD CONSTRAINT job_history_reject
      CHECK ("objectId" <> 'history-job' OR action <> 'JOB_ATTEMPT_FINISHED')`);
    await expect(tickDetailed()).rejects.toThrow();
    expect(
      await db.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({ status: "RUNNING", attempts: 1 });
    expect(
      await db.notification.findUniqueOrThrow({
        where: { id: notification.id },
      }),
    ).toMatchObject({ pushStatus: "SENT" });
    expect((await history()).map((entry) => entry.outcome)).toEqual([
      "STARTED",
    ]);
    await db.$executeRawUnsafe(
      'ALTER TABLE "AuditLog" DROP CONSTRAINT job_history_reject',
    );
    await db.job.update({
      where: { id: job.id },
      data: { lockedAt: new Date(Date.now() - 360000) },
    });
    expect(await tickDetailed()).toEqual({ outcome: "succeeded" });
    expect(
      (await history()).find((entry) => entry.outcome === "SUCCEEDED"),
    ).toMatchObject({ attempt: 2, result: "ALREADY_SENT" });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("projects only validated attempt fields for the requested job", () => {
    const valid = {
      id: "safe-audit",
      objectId: "job",
      action: "JOB_ATTEMPT_FINISHED",
      after: {
        attemptId: "a528d4bd-c645-4b2a-a517-775169250369",
        attempt: 1,
        kind: "PUSH",
        occurredAt: "2026-10-15T12:00:00.000Z",
        outcome: "SUCCEEDED",
        result: "NOT_SUBSCRIBED",
        rawError: sensitive,
      },
    };
    const rows = [
      valid,
      { ...valid, id: "other-job", objectId: "other" },
      { ...valid, id: "wrong-action", action: "JOB_RETRY" },
      {
        ...valid,
        id: "bad-date",
        after: { ...valid.after, occurredAt: sensitive },
      },
      {
        ...valid,
        id: "bad-outcome",
        after: { ...valid.after, outcome: sensitive },
      },
      {
        ...valid,
        id: "false-success",
        after: { ...valid.after, result: undefined },
      },
    ];
    // undefined represents absent JSON fields once encoded for persistence.
    const projected = projectJobHistory(
      "job",
      JSON.parse(JSON.stringify(rows)),
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: valid.id,
      result: "NOT_SUBSCRIBED",
    });
    expect(JSON.stringify(projected)).not.toContain(sensitive);
  });
});
