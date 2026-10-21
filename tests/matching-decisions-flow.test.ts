import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
import { db, atomic } from "@/server/db";
import { runMatch } from "@/server/match-run";
import {
  inspectAllocation,
  createAllocatedTable,
} from "@/server/table-allocation";
import { command, invalidateTable } from "@/server/commands";
import * as exact from "@/domain/matching-exact";
import {
  defaultPolicy,
  policySchema,
  MATCHING_VERSION,
} from "@/domain/matching-policy";
import { matchDay, loadMatchingPolicy } from "@/server/matching-policy";
const start = new Date(Date.now() + 5 * 86400000);
function expectFixedSnapshot(value: unknown) {
  const policy = policySchema.parse(value);
  expect(policy.version).toBe(defaultPolicy.version);
  expect(policy.minimum).toBe(20);
  expect(policy.loneGenderMultiplier).toBe(0);
  // JSON/DB serialization may round the final binary floating-point digit.
  policy.weights.forEach((value, i) =>
    expect(value).toBeCloseTo(defaultPolicy.weights[i], 14),
  );
}

async function event(id: string, date = start, capacity = 6, tables = 2) {
  return db.eventSlot.create({
    data: {
      id,
      title: id,
      region: id,
      startsAt: date,
      endsAt: new Date(+date + 7200000),
      closesAt: new Date(Date.now() - 1000),
      matchAt: new Date(Date.now() - 1000),
      cancelRefundCutoffAt: new Date(+date - 172800000),
      capacity,
      venues: {
        create: {
          id: `v-${id}`,
          name: "테스트",
          address: "가상",
          mapUrl: "https://example.com",
          reservationName: "테스트",
          price: 20000,
          capacity: 6,
          totalTables: tables,
          dietaryNotes: "",
        },
      },
    },
  });
}
async function applicant(i: number, events = ["e0"], deferredCount = 0) {
  await db.user.create({
    data: {
      id: `u${i}`,
      name: `가상${i}`,
      email: `new-match-${i}@test.local`,
      profile: {
        create: {
          contact: "01000000000",
          birthYear: 1996,
          gender: i % 2 ? "남성" : "여성",
          occupation: "테스트",
          mbti: [i % 2 ? "ENTJ" : "INTJ"],
          interests: ["여행"],
          traits: ["활기찬 사람"],
          desiredTraits: ["열정 있는 사람"],
          budgets: ["2만원"],
          foodRestrictions: "없음",
          allergies: "없음",
          consentVersion: "test",
          consentAt: new Date(),
        },
      },
    },
  });
  await db.application.create({
    data: {
      id: `a${i}`,
      userId: `u${i}`,
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      ticketType: "SINGLE",
      deferredCount,
      options: { create: events.map((eventId) => ({ eventId })) },
    },
  });
}
beforeEach(async () => {
  vi.stubEnv("MATCH_EVALUATOR", MATCHING_VERSION);
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Not a test database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await event("e0");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());

it("integrates the joint regional plan and persists policy and proofs", async () => {
  await db.setting.create({
    data: {
      key: "notificationTemplates",
      value: { curation: "맞춤 안내 테스트" },
    },
  });
  await event("e1", start, 4, 1);
  for (let i = 0; i < 8; i++)
    await applicant(i, i < 4 ? ["e0"] : i < 6 ? ["e0", "e1"] : ["e1"]);
  await atomic((tx) => runMatch(tx, "e0"));
  expect(
    await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
  ).toBe(8);
  const tables = await db.diningTable.findMany({
    include: { applications: true },
  });
  expect(tables.map((t) => t.applications.length)).toEqual([4, 4]);
  for (const t of tables)
    expect(t.evaluation).toMatchObject({
      version: MATCHING_VERSION,
      policy: { minimum: 20 },
    });
  const run = await db.matchRun.findFirstOrThrow();
  expect(run.result).toMatchObject({ optimal: true, limited: false });
  await atomic((tx) => runMatch(tx, "e1"));
  expect(await db.diningTable.count()).toBe(2);
  expect(
    await db.message.count({
      where: { body: { contains: "맞춤 안내 테스트" } },
    }),
  ).toBe(2);
  expect(
    await db.notification.count({
      where: { key: { startsWith: "confirmed:" } },
    }),
  ).toBe(8);
});
it("does not confirm a later date early, counts one deferral and prevents rerun inflation", async () => {
  const future = new Date(+start + 86400000);
  await event("later", future);
  for (let i = 0; i < 3; i++) await applicant(i, ["e0", "later"]);
  await applicant(3, ["later"]);
  await atomic((tx) => runMatch(tx, "e0"));
  expect(await db.diningTable.count()).toBe(0);
  expect(
    await db.application.findUnique({ where: { id: "a0" } }),
  ).toMatchObject({
    matchStatus: "WAITING",
    paymentStatus: "PAID",
    deferredCount: 1,
    lastDeferredDate: matchDay(start),
  });
  await atomic((tx) => runMatch(tx, "e0"));
  expect(
    await db.application.findUnique({ where: { id: "a0" } }),
  ).toMatchObject({ deferredCount: 1 });
  await atomic((tx) => runMatch(tx, "later"));
  expect(
    await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
  ).toBe(4);
});
it("offers explicit alternatives for repeated deferral conflicts and preserves hard exclusions", async () => {
  for (let i = 0; i < 5; i++) await applicant(i, ["e0"], i < 2 ? 1 : 0);
  await db.relationship.create({
    data: { fromId: "u0", toId: "u1", kind: "BLOCK", sourceId: "test" },
  });
  await atomic((tx) => runMatch(tx, "e0"));
  const missed = await db.application.findFirstOrThrow({
    where: { matchStatus: "ALTERNATIVE_OFFERED" },
  });
  expect(missed.deferredCount).toBe(2);
  expect(missed.reason).toContain("경합");
  expect(await db.exceptionCase.count({ where: { objectId: missed.id } })).toBe(
    1,
  );
});
it("does not consume or settle any applicants after a non-optimal solve", async () => {
  for (let i = 0; i < 4; i++) await applicant(i);
  vi.spyOn(exact, "composeExact").mockRejectedValueOnce(
    new exact.MatchingIncomplete("Time limit", [
      { name: "participants", status: "Time limit reached" },
    ]),
  );
  await atomic((tx) => runMatch(tx, "e0"));
  expect(await db.diningTable.count()).toBe(0);
  expect(
    await db.application.count({
      where: {
        paymentStatus: "PAID",
        matchStatus: "WAITING",
        deferredCount: 0,
      },
    }),
  ).toBe(4);
  expect(await db.matchRun.findFirst()).toMatchObject({ status: "INCOMPLETE" });
  expect(await db.exceptionCase.count()).toBe(1);
});
it("applies minimum quality to manual preview and commit and cancellation", async () => {
  for (let i = 0; i < 5; i++) await applicant(i);
  for (let i = 0; i < 5; i++)
    await db.profile.update({
      where: { userId: `u${i}` },
      data: {
        mbti: ["ENTJ"],
        interests: [`개별 관심사 ${i}`],
        desiredTraits: ["차분한 사람"],
      },
    });
  const group = {
    eventId: "e0",
    venueSlotId: "v-e0",
    applicationIds: ["a0", "a1", "a2", "a3", "a4"],
  };
  const table = await atomic((tx) =>
    createAllocatedTable(tx, {
      ...group,
      source: "MANUAL",
      reason: "테스트",
      actorId: "operator",
    }),
  );
  await db.application.update({
    where: { id: "a1" },
    data: { applicationStatus: "CANCELED", tableId: null },
  });
  const state = await atomic((tx) =>
    inspectAllocation(
      tx,
      { ...group, applicationIds: ["a0", "a2", "a3", "a4"] },
      [table.id],
    ),
  );
  expect(state.issues).toContain("최소 매칭 점수를 충족하지 못했습니다.");
  await atomic((tx) => invalidateTable(tx, table.id, "SYSTEM"));
  expect(
    await db.diningTable.findUnique({ where: { id: table.id } }),
  ).toMatchObject({ status: "REALLOCATING" });
});
it("allows equivalent fixed policy writes and rejects participant edits", async () => {
  await db.user.create({
    data: {
      id: "operator",
      name: "운영",
      email: "operator@test.local",
      role: "OPERATIONS",
    },
  });
  const actor = { id: "operator", name: "운영", role: "OPERATIONS" };
  await command(actor, "setting", {
    key: "matchingPolicy",
    value: { minimum: 20, weights: [25, 13, 7, 3] },
  });
  expectFixedSnapshot(
    (await db.setting.findUniqueOrThrow({ where: { key: "matchingPolicy" } }))
      .value,
  );
  await expect(
    command(actor, "setting", {
      key: "matchingPolicy",
      value: { weights: [0, 0, 0, 0] },
    }),
  ).rejects.toThrow();
  await applicant(0);
  await expect(
    command({ id: "u0", name: "가상", role: "PARTICIPANT" }, "setting", {
      key: "matchingPolicy",
      value: {},
    }),
  ).rejects.toThrow();
});

it("lets the operator recover venue shortage without losing applicants or charging again", async () => {
  await db.user.create({
    data: {
      id: "operator",
      name: "운영",
      email: "operator@test.local",
      role: "OPERATIONS",
    },
  });
  for (let i = 0; i < 4; i++) await applicant(i);
  await db.venueSlot.deleteMany();
  await atomic((tx) => runMatch(tx, "e0"));
  const issue = await db.exceptionCase.findUniqueOrThrow({
    where: { key: "venue:e0" },
  });
  await db.venueSlot.create({
    data: {
      id: "restored",
      eventId: "e0",
      name: "복구 식당",
      address: "합성",
      mapUrl: "https://example.com",
      reservationName: "합성",
      price: 20000,
      capacity: 6,
      totalTables: 2,
      dietaryNotes: "",
    },
  });
  await command(
    { id: "operator", name: "운영", role: "OPERATIONS" },
    "retryMatch",
    { exceptionId: issue.id },
  );
  await atomic((tx) => runMatch(tx, "e0"));
  expect(
    await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
  ).toBe(4);
  expect(await db.payment.count()).toBe(0);
  expect(
    await db.exceptionCase.findUnique({ where: { id: issue.id } }),
  ).toMatchObject({ status: "RESOLVED" });
});

it("lets the operator retry an incomplete solve without changing the fixed policy", async () => {
  await db.user.create({
    data: {
      id: "operator",
      name: "운영",
      email: "operator@test.local",
      role: "OPERATIONS",
    },
  });
  await event("future", new Date(+start + 86400000));
  await db.eventSlot.update({
    where: { id: "future" },
    data: { matchAt: new Date(+start + 3600000) },
  });
  for (let i = 0; i < 4; i++) await applicant(i, ["e0", "future"]);
  const failure = vi
    .spyOn(exact, "composeExact")
    .mockRejectedValueOnce(new exact.MatchingIncomplete("한도 초과"));
  await atomic((tx) => runMatch(tx, "e0"));
  failure.mockRestore();
  const issue = await db.exceptionCase.findFirstOrThrow({
    where: { kind: "MATCHING", status: "OPEN" },
  });
  await command(
    { id: "operator", name: "운영", role: "OPERATIONS" },
    "retryMatch",
    { exceptionId: issue.id },
  );
  const retryJobs = await db.job.findMany({
    where: { key: { startsWith: `retry-match:${issue.id}:` } },
  });
  expect(retryJobs.map((job) => job.payload)).toEqual([{ eventId: "e0" }]);
  await atomic((tx) => runMatch(tx, "e0"));
  expect(
    await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
  ).toBe(4);
  expect(
    await db.exceptionCase.findUnique({ where: { id: issue.id } }),
  ).toMatchObject({ status: "RESOLVED" });
  expect(
    (await db.matchRun.findFirstOrThrow({ where: { status: "DONE" } })).input,
  ).toMatchObject({ policy: { minimum: 20 } });
  expect(
    await db.eventSlot.findUnique({ where: { id: "future" } }),
  ).toMatchObject({ status: "OPEN" });
  expect(await db.diningTable.count({ where: { eventId: "future" } })).toBe(0);
});

it("does not inflate same-date deferrals when an operator retry still cannot match", async () => {
  await db.user.create({
    data: {
      id: "operator",
      name: "운영",
      email: "operator@test.local",
      role: "OPERATIONS",
    },
  });
  for (let i = 0; i < 4; i++) await applicant(i);
  const venue = await db.venueSlot.findUniqueOrThrow({ where: { id: "v-e0" } });
  await db.venueSlot.deleteMany();
  await atomic((tx) => runMatch(tx, "e0"));
  const issue = await db.exceptionCase.findUniqueOrThrow({
    where: { key: "venue:e0" },
  });
  await db.venueSlot.create({ data: venue });
  await db.relationship.create({
    data: {
      fromId: "u0",
      toId: "u1",
      kind: "BLOCK",
      active: true,
      sourceId: "test",
    },
  });
  await command(
    { id: "operator", name: "운영", role: "OPERATIONS" },
    "retryMatch",
    { exceptionId: issue.id },
  );
  await atomic((tx) => runMatch(tx, "e0"));
  expect((await db.application.findMany()).map((a) => a.deferredCount)).toEqual(
    [1, 1, 1, 1],
  );
});

it("does not create an orphan venue exception state for a three-person pool", async () => {
  for (let i = 0; i < 3; i++) await applicant(i);
  await db.venueSlot.deleteMany();
  await atomic((tx) => runMatch(tx, "e0"));
  expect(
    await db.application.count({
      where: { matchStatus: "ALTERNATIVE_OFFERED" },
    }),
  ).toBe(3);
  expect(await db.exceptionCase.count()).toBe(0);
});

it("never revives an applicant who already chose a refund during venue recovery", async () => {
  await db.user.create({
    data: {
      id: "operator",
      name: "운영",
      email: "operator@test.local",
      role: "OPERATIONS",
    },
  });
  for (let i = 0; i < 4; i++) await applicant(i);
  await db.venueSlot.deleteMany();
  await atomic((tx) => runMatch(tx, "e0"));
  const issue = await db.exceptionCase.findUniqueOrThrow({
    where: { key: "venue:e0" },
  });
  await db.application.updateMany({
    data: { resolution: "REFUND", paymentStatus: "REFUND_REQUESTED" },
  });
  await expect(
    command(
      { id: "operator", name: "운영", role: "OPERATIONS" },
      "retryMatch",
      { exceptionId: issue.id },
    ),
  ).rejects.toThrow("미래 일정");
  expect(
    await db.application.count({
      where: { paymentStatus: "REFUND_REQUESTED", resolution: "REFUND" },
    }),
  ).toBe(4);
});

it("rejects policy changes even from an operator without writing settings or audit", async () => {
  await db.user.create({
    data: {
      id: "locked-operator",
      name: "운영",
      email: "locked@test.local",
      role: "OPERATIONS",
    },
  });
  const actor = { id: "locked-operator", name: "운영", role: "OPERATIONS" };
  for (const value of [
    { ...defaultPolicy, minimum: 0 },
    { ...defaultPolicy, minimum: 100 },
    { ...defaultPolicy, weights: [1, 1, 1, 1] },
    { ...defaultPolicy, loneGenderMultiplier: 1 },
  ])
    await expect(
      command(actor, "setting", { key: "matchingPolicy", value }),
    ).rejects.toThrow("고정");
  expect(await db.setting.count({ where: { key: "matchingPolicy" } })).toBe(0);
  expect(await db.auditLog.count({ where: { actorId: actor.id } })).toBe(0);
});

it("ignores legacy policy overrides for both automatic and manual matching", async () => {
  await db.setting.create({
    data: {
      key: "matchingPolicy",
      value: {
        ...defaultPolicy,
        minimum: 100,
        weights: [1, 0, 0, 0],
        loneGenderMultiplier: 1,
      },
    },
  });
  for (let i = 0; i < 4; i++) await applicant(i);
  expect(await atomic((tx) => loadMatchingPolicy(tx))).toEqual(defaultPolicy);
  const preview = await atomic((tx) =>
    inspectAllocation(tx, {
      eventId: "e0",
      venueSlotId: "v-e0",
      applicationIds: ["a0", "a1", "a2", "a3"],
    }),
  );
  expect(preview.issues).toEqual([]);
  await atomic((tx) => runMatch(tx, "e0"));
  expect(
    await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
  ).toBe(4);
  expectFixedSnapshot(
    (
      (await db.diningTable.findFirstOrThrow()).evaluation as {
        policy: unknown;
      }
    ).policy,
  );
});

it.each([false, true])(
  "keeps an earlier same-day solver failure open after a later run (later failure: %s)",
  async (failLater) => {
    const morning = new Date(`${matchDay(start)}T10:00:00+09:00`);
    const evening = new Date(`${matchDay(start)}T18:00:00+09:00`);
    await db.eventSlot.update({
      where: { id: "e0" },
      data: {
        startsAt: morning,
        endsAt: new Date(+morning + 7200000),
      },
    });
    await event("evening", evening);
    await db.eventSlot.update({
      where: { id: "evening" },
      data: {
        matchAt: new Date(+morning + 3600000),
      },
    });
    for (let i = 0; i < 8; i++) await applicant(i, [i < 4 ? "e0" : "evening"]);
    const failure = vi
      .spyOn(exact, "composeExact")
      .mockRejectedValueOnce(new exact.MatchingIncomplete("morning failed"));
    await atomic((tx) => runMatch(tx, "e0"));
    const morningIssue = await db.exceptionCase.findFirstOrThrow({
      where: { objectId: "e0", kind: "MATCHING" },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(+morning + 7200000));
    if (failLater) {
      failure.mockRejectedValueOnce(
        new exact.MatchingIncomplete("evening failed"),
      );
      await atomic((tx) => runMatch(tx, "evening"));
      expect(
        await db.exceptionCase.count({
          where: { kind: "MATCHING", status: "OPEN" },
        }),
      ).toBe(2);
      const eveningIssue = await db.exceptionCase.findFirstOrThrow({
        where: { objectId: "evening", kind: "MATCHING" },
      });
      await db.user.create({
        data: {
          id: "operator",
          name: "운영",
          email: "operator@test.local",
          role: "OPERATIONS",
        },
      });
      await command(
        { id: "operator", name: "운영", role: "OPERATIONS" },
        "retryMatch",
        { exceptionId: eveningIssue.id },
      );
      const retryJobs = await db.job.findMany({
        where: { key: { startsWith: `retry-match:${eveningIssue.id}:` } },
      });
      expect(retryJobs.map((job) => job.payload)).toEqual([
        { eventId: "evening" },
      ]);
    }
    failure.mockRestore();
    await atomic((tx) => runMatch(tx, "evening"));
    expect(
      await db.exceptionCase.findUnique({ where: { id: morningIssue.id } }),
    ).toMatchObject({
      status: "OPEN",
      reason: "morning failed",
      objectId: "e0",
    });
    expect(
      await db.application.count({
        where: {
          id: { in: ["a0", "a1", "a2", "a3"] },
          matchStatus: "WAITING",
          paymentStatus: "PAID",
          tableId: null,
        },
      }),
    ).toBe(4);
    expect(
      await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
    ).toBe(4);
    expect(
      await db.exceptionCase.count({
        where: { objectId: "evening", status: "OPEN" },
      }),
    ).toBe(0);
  },
);

it("tracks every pool in a failed joint solve and resolves only those recovered pools", async () => {
  await event("e1", start, 4, 1);
  for (let i = 0; i < 8; i++) await applicant(i, [i < 4 ? "e0" : "e1"]);
  const failure = vi
    .spyOn(exact, "composeExact")
    .mockRejectedValueOnce(new exact.MatchingIncomplete("joint failed"));
  await atomic((tx) => runMatch(tx, "e0"));
  failure.mockRestore();
  expect(
    (
      await db.exceptionCase.findMany({
        where: { kind: "MATCHING", status: "OPEN" },
        orderBy: { objectId: "asc" },
      })
    ).map((issue) => issue.objectId),
  ).toEqual(["e0", "e1"]);
  await atomic((tx) => runMatch(tx, "e1"));
  expect(
    await db.application.count({ where: { matchStatus: "CONFIRMED" } }),
  ).toBe(8);
  expect(
    await db.exceptionCase.count({
      where: { kind: "MATCHING", status: "OPEN" },
    }),
  ).toBe(0);
  expect(
    await db.exceptionCase.count({
      where: { kind: "MATCHING", status: "RESOLVED" },
    }),
  ).toBe(2);
});

it("rejects an unavailable solver event without scheduling an applicant's other options", async () => {
  await event("future", new Date(+start + 86400000));
  for (let i = 0; i < 4; i++) await applicant(i, ["e0", "future"]);
  const failure = vi
    .spyOn(exact, "composeExact")
    .mockRejectedValueOnce(new exact.MatchingIncomplete("failed"));
  await atomic((tx) => runMatch(tx, "e0"));
  failure.mockRestore();
  const issue = await db.exceptionCase.findFirstOrThrow({
    where: { kind: "MATCHING", objectId: "e0" },
  });
  await db.eventSlot.update({
    where: { id: "e0" },
    data: { status: "CANCELED" },
  });
  await db.user.create({
    data: {
      id: "operator",
      name: "운영",
      email: "operator@test.local",
      role: "OPERATIONS",
    },
  });
  await expect(
    command(
      { id: "operator", name: "운영", role: "OPERATIONS" },
      "retryMatch",
      { exceptionId: issue.id },
    ),
  ).rejects.toThrow("미래 일정");
  expect(
    await db.job.count({
      where: { key: { startsWith: `retry-match:${issue.id}:` } },
    }),
  ).toBe(0);
  expect(
    await db.exceptionCase.findUnique({ where: { id: issue.id } }),
  ).toMatchObject({ status: "OPEN" });
  expect(
    await db.application.count({
      where: { matchStatus: "WAITING", paymentStatus: "PAID" },
    }),
  ).toBe(4);
});
