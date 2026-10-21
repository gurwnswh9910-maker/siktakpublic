import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  applicationMatchHistory,
  captureMatchFacts,
  projectMatchFacts,
} from "@/server/match-facts";
import { atomic, db } from "@/server/db";
import { runMatch } from "@/server/match-run";
import { invalidateTable } from "@/server/commands";
import { adminView, participantView } from "@/server/views";

const instant = new Date("2027-01-01T15:30:00.000Z");
const event = {
  id: "event",
  region: "홍대",
  startsAt: instant,
  endsAt: new Date(instant.getTime() + 7200000),
};
const audit = (
  action: string,
  index: number,
  after: Record<string, unknown> = {},
) => ({
  objectId: "a0",
  action,
  createdAt: new Date(instant.getTime() + index * 1000),
  after: { factsVersion: 1, ...after },
});
const initialHistory = () =>
  applicationMatchHistory("a0", [audit("MATCH_STARTED", 0)]);
const members = (count = 4) =>
  Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    userId: `u${i}`,
    name: `참가자${i}`,
    age: 24 + (i % 4),
    gender: i % 2 ? "남성" : "여성",
    mbti: i === 0 ? ["ENTJ", "INTJ"] : ["ENFP"],
    interests: i < 2 ? ["음식", "여행", "여행"] : ["음식", "영화"],
    traits: ["미공개 성향"],
    desiredTraits: ["미공개 희망"],
    budgets: ["2만~3만원"],
    foodRestrictions: "없음",
    allergies: "없음",
    selectedEvents: [{ ...event }],
    paymentStatus: "PAID",
    applicationStatus: "SUBMITTED",
    consented: true,
    restriction: "NONE",
    history: initialHistory(),
  }));
const capture = (group = members()) =>
  captureMatchFacts({
    event,
    members: group,
    relations: [],
    occupiedUserIds: new Set(),
    confirmedAt: instant,
    finalReason: "동의한 일정과 필수 조건 충족",
  });

describe("immutable matching facts and private preference fulfillment", () => {
  it.each([4, 5, 6])(
    "captures %i members with factual composition and constraints",
    (count) => {
      const facts = capture(members(count));
      expect(facts.headcount).toBe(count);
      expect(facts.genderComposition.reduce((s, x) => s + x.count, 0)).toBe(
        count,
      );
      expect(facts.mbtiComposition.reduce((s, x) => s + x.count, 0)).toBe(
        count,
      );
      expect(facts.mbtiComposition).toContainEqual({
        value: "ENTJ / INTJ",
        count: 1,
      });
      expect(facts.commonInterests).toContainEqual({
        interest: "음식",
        participantCount: count,
      });
      expect(facts.commonInterests).toContainEqual({
        interest: "여행",
        participantCount: 2,
      });
      expect(Object.values(facts.constraints).every(Boolean)).toBe(true);
      expect(facts.members[0].preferenceFulfillment).toMatchObject([
        {
          desire: "미공개 희망",
          satisfied: false,
          reason: { kind: "TRAIT", matchedCount: 0, comparedCount: count - 1 },
        },
      ]);
      expect(JSON.stringify(facts)).not.toContain("미공개 성향");
      expect(projectMatchFacts({ facts })).toEqual(facts);
    },
  );

  it("keeps legacy reasons absent and strips unrelated private reason fields", () => {
    const facts = capture();
    const item = facts.members[0].preferenceFulfillment![0];
    delete item.reason;
    expect(
      projectMatchFacts({ facts })?.members[0].preferenceFulfillment?.[0],
    ).toEqual({
      desire: "미공개 희망",
      satisfied: false,
    });
    const newer = capture();
    Object.assign(newer.members[0].preferenceFulfillment![0].reason!, {
      privatePeerUserId: "secret-peer",
      privatePeerPreference: "secret-wish",
    });
    const projected = JSON.stringify(projectMatchFacts({ facts: newer }));
    expect(projected).not.toContain("secret-peer");
    expect(projected).not.toContain("secret-wish");
  });

  it("captures the independent age boundary and consented event combination", () => {
    const group = members();
    group[0].age = 20;
    group[1].age = 28;
    expect(capture(group).age).toEqual({ minimum: 20, maximum: 28, gap: 8 });
    expect(capture(group).constraints.ageGap).toBe(true);
    group[1].age = 29;
    group[0].selectedEvents = [
      { ...event, id: "same-date", region: "다른 지역" },
      {
        ...event,
        id: "same-region",
        startsAt: new Date("2027-01-03T00:00:00Z"),
      },
    ];
    const facts = capture(group);
    expect(facts.constraints.ageGap).toBe(false);
    expect(facts.members[0]).toMatchObject({
      dateSatisfied: true,
      regionSatisfied: true,
      selectedCombinationSatisfied: false,
    });
    expect(facts.constraints.scheduleConsent).toBe(false);
  });

  it.each(["BLOCK", "REPORT", "AVOID"])(
    "records %s conflicts without exposing who excluded whom",
    (kind) => {
      const facts = captureMatchFacts({
        event,
        members: members(),
        relations: [{ fromId: "u0", toId: "u1", kind, active: true }],
        occupiedUserIds: new Set(["u2"]),
        confirmedAt: instant,
        finalReason: "test",
      });
      expect(facts.constraints.noExcludedRelationship).toBe(false);
      expect(facts.constraints.noOverlappingAssignment).toBe(false);
      expect(JSON.stringify(facts)).not.toContain(kind);
    },
  );

  it("deduplicates prior meeting directions and ignores inactive/outside pairs", () => {
    const facts = captureMatchFacts({
      event,
      members: members(),
      relations: [
        { fromId: "u0", toId: "u1", kind: "MET", active: true },
        { fromId: "u1", toId: "u0", kind: "MET", active: true },
        { fromId: "u0", toId: "outside", kind: "MET", active: true },
        { fromId: "u2", toId: "u3", kind: "MET", active: false },
      ],
      occupiedUserIds: new Set(),
      confirmedAt: instant,
      finalReason: "test",
    });
    expect(facts.priorMeetings).toEqual([{ fromId: "u0", toId: "u1" }]);
  });

  it("never substitutes edited current profile/options or legacy evaluations for snapshots", () => {
    const group = members();
    const facts = capture(group);
    group[0].name = "변경된 이름";
    group[0].age = 50;
    group[0].mbti.push("ESFJ");
    group[0].selectedEvents[0].region = "변경된 지역";
    group[0].history.reallocationCount = 99;
    expect(facts.members[0]).toMatchObject({
      name: "참가자0",
      age: 24,
      mbti: ["ENTJ", "INTJ"],
      selectedEvents: [
        {
          ...event,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
        },
      ],
      history: { reallocationCount: 0 },
    });
    expect(
      projectMatchFacts({ members: group, reallocationRank: 4, valid: true }),
    ).toBeNull();
    expect(projectMatchFacts({ facts: { version: 1 } })).toBeNull();
  });

  it("counts actual successful reassignments 0/1/multiple, never rank or failed searches", () => {
    const history = [
      audit("MATCH_STARTED", 0),
      audit("MATCH_CONFIRMED", 1, { reason: "초기 확정" }),
    ];
    expect(applicationMatchHistory("a0", history).reallocationCount).toBe(0);
    history.push(audit("REALLOCATION_STARTED", 2, { rank: 4 }));
    expect(applicationMatchHistory("a0", history).reallocationCount).toBe(0);
    history.push(
      audit("REALLOCATED", 3, { rank: 4, reason: "동의 일정 이동" }),
    );
    expect(applicationMatchHistory("a0", history).reallocationCount).toBe(1);
    history.push(
      audit("REALLOCATED", 4, { rank: 0, reason: "같은 일정 재편성" }),
    );
    history.push(
      audit("MATCH_UNRESOLVED", 5, { reason: "남은 유효 조합 없음" }),
    );
    const result = applicationMatchHistory("a0", history);
    expect(result).toMatchObject({
      reallocationCount: 2,
      recordedReallocationCount: 2,
      confirmedAt: history[1].createdAt.toISOString(),
      failedAt: history[5].createdAt.toISOString(),
      lastReallocationReason: "같은 일정 재편성",
      finalReason: "남은 유효 조합 없음",
    });
    expect(
      applicationMatchHistory("other", history).reallocationCount,
    ).toBeNull();
  });

  it("marks incomplete legacy counts/reasons unknown while retaining recorded times", () => {
    const old = {
      ...audit("MATCH_CONFIRMED", 0),
      after: { reallocationRank: 4 },
    };
    const history = [
      old,
      audit("REALLOCATED", 1, { reason: "새로 기록한 재배치" }),
    ];
    expect(applicationMatchHistory("a0", history)).toMatchObject({
      reallocationCount: null,
      recordedReallocationCount: 1,
      confirmedAt: old.createdAt.toISOString(),
      finalReason: null,
    });
  });
});

const operator = { id: "facts-admin", name: "관리자", role: "ADMIN" };
const actors = Array.from({ length: 4 }, (_, i) => ({
  id: `facts-u${i}`,
  name: `원래 이름${i}`,
  role: "PARTICIPANT",
}));

describe("persisted match snapshots and role boundaries", () => {
  beforeEach(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
      throw new Error("Test database required");
    await db.$executeRawUnsafe(
      'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
    );
    const start = new Date(Date.now() + 7 * 86400000);
    for (let index = 0; index < 2; index++) {
      const startsAt = new Date(start.getTime() + index * 86400000);
      await db.eventSlot.create({
        data: {
          id: `facts-e${index}`,
          title: "사실 표시 시험",
          region: index ? "성수" : "홍대",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 7200000),
          closesAt: new Date(startsAt.getTime() - 86400000),
          matchAt: new Date(startsAt.getTime() - 86400000),
          cancelRefundCutoffAt: new Date(startsAt.getTime() - 172800000),
          venues: {
            create: {
              name: "가상 식당",
              address: "시험",
              mapUrl: "https://map.naver.com",
              reservationName: "시험",
              price: 25000,
              capacity: 6,
              totalTables: 5,
              dietaryNotes: "없음",
            },
          },
        },
      });
    }
    for (let i = 0; i < actors.length; i++) {
      await db.user.create({
        data: {
          ...actors[i],
          email: `facts-${i}@test.local`,
          profile: {
            create: {
              contact: "01000000000",
              birthYear: 1995 + i,
              gender: i % 2 ? "남성" : "여성",
              occupation: "시험",
              mbti: [i % 2 ? "ENFP" : "INTJ"],
              interests: ["음식", "여행"],
              traits: ["편안한 대화"],
              desiredTraits: ["편안한 대화"],
              budgets: ["2만~3만원"],
              foodRestrictions: "없음",
              allergies: i ? "없음" : "땅콩",
              consentVersion: "test",
              consentAt: new Date(),
            },
          },
        },
      });
      await db.application.create({
        data: {
          id: `facts-a${i}`,
          userId: actors[i].id,
          applicationStatus: "SUBMITTED",
          paymentStatus: "PAID",
          ticketType: "SINGLE",
          options: { create: { eventId: "facts-e0" } },
        },
      });
    }
  }, 30000);

  it("stores immutable facts and exposes them only to operations/admin, including legacy unknowns", async () => {
    await db.relationship.create({
      data: {
        fromId: actors[0].id,
        toId: actors[1].id,
        kind: "MET",
        sourceId: "past-meeting",
      },
    });
    await atomic((tx) => runMatch(tx, "facts-e0"));
    const table = await db.diningTable.findFirstOrThrow();
    const facts = projectMatchFacts(table.evaluation)!;
    expect(facts.priorMeetings).toHaveLength(1);
    expect(facts.members.find((m) => m.userId === actors[0].id)).toMatchObject({
      name: "원래 이름0",
      allergies: "땅콩",
      history: { reallocationCount: 0 },
    });
    await db.profile.update({
      where: { userId: actors[0].id },
      data: {
        birthYear: 1980,
        mbti: ["ESFJ"],
        interests: ["변경"],
        allergies: "변경",
      },
    });
    await db.user.update({
      where: { id: actors[0].id },
      data: { name: "새 이름" },
    });
    await db.applicationOption.deleteMany({
      where: { applicationId: "facts-a0" },
    });
    await db.relationship.create({
      data: {
        fromId: actors[0].id,
        toId: actors[2].id,
        kind: "AVOID",
        sourceId: "private-feedback",
      },
    });
    // A different table can notify the same person. Neither shared recipients
    // nor a table-ID prefix may attach its message/job to this table.
    await db.notification.create({
      data: {
        userId: actors[0].id,
        key: `confirmed:${table.id}-other:facts-a0`,
        title: "다른 테이블 안내",
        body: "현재 테이블에 표시되면 안 됩니다.",
        href: "/app",
      },
    });
    const foreignJob = await db.job.create({
      data: {
        key: "facts-foreign-table-reminder",
        kind: "REMINDER",
        payload: { tableId: `${table.id}-other` },
        runAt: new Date(),
      },
    });
    const administrator = await adminView(operator);
    const operations = await adminView({ ...operator, role: "OPERATIONS" });
    const safety = await adminView({ ...operator, role: "SAFETY" });
    const participant = await participantView(actors[0]);
    expect(administrator.tables[0].matchFacts).toEqual(facts);
    expect(operations.tables[0].matchFacts).toEqual(facts);
    const tableView = administrator.tables[0];
    const actualNotices = await db.notification.findMany({
      where: { key: { startsWith: `confirmed:${table.id}:` } },
    });
    expect(tableView.notices.map((n) => n.id).sort()).toEqual(
      actualNotices.map((n) => n.id).sort(),
    );
    expect(tableView.notices.map((n) => n.userId).sort()).toEqual(
      actors.map((a) => a.id).sort(),
    );
    expect(tableView.notices.every((n) => n.pushStatus === "PENDING")).toBe(
      true,
    );
    expect(tableView.noticeJobs.map((j) => j.kind).sort()).toEqual([
      "END",
      "FEEDBACK_REMINDER",
      "REMINDER",
      "START",
    ]);
    const actualJobs = await db.job.findMany({
      where: {
        key: {
          in: ["reminder", "start", "end", "feedback-reminder"].map(
            (kind) => `${kind}:${table.id}`,
          ),
        },
      },
    });
    expect(tableView.noticeJobs.map((j) => j.id).sort()).toEqual(
      actualJobs.map((j) => j.id).sort(),
    );
    expect(
      tableView.noticeJobs.every(
        (j) => j.status === "PENDING" && !j.completedAt,
      ),
    ).toBe(true);
    expect(tableView.noticeJobs.some((j) => j.id === foreignJob.id)).toBe(
      false,
    );
    const welcome = await db.message.findUniqueOrThrow({
      where: { key: `welcome:${table.id}` },
    });
    expect(tableView.room!.messages).toContainEqual(welcome);
    expect(welcome).toMatchObject({ kind: "SYSTEM" });
    expect(welcome.body).toContain("예약명:");
    expect(welcome.body).toContain("가상 식당");
    expect(operations.tables[0].notices).toEqual(tableView.notices);
    expect(operations.tables[0].noticeJobs).toEqual(tableView.noticeJobs);
    expect(safety.tables).toEqual([]);
    expect(safety.applications).toEqual([]);
    expect(operations.safetyRelationships).toEqual([]);
    expect(safety.safetyRelationships.map((r) => r.kind)).toEqual(["AVOID"]);
    expect(administrator.safetyRelationships.map((r) => r.kind)).toEqual([
      "AVOID",
    ]);
    expect(participant.applications[0]).not.toHaveProperty("matchHistory");
    expect(participant.applications[0].table).not.toHaveProperty("evaluation");
    expect(participant.applications[0].table).not.toHaveProperty("matchFacts");
    await expect(adminView(actors[0])).rejects.toMatchObject({ status: 403 });
    expect(
      (await db.diningTable.findUniqueOrThrow({ where: { id: table.id } }))
        .evaluation,
    ).toEqual(table.evaluation);
    await db.diningTable.update({
      where: { id: table.id },
      data: { evaluation: { members: [], valid: true } },
    });
    expect((await adminView(operator)).tables[0].matchFacts).toBeNull();
  });

  it("counts alternative assignment once at search rank four and subsequent same-event repairs", async () => {
    await db.applicationOption.createMany({
      data: actors.map((_, i) => ({
        applicationId: `facts-a${i}`,
        eventId: "facts-e1",
      })),
    });
    await db.applicationOption.delete({
      where: {
        applicationId_eventId: {
          applicationId: "facts-a3",
          eventId: "facts-e0",
        },
      },
    });
    await atomic((tx) => runMatch(tx, "facts-e0"));
    let table = await db.diningTable.findFirstOrThrow({
      where: { status: "CONFIRMED" },
    });
    expect(table.eventId).toBe("facts-e1");
    expect(
      (table.evaluation as { reallocationRank: number }).reallocationRank,
    ).toBe(4);
    let facts = projectMatchFacts(table.evaluation)!;
    expect(
      facts.members.find((m) => m.applicationId === "facts-a0")!.history
        .reallocationCount,
    ).toBe(1);
    expect(
      facts.members.find((m) => m.applicationId === "facts-a3")!.history
        .reallocationCount,
    ).toBe(0);
    for (let count = 2; count <= 3; count++) {
      const oldId = table.id;
      await atomic(async (tx) => {
        await invalidateTable(tx, oldId, "SYSTEM", true);
        await runMatch(tx, "facts-e1");
      });
      table = await db.diningTable.findFirstOrThrow({
        where: { status: "CONFIRMED" },
      });
      facts = projectMatchFacts(table.evaluation)!;
      expect(table.id).not.toBe(oldId);
      expect(
        facts.members.find((m) => m.applicationId === "facts-a0")!.history
          .reallocationCount,
      ).toBe(count);
      expect(
        facts.members.find((m) => m.applicationId === "facts-a3")!.history
          .reallocationCount,
      ).toBe(count - 1);
    }
    const currentView = await adminView(operator);
    const histories = currentView.applications;
    const persistedJobs = await db.job.findMany();
    const persistedNotices = await db.notification.findMany();
    for (const historicalTable of currentView.tables) {
      expect(historicalTable.noticeJobs.map((j) => j.id).sort()).toEqual(
        persistedJobs
          .filter(
            (j) =>
              (j.payload as { tableId?: string }).tableId ===
              historicalTable.id,
          )
          .map((j) => j.id)
          .sort(),
      );
      expect(historicalTable.notices.map((n) => n.id).sort()).toEqual(
        persistedNotices
          .filter((n) => n.key.startsWith(`confirmed:${historicalTable.id}:`))
          .map((n) => n.id)
          .sort(),
      );
    }
    expect(
      histories.find((a) => a.id === "facts-a0")!.matchHistory
        .reallocationCount,
    ).toBe(3);
    expect(
      await db.auditLog.count({
        where: { action: "REALLOCATED", objectId: "facts-a0" },
      }),
    ).toBe(3);
  });

  it("records actual unresolved timestamp and reason without a fabricated table snapshot", async () => {
    await db.application.update({
      where: { id: "facts-a3" },
      data: { applicationStatus: "CANCELED" },
    });
    const before = Date.now();
    await atomic((tx) => runMatch(tx, "facts-e0"));
    const after = Date.now();
    const view = await adminView(operator);
    const history = view.applications.find(
      (a) => a.id === "facts-a0",
    )!.matchHistory;
    expect(history.confirmedAt).toBeNull();
    expect(history.failedAt).not.toBeNull();
    expect(new Date(history.failedAt!).getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(new Date(history.failedAt!).getTime()).toBeLessThanOrEqual(after);
    expect(history.finalReason).toContain("테이블");
    expect(history.reallocationCount).toBe(0);
    expect(view.tables).toHaveLength(0);
  });
});
afterAll(() => db.$disconnect());
