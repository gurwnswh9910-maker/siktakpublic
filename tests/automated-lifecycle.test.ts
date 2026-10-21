import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { db, atomic, type Actor } from "@/server/db";
import { command } from "@/server/commands";
import { participantView } from "@/server/views";
import { runMatch } from "@/server/match-run";
import { execute } from "@/worker/runner";
import {
  lifecycleFixture,
  observationSQL,
  prepareLifecycle,
  runParticipantLifecycle,
  verifyLifecycleEvidence,
} from "../scripts/verify-automated-lifecycle.mjs";

const day = 86400000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
beforeEach(async () => {
  // This reset belongs exclusively to the isolated test suite. The reusable
  // public harness never resets, truncates, deletes, or seed-updates a database.
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Lifecycle tests require an isolated _test database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
});
afterEach(() => vi.useRealTimers());
afterAll(() => db.$disconnect());

function actor(userId: string): Actor {
  return { id: userId, name: "합성 검증", role: "PARTICIPANT" };
}

describe("T05/T06 real wall-clock lifecycle with an independent worker", () => {
  it("completes two scheduled rounds, real reallocation, alternatives/refund and persisted exclusions without administrative intervention", async () => {
    const f = lifecycleFixture({ stepMs: 15000 });
    const baseline = await prepareLifecycle(db, f, `synthetic-${randomUUID()}`);
    const worker = spawn(
      process.execPath,
      ["--import", "tsx", "src/worker/index.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DEMO_MODE: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let errors = "";
    worker.stderr.on("data", (value: Buffer) => {
      errors += value.toString();
    });
    try {
      const report = await runParticipantLifecycle({
        fixture: f,
        send: (i: number, action: string, data: unknown) =>
          command(actor(f.userIds[i]), action, data),
        view: (i: number) => participantView(actor(f.userIds[i])),
      });
      expect(report.participantFlowPassed).toBe(true);
      expect(report.forbiddenActionsIssued).toBe(0);
      // Allow only the independent worker to drain final feedback PUSH jobs.
      let evidence;
      for (let i = 0; i < 30; i++) {
        const rows = await db.$queryRawUnsafe<
          { evidence: Record<string, unknown> }[]
        >(observationSQL(f));
        evidence = rows[0].evidence;
        const jobs = evidence.jobs as { runAt: string; status: string }[];
        if (
          jobs.every(
            (job) =>
              Date.parse(job.runAt) > Date.now() || job.status === "DONE",
          )
        )
          break;
        await sleep(500);
      }
      const checks = verifyLifecycleEvidence(f, evidence, baseline);
      expect(checks.databaseEvidencePassed).toBe(true);
      expect(checks.real24HourReminderWaitVerified).toBe(false);
      const retainedTickets = await participantView(
        actor(f.userIds[f.ticketLotUserIndex]),
      );
      expect(retainedTickets.ticketBalance).toBe(2);
      expect(retainedTickets.ticketLots).toHaveLength(1);
      expect(retainedTickets.ticketLots[0].id).toBe(
        checks.retainedTicketLot.paymentId,
      );
      expect(retainedTickets.ticketLots[0].units).toBe(2);
      expect(retainedTickets.ticketLots[0].expiresAt?.getTime()).toBe(
        Date.parse(checks.retainedTicketLot.expiresAt),
      );
      expect(errors).toBe("");
    } finally {
      worker.kill("SIGTERM");
      await Promise.race([
        once(worker, "exit"),
        sleep(5000).then(() => worker.kill("SIGKILL")),
      ]);
    }
  }, 150000);
});

// These are deliberately controlled-clock DB checks. Direct execution here
// verifies calendar arithmetic/branch boundaries; it is not external Cron or
// real 24-hour elapsed-time evidence and is not merged into the test above.
async function controlledFixture(startsInMs: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-10T00:00:00.000Z"));
  const now = Date.now();
  const f = lifecycleFixture();
  f.events.first.startsAt = new Date(now + startsInMs).toISOString();
  f.events.first.endsAt = new Date(now + startsInMs + 7200000).toISOString();
  const baseline = await prepareLifecycle(db, f, `synthetic-${randomUUID()}`);
  for (let i = 0; i < 4; i++) {
    await command(actor(f.userIds[i]), "apply", {
      requestId: f.applicationIds[i],
      eventIds: [f.events.first.id],
      ticketType: "SINGLE",
      consent: true,
    });
    await command(actor(f.userIds[i]), "pay", {
      requestId: `${f.applicationIds[i]}-pay`,
      applicationId: f.applicationIds[i],
    });
  }
  await atomic((tx) => runMatch(tx, f.events.first.id));
  const table = await db.diningTable.findFirstOrThrow({
    where: { eventId: f.events.first.id },
  });
  return { f, table, now, baseline };
}

describe("controlled-clock D-1 and next-day reminders (not real 24-hour waiting)", () => {
  it.each([
    { startsIn: 3 * day, expectedDelay: 2 * day, label: "future D-1" },
    { startsIn: day / 2, expectedDelay: 0, label: "already overdue D-1" },
  ])(
    "schedules $label from creation clock and end+24h exactly",
    async ({ startsIn, expectedDelay }) => {
      const { f, table, now } = await controlledFixture(startsIn);
      const reminder = await db.job.findUniqueOrThrow({
        where: { key: `reminder:${table.id}` },
      });
      const feedback = await db.job.findUniqueOrThrow({
        where: { key: `feedback-reminder:${table.id}` },
      });
      expect(reminder.runAt.getTime()).toBe(now + expectedDelay);
      expect(feedback.runAt.getTime()).toBe(
        Date.parse(f.events.first.endsAt) + day,
      );
      // Creating long after a scheduled match time must not backdate a notice.
      expect(reminder.runAt.getTime()).toBeGreaterThanOrEqual(now);
    },
  );

  it("delivers before start, expires at start, and never creates a stale reminder after start", async () => {
    const { f, table } = await controlledFixture(day / 2);
    const reminder = await db.job.findUniqueOrThrow({
      where: { key: `reminder:${table.id}` },
    });
    vi.setSystemTime(new Date(Date.parse(f.events.first.startsAt) - 1));
    await execute(reminder);
    expect(
      await db.notification.count({
        where: { key: { startsWith: `reminder:${table.id}:` } },
      }),
    ).toBe(4);
    const push = await db.job.findFirstOrThrow({
      where: { key: { startsWith: `push:reminder:${table.id}:` } },
    });
    vi.setSystemTime(new Date(f.events.first.startsAt));
    await execute(push);
    const payload = push.payload as { notificationId: string };
    expect(
      (
        await db.notification.findUniqueOrThrow({
          where: { id: payload.notificationId },
        })
      ).pushStatus,
    ).toBe("EXPIRED");
    // A fresh table never notified before start provides an independent check
    // of the execute(REMINDER) early return; the previous message is not reused.
    const second = await db.diningTable.create({
      data: {
        eventId: f.events.first.id,
        runId: table.runId,
        score: 1,
        evaluation: {},
        explanation: "boundary fixture",
        room: { create: {} },
      },
    });
    await execute({ ...reminder, payload: { tableId: second.id } });
    expect(
      await db.message.count({ where: { key: `reminder:${second.id}` } }),
    ).toBe(0);
  });

  it("next-day reminder targets attended nonresponders once, excluding submitted feedback and absent participants", async () => {
    const { f, table } = await controlledFixture(day / 2);
    vi.setSystemTime(new Date(f.events.first.startsAt));
    for (const i of [0, 1, 2])
      await command(actor(f.userIds[i]), "checkin", {
        applicationId: f.applicationIds[i],
      });
    vi.setSystemTime(new Date(f.events.first.endsAt));
    await command(actor(f.userIds[0]), "feedback", {
      applicationId: f.applicationIds[0],
      atmosphere: 4,
      conversation: 4,
      venue: 4,
      returnIntent: true,
      recommend: 8,
      comment: "제출 완료",
      liked: [],
      avoided: [],
    });
    const job = await db.job.findUniqueOrThrow({
      where: { key: `feedback-reminder:${table.id}` },
    });
    expect(job.runAt.getTime()).toBe(Date.now() + day);
    vi.setSystemTime(job.runAt);
    await execute(job);
    await execute(job);
    const notices = await db.notification.findMany({
      where: { key: { startsWith: "feedback-once:" } },
    });
    expect(notices.map((n) => n.userId).sort()).toEqual(
      [f.userIds[1], f.userIds[2]].sort(),
    );
    expect(
      await db.job.count({
        where: { key: { startsWith: "push:feedback-once:" } },
      }),
    ).toBe(2);
    expect(await db.exceptionCase.count()).toBe(0);
  });
});
