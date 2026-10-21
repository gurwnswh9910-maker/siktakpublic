import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { command } from "@/server/commands";
import { tick } from "@/worker/runner";
import {
  createDemoScenario,
  ensureDemoScenario,
  runDemoScenario,
} from "@/server/demo-scenario";

beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Demo scenario tests require an isolated _test database");
  vi.stubEnv("MATCH_EVALUATOR", "decisions-v1");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
});
afterAll(() => db.$disconnect());

async function drain() {
  for (let i = 0; i < 2000; i++) {
    if (await tick()) continue;
    const due = await db.job.count({
      where: { status: "PENDING", runAt: { lte: new Date() } },
    });
    if (!due) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function staff(role: string) {
  const user = await db.user.create({
    data: { id: `staff-${role}`, name: role, email: `${role}@test.demo`, role },
  });
  return { id: user.id, name: user.name, role };
}

async function judge() {
  const user = await db.user.create({
    data: {
      id: "judge-user",
      name: "심사자",
      email: "judge@test.demo",
      role: "PARTICIPANT",
      profile: {
        create: {
          contact: "010-0000-9999",
          birthYear: 1996,
          gender: "여성",
          occupation: "디자이너",
          mbti: ["ENFP"],
          interests: ["여행", "음식", "운동"],
          traits: ["편안한 대화", "새로운 경험"],
          desiredTraits: ["편안한 대화", "새로운 경험"],
          budgets: ["2만~3만원"],
          foodRestrictions: "없음",
          allergies: "없음",
          consentVersion: "2026-10-v1",
          consentAt: new Date(),
        },
      },
    },
  });
  return { id: user.id, name: user.name, role: "PARTICIPANT" };
}

async function joinAndMatch(
  eventId: string,
  participant: { id: string; name: string; role: string },
  operator: { id: string; name: string; role: string },
  tag: string,
) {
  await command(participant, "apply", {
    requestId: `judge-${tag}`,
    eventIds: [eventId],
    ticketType: "SINGLE",
    consent: true,
  });
  await command(participant, "pay", {
    applicationId: `judge-${tag}`,
    requestId: `judge-pay-${tag}`,
  });
  await command(operator, "demoAdvance", { eventId, phase: "MATCH" });
  await drain();
  const tables = await db.diningTable.findMany({
    where: { eventId, status: "CONFIRMED" },
    include: { applications: true, room: true },
  });
  const mine = tables.find((t) =>
    t.applications.some((a) => a.userId === participant.id),
  );
  return { tables, mine };
}

describe("judge demo scenario", () => {
  it("creates an open event with paid synthetic applicants only once per start", async () => {
    const admin = await staff("ADMIN");
    const first = await ensureDemoScenario(admin.id);
    expect(first?.applicants).toBe(11);
    expect(await ensureDemoScenario(admin.id)).toBeNull();
    const event = await db.eventSlot.findUniqueOrThrow({
      where: { id: first!.eventId },
      include: { venues: true },
    });
    expect(event.status).toBe("OPEN");
    expect(event.closesAt.getTime()).toBeGreaterThan(Date.now());
    expect(event.venues[0]?.demo).toBe(true);
    const paid = await db.application.count({
      where: {
        paymentStatus: "PAID",
        options: { some: { eventId: event.id } },
      },
    });
    expect(paid).toBe(11);
  });

  it("is limited to operators", async () => {
    const participant = await judge();
    await expect(runDemoScenario(participant.id)).rejects.toThrow(
      "접근 권한이 없습니다.",
    );
    const ops = await staff("OPERATIONS");
    await expect(runDemoScenario(ops.id)).resolves.toMatchObject({
      applicants: 11,
    });
  });

  it("runs match → start → end → feedback and applies the avoid relation to the next scenario", async () => {
    const admin = await staff("ADMIN");
    const participant = await judge();
    const s1 = await createDemoScenario(admin.id);
    const r1 = await joinAndMatch(s1.eventId, participant, admin, "r1");
    expect(r1.mine).toBeTruthy();
    for (const t of r1.tables) {
      expect(t.applications.length).toBeGreaterThanOrEqual(4);
      expect(t.applications.length).toBeLessThanOrEqual(6);
      expect(t.venueSlotId).toBeTruthy();
      expect(t.room).toBeTruthy();
    }
    await command(admin, "demoAdvance", { eventId: s1.eventId, phase: "START" });
    await drain();
    const content = await db.message.count({
      where: { room: { tableId: r1.mine!.id }, kind: "CONTENT" },
    });
    expect(content).toBe(3);
    const own = r1.mine!.applications.find((a) => a.userId === participant.id)!;
    await command(participant, "checkin", { applicationId: own.id });
    await command(admin, "demoAdvance", { eventId: s1.eventId, phase: "END" });
    await drain();
    const avoided = r1.mine!.applications.find(
      (a) => a.userId !== participant.id,
    )!.userId;
    await command(participant, "feedback", {
      applicationId: own.id,
      atmosphere: 5,
      conversation: 4,
      venue: 4,
      returnIntent: true,
      recommend: 9,
      comment: "",
      liked: [],
      avoided: [avoided],
    });

    const s2 = await createDemoScenario(admin.id);
    expect(s2.returning).toBe(11);
    const r2 = await joinAndMatch(s2.eventId, participant, admin, "r2");
    expect(r2.mine).toBeTruthy();
    expect(r2.mine!.applications.some((a) => a.userId === avoided)).toBe(
      false,
    );
  }, 120000);
});
