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
import { PrismaClient } from "@prisma/client";
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));
import { db, atomic, type Tx } from "@/server/db";
import { completeMockRefund } from "@/server/refunds";
import { execute, tickDetailed } from "@/worker/runner";
import {
  runScheduledBatch,
  schedulerAuthorization,
  schedulerLimits,
  schedulerDb,
} from "@/worker/scheduler";
import { runBoundedProcess } from "@/worker/bounded-process";
import { automationStatus } from "@/worker/automation-status";
import { GET, POST } from "@/app/api/jobs/run/route";

const secret = "scheduler-test-secret-at-least-32-characters";
const request = (token?: string) =>
  new Request("http://localhost/api/jobs/run", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Wrong database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  vi.stubEnv("SCHEDULER_SECRET", secret);
  vi.stubEnv("SIKTAK_APP_ROOT", process.cwd());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
afterAll(() => Promise.all([db.$disconnect(), schedulerDb.$disconnect()]));

async function jobs(count: number) {
  await db.job.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      key: `scheduler-${index}`,
      kind: "REMINDER",
      payload: { tableId: "missing-table" },
      runAt: new Date(Date.now() - 1000),
    })),
  });
}
async function oldTable() {
  const event = await db.eventSlot.create({
    data: {
      title: "지난 모임",
      region: "홍대",
      startsAt: new Date(Date.now() - 2 * 86400000),
      endsAt: new Date(Date.now() - 86400000),
      closesAt: new Date(0),
      matchAt: new Date(0),
      cancelRefundCutoffAt: new Date(0),
    },
  });
  return db.diningTable.create({
    data: {
      eventId: event.id,
      runId: "old-run",
      score: 80,
      explanation: "테스트",
      status: "CONFIRMED",
      evaluation: {},
      room: { create: {} },
    },
    include: { room: true },
  });
}

describe("authenticated scheduled jobs", () => {
  it("rejects GET, missing/incorrect bearer and absent/short configuration without starting work", async () => {
    expect((await GET()).status).toBe(405);
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("wrong-secret"))).status).toBe(401);
    expect(schedulerAuthorization(`Bearer ${secret} trailing`)).toBe(
      "unauthorized",
    );
    expect(schedulerAuthorization(`Bearer ${secret}`)).toBe("authorized");
    vi.stubEnv("SCHEDULER_SECRET", "");
    expect((await POST(request(secret))).status).toBe(503);
    vi.stubEnv("SCHEDULER_SECRET", "short");
    expect((await POST(request("short"))).status).toBe(503);
    expect(await db.setting.count()).toBe(0);
  });

  it("executes at most 20 jobs and reports processing separately from success", async () => {
    await jobs(22);
    const result = await runScheduledBatch();
    expect(result).toMatchObject({
      status: "COMPLETED",
      reason: "limit",
      claimed: 20,
      processed: 20,
      succeeded: 20,
      failed: 0,
      retrying: 0,
      interrupted: 0,
    });
    expect(await db.job.count({ where: { status: "DONE" } })).toBe(20);
    expect(await db.job.count({ where: { status: "PENDING" } })).toBe(2);
    expect(
      await db.setting.findUnique({ where: { key: "workerHeartbeat" } }),
    ).toBeNull();
    expect(
      (
        await db.setting.findUniqueOrThrow({
          where: { key: "schedulerHeartbeat" },
        })
      ).value,
    ).toMatchObject({ mode: "scheduler", status: "COMPLETED", processed: 20 });
  });

  it("rejects a concurrent HTTP invocation and returns a usable completed result", async () => {
    await jobs(1);
    const responses = await Promise.all([
      POST(request(secret)),
      POST(request(secret)),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const completed = responses.find((r) => r.status === 200)!;
    expect(await completed.json()).toMatchObject({
      status: "COMPLETED",
      processed: 1,
      succeeded: 1,
    });
    expect(
      await db.setting.findUnique({ where: { key: "schedulerLease" } }),
    ).toBeNull();
  });

  it("releases scheduler ownership after a slow control round trip without blocking the next invocation", async () => {
    await jobs(1);
    const transaction = schedulerDb.$transaction.bind(schedulerDb);
    const slowRelease = (async (
      fn: (tx: Tx) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number },
    ) =>
      transaction(
        async (tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                const value = Reflect.get(target, key);
                if (key !== "$executeRaw")
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                return async (...args: unknown[]) => {
                  const sql = (args[0] as TemplateStringsArray).join("?");
                  // A client/network pause inside a real PostgreSQL transaction. Keep
                  // statement and lock timeouts unchanged; no DB statement is sleeping.
                  if (sql.includes('DELETE FROM "Setting"'))
                    await new Promise((resolve) => setTimeout(resolve, 2500));
                  return Reflect.apply(value, target, args);
                };
              },
            }),
          ),
        options,
      )) as typeof db.$transaction;
    const spy = vi
      .spyOn(schedulerDb, "$transaction")
      .mockImplementation(slowRelease);
    try {
      expect(await runScheduledBatch()).toMatchObject({
        status: "COMPLETED",
        processed: 1,
        succeeded: 1,
      });
    } finally {
      spy.mockRestore();
    }
    expect(
      await db.setting.findUnique({ where: { key: "schedulerLease" } }),
    ).toBeNull();
    expect(await runScheduledBatch()).toMatchObject({
      busy: false,
      status: "COMPLETED",
    });
  });

  it("keeps scheduler control available while the application connection pool is exhausted", async () => {
    const messages: unknown[] = [];
    const result = await runBoundedProcess(
      ["--import", "tsx", "tests/fixtures/scheduler-pool-contention.ts"],
      {
        cwd: process.cwd(),
        timeoutMs: 25000,
        onMessage: (message) => messages.push(message),
      },
    );
    expect(messages).toContainEqual({
      type: "pool-isolation",
      completedWhileApplicationPoolOccupied: true,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(
      await db.setting.findUnique({ where: { key: "schedulerLease" } }),
    ).toBeNull();
  });

  it.each([
    { heldMs: 3000, recovers: true },
    { heldMs: 6500, recovers: false },
  ])(
    "bounds release retries under real pool exhaustion ($heldMs ms)",
    async ({ heldMs, recovers }) => {
      await jobs(1);
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set("connection_limit", "1");
      const single = new PrismaClient({
        datasources: { db: { url: url.toString() } },
      });
      const transaction = schedulerDb.$transaction.bind(schedulerDb);
      let calls = 0;
      let releaseBlocker = () => {};
      let blocker: Promise<unknown> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const implementation = (async (
        fn: (tx: Tx) => Promise<unknown>,
        options?: { maxWait?: number; timeout?: number },
      ) => {
        calls++;
        // Acquire, initial heartbeat, renewal, final heartbeat, then release.
        if (calls < 5) return transaction(fn, options);
        if (calls === 5) {
          let ready = () => {};
          const acquired = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const blocked = new Promise<void>((resolve) => {
            releaseBlocker = resolve;
          });
          blocker = single.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT 1`;
              ready();
              await blocked;
            },
            { timeout: 10000 },
          );
          await acquired;
          timer = setTimeout(releaseBlocker, heldMs);
        }
        return single.$transaction(fn, options);
      }) as typeof db.$transaction;
      const spy = vi
        .spyOn(schedulerDb, "$transaction")
        .mockImplementation(implementation);
      try {
        if (recovers)
          expect(await runScheduledBatch()).toMatchObject({
            status: "COMPLETED",
            succeeded: 1,
          });
        else
          await expect(runScheduledBatch()).rejects.toMatchObject({
            code: "P2028",
          });
        expect(calls).toBe(6);
      } finally {
        spy.mockRestore();
        if (timer) clearTimeout(timer);
        releaseBlocker();
        await blocker;
        await single.$disconnect();
      }
      const lease = await db.setting.findUnique({
        where: { key: "schedulerLease" },
      });
      if (recovers) {
        expect(lease).toBeNull();
        expect(await runScheduledBatch()).toMatchObject({
          busy: false,
          status: "COMPLETED",
        });
      } else {
        expect(lease).not.toBeNull();
        expect(await runScheduledBatch()).toMatchObject({ busy: true });
      }
      expect(
        await db.job.findMany({ select: { status: true, attempts: true } }),
      ).toEqual([{ status: "DONE", attempts: 1 }]);
    },
  );

  it("distinguishes retrying and final failures from successful jobs", async () => {
    await jobs(1);
    await db.job.create({
      data: {
        key: "retryable",
        kind: "MATCH",
        payload: { eventId: "missing-event" },
        runAt: new Date(),
      },
    });
    expect(await runScheduledBatch()).toMatchObject({
      processed: 2,
      succeeded: 1,
      retrying: 1,
      failed: 0,
    });
    await db.setting.create({
      data: { key: "automation", value: { maxAttempts: 2 } },
    });
    await db.job.update({
      where: { key: "retryable" },
      data: { runAt: new Date(0) },
    });
    expect(await runScheduledBatch()).toMatchObject({
      processed: 1,
      succeeded: 0,
      retrying: 0,
      failed: 1,
    });
    expect(await db.exceptionCase.count({ where: { kind: "JOB" } })).toBe(1);
  });

  it("recovers expired scheduler ownership and five-minute job claims", async () => {
    await jobs(1);
    await db.setting.create({
      data: {
        key: "schedulerLease",
        value: { token: "dead-process", expiresAt: Date.now() - 1000 },
      },
    });
    await db.job.update({
      where: { key: "scheduler-0" },
      data: {
        status: "RUNNING",
        lockedAt: new Date(Date.now() - 360000),
        claimToken: "old-owner",
      },
    });
    expect(await runScheduledBatch()).toMatchObject({
      processed: 1,
      succeeded: 1,
    });
    expect(
      await db.job.findUniqueOrThrow({ where: { key: "scheduler-0" } }),
    ).toMatchObject({
      status: "DONE",
      claimToken: null,
      lockedAt: null,
      attempts: 1,
    });
  });

  it("bounds an actual transaction blocked behind another writer and keeps it recoverable", async () => {
    await jobs(1);
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holding = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(739421)::text`;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        acquired();
        await wait;
      },
      { timeout: 20000 },
    );
    await locked;
    const original = schedulerLimits.hardTimeoutMs;
    schedulerLimits.hardTimeoutMs = 8000;
    try {
      expect(await runScheduledBatch()).toMatchObject({
        status: "DEADLINE",
        claimed: 1,
        processed: 0,
        succeeded: 0,
        interrupted: 1,
      });
      expect(
        (await db.job.findUniqueOrThrow({ where: { key: "scheduler-0" } }))
          .status,
      ).toBe("RUNNING");
    } finally {
      schedulerLimits.hardTimeoutMs = original;
      release();
      await holding;
    }
    await db.job.update({
      where: { key: "scheduler-0" },
      data: { lockedAt: new Date(Date.now() - 360000) },
    });
    expect(await runScheduledBatch()).toMatchObject({
      processed: 1,
      succeeded: 1,
    });
  });

  it("lets an in-flight domain transaction finish beyond the old 25-second process limit", async () => {
    await jobs(1);
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holding = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(739421)::text`;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        acquired();
        await wait;
      },
      { timeout: 40000 },
    );
    await locked;
    // A real child process and DB transaction, within the existing 60s domain
    // budget. The scheduler must stop claiming new jobs, not kill this one.
    const timer = setTimeout(release, 28000);
    try {
      expect(await runScheduledBatch()).toMatchObject({
        status: "COMPLETED",
        processed: 1,
        succeeded: 1,
        interrupted: 0,
      });
      expect(
        await db.job.findUniqueOrThrow({ where: { key: "scheduler-0" } }),
      ).toMatchObject({ status: "DONE", attempts: 1 });
    } finally {
      clearTimeout(timer);
      release();
      await holding;
    }
  }, 45000);

  it("bounds claim recording contention and rolls back an unacknowledged claim", async () => {
    await jobs(1);
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holding = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'LOCK TABLE "AuditLog" IN ACCESS EXCLUSIVE MODE',
        );
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        acquired();
        await wait;
      },
      { timeout: 60000 },
    );
    await locked;
    // Hold the lock until the assertion finishes: an absolute 18s release races
    // child startup and can unlock before the 10s claim transaction expires.
    // Only this fixture's start allowance changes; claim DB limits stay 5s/10s.
    const originalBudget = schedulerLimits.budgetMs;
    schedulerLimits.budgetMs = 60000;
    try {
      expect(await runScheduledBatch()).toMatchObject({
        status: "FAILED",
        claimed: 0,
        processed: 0,
      });
      expect(
        await db.job.findUniqueOrThrow({ where: { key: "scheduler-0" } }),
      ).toMatchObject({ status: "PENDING", attempts: 0, claimToken: null });
    } finally {
      schedulerLimits.budgetMs = originalBudget;
      release();
      await holding;
    }
    expect(await runScheduledBatch()).toMatchObject({
      succeeded: 1,
      interrupted: 0,
    });
    expect(
      await db.job.findUniqueOrThrow({ where: { key: "scheduler-0" } }),
    ).toMatchObject({ status: "DONE", attempts: 1 });
  }, 40000);

  it("escalates a repeatedly killed job instead of reclaiming it forever", async () => {
    await jobs(1);
    await db.setting.create({
      data: { key: "automation", value: { maxAttempts: 2 } },
    });
    await db.job.update({
      where: { key: "scheduler-0" },
      data: {
        status: "RUNNING",
        lockedAt: new Date(Date.now() - 360000),
        claimToken: "killed-owner",
        attempts: 2,
      },
    });
    expect(await runScheduledBatch()).toMatchObject({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });
    const job = await db.job.findUniqueOrThrow({
      where: { key: "scheduler-0" },
    });
    expect(job).toMatchObject({
      status: "FAILED",
      claimToken: null,
      lockedAt: null,
    });
    expect(job.lastError).toContain("최대 실행 횟수");
    expect(
      await db.exceptionCase.count({
        where: { kind: "JOB", objectId: job.id },
      }),
    ).toBe(1);
    expect(await runScheduledBatch()).toMatchObject({ processed: 0 });
  });

  it.each([24000, 16000])(
    "acknowledges an already committed refund of %i after the worker dies at its retry ceiling",
    async (amount) => {
      const user = await db.user.create({
        data: {
          id: "refund-crash-user",
          name: "환불",
          email: "refund-crash@test.local",
        },
      });
      const application = await db.application.create({
        data: {
          userId: user.id,
          ticketType: "TRIPLE",
          paymentStatus: "REFUND_REQUESTED",
        },
      });
      const payment = await db.payment.create({
        data: {
          applicationId: application.id,
          amount: 24000,
          status: "PAID",
          key: "refund-crash-payment",
        },
      });
      const refund = await db.refund.create({
        data: { paymentId: payment.id, amount, reason: "중단 경계 회귀" },
      });
      await db.ticketEntry.create({
        data: {
          userId: user.id,
          applicationId: application.id,
          paymentId: payment.id,
          key: `refund-hold:${refund.id}`,
          kind: "REFUND_HOLD",
          units: -1,
        },
      });
      const job = await db.job.create({
        data: {
          key: "refund-crash-job",
          kind: "REFUND",
          payload: { refundId: refund.id },
          status: "RUNNING",
          attempts: 3,
          claimToken: "dead-worker",
          lockedAt: new Date(),
          runAt: new Date(0),
        },
      });
      // Business effects committed, but the process died before marking Job DONE.
      await atomic((tx) => completeMockRefund(tx, refund.id));
      await db.job.update({
        where: { id: job.id },
        data: { lockedAt: new Date(Date.now() - 360000) },
      });
      const entriesBefore = await db.ticketEntry.count();
      const noticesBefore = await db.notification.count();
      expect(await tickDetailed()).toMatchObject({ outcome: "succeeded" });
      expect(
        await db.job.findUniqueOrThrow({ where: { id: job.id } }),
      ).toMatchObject({
        status: "DONE",
        claimToken: null,
        lockedAt: null,
        lastError: null,
      });
      expect(
        (await db.refund.findUniqueOrThrow({ where: { id: refund.id } }))
          .status,
      ).toBe("REFUNDED");
      expect(
        (await db.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe(amount === 24000 ? "REFUNDED" : "PARTIALLY_REFUNDED");
      expect(
        (
          await db.application.findUniqueOrThrow({
            where: { id: application.id },
          })
        ).paymentStatus,
      ).toBe("REFUNDED");
      expect(await db.ticketEntry.count()).toBe(entriesBefore);
      expect(await db.notification.count()).toBe(noticesBefore);
      expect(
        await db.exceptionCase.count({ where: { objectId: job.id } }),
      ).toBe(0);
    },
  );

  it("does not reset the parent deadline after delayed child startup", async () => {
    await jobs(1);
    let result: unknown;
    const cutoff = Date.now() + 100;
    const child = await runBoundedProcess(
      [
        "--import",
        "tsx",
        "--import",
        "data:text/javascript,await new Promise(resolve => setTimeout(resolve, 300));",
        `${process.cwd()}/src/worker/batch.ts`,
        "20",
        "20000",
        String(cutoff),
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 10000,
        onMessage(message) {
          result = message;
        },
      },
    );
    expect(child).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result).toMatchObject({
      type: "complete",
      reason: "deadline",
      counts: { claimed: 0, processed: 0 },
    });
    expect(
      await db.job.findUniqueOrThrow({ where: { key: "scheduler-0" } }),
    ).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("actually kills a blocked job process before resolving the timeout", async () => {
    let childPid = 0;
    const start = Date.now();
    const result = await runBoundedProcess(
      ["-e", "process.send({pid: process.pid}); while (true) {}"],
      {
        cwd: process.cwd(),
        timeoutMs: 1000,
        onMessage(message) {
          childPid = (message as { pid: number }).pid;
        },
      },
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("terminates the worker when the request is aborted", async () => {
    const controller = new AbortController();
    let childPid = 0;
    const result = await runBoundedProcess(
      ["-e", "process.send({pid: process.pid}); while (true) {}"],
      {
        cwd: process.cwd(),
        timeoutMs: 5000,
        signal: controller.signal,
        onMessage(message) {
          childPid = (message as { pid: number }).pid;
          controller.abort();
        },
      },
    );
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("skips expired REMINDER and START work after long sleep", async () => {
    const table = await oldTable();
    for (const kind of ["REMINDER", "START"]) {
      const job = await db.job.create({
        data: {
          key: `old-${kind}`,
          kind,
          payload: { tableId: table.id },
          runAt: new Date(0),
        },
      });
      await execute(job);
    }
    expect(await db.message.count()).toBe(0);
    expect(await db.notification.count()).toBe(0);
  });

  it("expires a previously queued reminder push after its meeting starts", async () => {
    const table = await oldTable();
    const user = await db.user.create({
      data: {
        id: "scheduler-user",
        name: "테스트",
        email: "scheduler@test.local",
      },
    });
    const notice = await db.notification.create({
      data: {
        userId: user.id,
        key: `reminder:${table.id}:application`,
        title: "우리 곧 만나요",
        body: "과거 모임",
        href: "/app",
      },
    });
    const job = await db.job.create({
      data: {
        key: "old-reminder-push",
        kind: "PUSH",
        payload: { notificationId: notice.id },
        runAt: new Date(0),
      },
    });
    await execute(job);
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: notice.id } }))
        .pushStatus,
    ).toBe("EXPIRED");
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("keeps continuous-worker liveness distinct from scheduled execution", () => {
    const now = Date.now();
    const settings = [
      { key: "workerHeartbeat", value: { at: new Date(now).toISOString() } },
      {
        key: "schedulerHeartbeat",
        value: {
          at: new Date(now - 100000).toISOString(),
          status: "COMPLETED",
          processed: 3,
          succeeded: 2,
          failed: 1,
        },
      },
    ];
    expect(automationStatus(settings, "worker", now)).toMatchObject({
      mode: "worker",
      online: true,
    });
    expect(automationStatus(settings, "scheduler", now)).toMatchObject({
      mode: "scheduler",
      online: true,
      processed: 3,
      succeeded: 2,
      failed: 1,
    });
    expect(
      automationStatus(settings.slice(0, 1), "scheduler", now).online,
    ).toBe(false);
    expect(automationStatus(settings, "scheduler", now + 180001).online).toBe(
      false,
    );
  });
});
