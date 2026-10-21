import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { atomic, db, type Actor } from "@/server/db";
import {
  commitManualAllocation,
  previewManualAllocation,
  type ManualAllocationPlan,
} from "@/server/manual-allocation";
import { createAllocatedTable } from "@/server/table-allocation";
import { command } from "@/server/commands";
import { runMatch } from "@/server/match-run";
import { participantView } from "@/server/views";

const operator: Actor = { id: "manual-admin", role: "ADMIN", name: "운영" };
const ids = (start: number, n: number) =>
  Array.from({ length: n }, (_, i) => `manual-a${start + i}`);
const reason = "식당 예약 변경으로 동의한 일정에 다시 배정합니다.";
let tables: string[] = [];
beforeEach(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Dedicated test database required");
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
      );
      await tx.user.create({
        data: { ...operator, email: "manual-admin@example.test" },
      });
      for (let i = 0; i < 2; i++) {
        const start = new Date(Date.now() + (3 + i) * 86400000);
        await tx.eventSlot.create({
          data: {
            id: `manual-e${i}`,
            title: `수정 검사 ${i}`,
            region: "홍대",
            startsAt: start,
            endsAt: new Date(+start + 7200000),
            closesAt: new Date(+start - 86400000),
            matchAt: new Date(+start - 86400000),
            cancelRefundCutoffAt: new Date(+start - 172800000),
            capacity: 24,
            venues: {
              create: {
                id: `manual-v${i}`,
                name: "검사 식당",
                address: "가상",
                mapUrl: "https://map.naver.com",
                reservationName: "검사",
                price: 25000,
                capacity: 6,
                totalTables: 5,
                dietaryNotes: "없음",
              },
            },
          },
        });
      }
      for (let i = 0; i < 12; i++) {
        await tx.user.create({
          data: {
            id: `manual-u${i}`,
            name: `수정 참가자 ${i}`,
            email: `manual-u${i}@example.test`,
            profile: {
              create: {
                contact: "01000000000",
                birthYear: 1995 + (i % 3),
                gender: "기타",
                occupation: "검사",
                mbti: ["INTJ"],
                interests: ["여행"],
                traits: ["차분한"],
                desiredTraits: ["차분한"],
                budgets: ["2만원"],
                foodRestrictions: "없음",
                allergies: "없음",
                consentVersion: "test",
                consentAt: new Date(),
              },
            },
          },
        });
        await tx.application.create({
          data: {
            id: `manual-a${i}`,
            userId: `manual-u${i}`,
            ticketType: "SINGLE",
            applicationStatus: "SUBMITTED",
            paymentStatus: "PAID",
            options: {
              create: [{ eventId: "manual-e0" }, { eventId: "manual-e1" }],
            },
            payments: {
              create: {
                id: `manual-p${i}`,
                key: `manual-pay${i}`,
                amount: 8000,
                status: "PAID",
              },
            },
          },
        });
        await tx.ticketEntry.create({
          data: {
            userId: `manual-u${i}`,
            applicationId: `manual-a${i}`,
            paymentId: `manual-p${i}`,
            key: `manual-ledger${i}`,
            kind: "PURCHASE",
            units: 1,
          },
        });
      }
    },
    { timeout: 60000 },
  );
  tables = [];
}, 60000);
afterAll(() => db.$disconnect());
async function table(start = 0, count = 4) {
  const t = await atomic((tx) =>
    createAllocatedTable(tx, {
      eventId: "manual-e0",
      venueSlotId: "manual-v0",
      applicationIds: ids(start, count),
      actorId: operator.id,
      reason,
      source: "MANUAL",
    }),
  );
  tables.push(t.id);
  await command(operator, "allocationException", { tableIds: [t.id], reason });
  return t;
}
const group = (applicationIds: string[], event = 0) => ({
  eventId: `manual-e${event}`,
  venueSlotId: `manual-v${event}`,
  applicationIds,
});
const plan = (
  groups: ManualAllocationPlan["groups"],
  operation: ManualAllocationPlan["operation"] = "MOVE",
  unassignApplicationIds: string[] = [],
): ManualAllocationPlan => ({
  operation,
  sourceTableIds: tables,
  groups,
  unassignApplicationIds,
  reason,
});
async function apply(p: ManualAllocationPlan, requestId = "request") {
  const preview = await atomic((tx) =>
    previewManualAllocation(tx, operator, p),
  );
  expect(preview.issues).toEqual([]);
  return atomic((tx) =>
    commitManualAllocation(tx, operator, {
      ...p,
      version: preview.version,
      requestId,
    }),
  );
}

describe("operator allocation transactions", () => {
  it("moves to a consented event, retires rooms and jobs, preserves money, and deduplicates retries", async () => {
    const original = await table();
    const before = {
      payments: await db.payment.findMany(),
      ledger: await db.ticketEntry.findMany(),
    };
    const p = plan([group(ids(0, 4), 1)]);
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, p),
    );
    expect(preview.valid).toBe(true);
    expect(preview.canceledJobs).toHaveLength(4);
    const payload = { ...p, version: preview.version, requestId: "move" };
    const result = await atomic((tx) =>
      commitManualAllocation(tx, operator, payload),
    );
    expect(
      (await db.diningTable.findUniqueOrThrow({ where: { id: original.id } }))
        .status,
    ).toBe("REPLACED");
    expect(
      await db.job.count({
        where: {
          payload: { path: ["tableId"], equals: original.id },
          status: "CANCELED",
        },
      }),
    ).toBe(4);
    const actor = { id: "manual-u0", role: "PARTICIPANT", name: "참가자" };
    await expect(
      command(actor, "message", {
        roomId: original.room!.id,
        body: "옛 방",
        requestId: "old-room",
      }),
    ).rejects.toThrow("참여 중인 단체방");
    const view = await participantView(actor);
    expect(view.applications[0].table?.id).toBe(result.tableIds[0]);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "MANUAL_ALLOCATION" },
    });
    expect(audit.before).toHaveProperty("tables");
    expect(audit.after).toHaveProperty("reason", reason);
    expect({
      payments: await db.payment.findMany(),
      ledger: await db.ticketEntry.findMany(),
    }).toEqual(before);
    const counts = [
      await db.notification.count(),
      await db.diningTable.count(),
      await db.job.count(),
    ];
    const retry = await atomic((tx) =>
      commitManualAllocation(tx, operator, payload),
    );
    expect(retry.duplicate).toBe(true);
    expect(retry.tableIds).toEqual(result.tableIds);
    expect([
      await db.notification.count(),
      await db.diningTable.count(),
      await db.job.count(),
    ]).toEqual(counts);
    await expect(
      atomic((tx) =>
        commitManualAllocation(tx, operator, {
          ...payload,
          reason: "다른 변경 사유입니다",
        }),
      ),
    ).rejects.toThrow("같은 요청 번호");
  });
  it("splits six with two eligible waiting applicants into two valid tables", async () => {
    await table(0, 6);
    const result = await apply(
      plan([group(ids(0, 4)), group(ids(4, 4))], "SPLIT"),
    );
    expect(result.tableIds).toHaveLength(2);
    expect(
      await db.application.count({
        where: { tableId: { in: result.tableIds }, matchStatus: "CONFIRMED" },
      }),
    ).toBe(8);
  });
  it("merges two tables and explicitly releases excess participants to existing resolution choices", async () => {
    await table(0, 4);
    await table(4, 4);
    const result = await apply(plan([group(ids(0, 6))], "MERGE", ids(6, 2)));
    expect(result.tableIds).toHaveLength(1);
    expect(
      await db.application.count({
        where: {
          id: { in: ids(6, 2) },
          tableId: null,
          paymentStatus: "REFUND_AVAILABLE",
        },
      }),
    ).toBe(2);
    expect(await db.payment.count({ where: { status: "PAID" } })).toBe(12);
  });
  it("unassigns without deleting financial history and permits ticket storage", async () => {
    await table();
    await apply(plan([], "UNASSIGN", ids(0, 4)));
    const actor = { id: "manual-u0", role: "PARTICIPANT", name: "참가자" };
    await command(actor, "resolve", {
      applicationId: "manual-a0",
      choice: "KEEP",
    });
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "manual-a0" } }))
        .resolution,
    ).toBe("KEEP");
    expect(await db.payment.count()).toBe(12);
  });
  it.each(["BLOCK", "AVOID", "REPORT"])(
    "does not bypass %s exclusion",
    async (kind) => {
      await table();
      await db.relationship.create({
        data: {
          fromId: "manual-u0",
          toId: "manual-u1",
          kind,
          sourceId: "manual-check",
        },
      });
      const preview = await atomic((tx) =>
        previewManualAllocation(tx, operator, plan([group(ids(0, 4))])),
      );
      expect(preview.valid).toBe(false);
      expect(preview.issues.join(" ")).toContain("관계");
    },
  );
  it("reports age, consent, headcount, restaurant, and event-capacity failures before writes", async () => {
    await table();
    await db.profile.update({
      where: { userId: "manual-u0" },
      data: { birthYear: 1960 },
    });
    await db.applicationOption.delete({
      where: {
        applicationId_eventId: {
          applicationId: "manual-a1",
          eventId: "manual-e1",
        },
      },
    });
    await db.venueSlot.update({
      where: { id: "manual-v1" },
      data: { capacity: 3, totalTables: 0 },
    });
    await db.eventSlot.update({
      where: { id: "manual-e1" },
      data: { capacity: 3 },
    });
    const preview = await atomic((tx) =>
      previewManualAllocation(
        tx,
        operator,
        plan([group(ids(0, 3), 1)], "MOVE", ids(3, 1)),
      ),
    );
    expect(preview.valid).toBe(false);
    for (const phrase of ["인원", "나이", "선택하지 않은", "재고"])
      expect(preview.issues.join(" ")).toContain(phrase);
    expect(await db.diningTable.count()).toBe(1);
  });
  it("rejects a preview after cancellation, competing assignment, or changed eligibility", async () => {
    await table();
    const p = plan([group(ids(0, 4))]);
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, p),
    );
    await db.user.update({
      where: { id: "manual-u0" },
      data: { restriction: "SUSPENDED" },
    });
    await expect(
      atomic((tx) =>
        commitManualAllocation(tx, operator, {
          ...p,
          version: preview.version,
          requestId: "stale",
        }),
      ),
    ).rejects.toThrow("미리보기 이후");
    expect(await db.diningTable.count()).toBe(1);
  });
  it("serializes two operator commits so only one preview can be applied", async () => {
    await table();
    const p = plan([group(ids(0, 4))]);
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, p),
    );
    const results = await Promise.allSettled(
      ["one", "two"].map((requestId) =>
        atomic((tx) =>
          commitManualAllocation(tx, operator, {
            ...p,
            version: preview.version,
            requestId,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await db.diningTable.count({ where: { status: "CONFIRMED" } })).toBe(
      1,
    );
  });
  it("rolls back table retirement, new rooms, jobs and application moves if a later group fails", async () => {
    await table(0, 6);
    const p = plan([group(ids(0, 4)), group(ids(4, 4))], "SPLIT");
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, p),
    );
    const before = [
      await db.diningTable.count(),
      await db.chatRoom.count(),
      await db.job.count(),
      await db.auditLog.count(),
    ];
    await expect(
      atomic(async (tx) => {
        const real = tx.diningTable.create.bind(tx.diningTable);
        let count = 0;
        const spy = vi
          .spyOn(tx.diningTable, "create")
          .mockImplementation((args) => {
            if (++count === 2) throw new Error("synthetic storage failure");
            return real(args);
          });
        try {
          return await commitManualAllocation(tx, operator, {
            ...p,
            version: preview.version,
            requestId: "rollback",
          });
        } finally {
          spy.mockRestore();
        }
      }),
    ).rejects.toThrow("synthetic storage failure");
    expect([
      await db.diningTable.count(),
      await db.chatRoom.count(),
      await db.job.count(),
      await db.auditLog.count(),
    ]).toEqual(before);
    expect(
      await db.application.count({
        where: { tableId: tables[0], matchStatus: "CONFIRMED" },
      }),
    ).toBe(6);
  });
  it("rejects participant, safety-only, and stale privileged actors", async () => {
    await table();
    for (const role of ["PARTICIPANT", "SAFETY"]) {
      await db.user.update({ where: { id: operator.id }, data: { role } });
      await expect(
        atomic((tx) =>
          previewManualAllocation(tx, operator, plan([group(ids(0, 4))])),
        ),
      ).rejects.toThrow("접근 권한");
    }
  });
  it("preserves an offered seat when checking total event capacity", async () => {
    await table(0, 4);
    const held = await table(4, 4);
    tables = [tables[0]];
    await db.application.update({
      where: { id: "manual-a7" },
      data: { tableId: null, matchStatus: "WAITING" },
    });
    await db.diningTable.update({
      where: { id: held.id },
      data: { status: "WAITLIST_PENDING" },
    });
    await db.waitlistEntry.create({
      data: {
        applicationId: "manual-a8",
        eventId: "manual-e0",
        tableId: held.id,
        status: "OFFERED",
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await db.eventSlot.update({
      where: { id: "manual-e0" },
      data: { capacity: 7 },
    });
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, plan([group(ids(0, 4))])),
    );
    expect(preview.valid).toBe(false);
    expect(preview.issues.join(" ")).toContain("정원");
  });
  it("counts checked-in members in occupied event capacity", async () => {
    await table();
    const occupied = await atomic((tx) =>
      createAllocatedTable(tx, {
        ...group(ids(4, 4), 1),
        actorId: operator.id,
        reason,
        source: "MANUAL",
      }),
    );
    await db.application.updateMany({
      where: { tableId: occupied.id },
      data: { attendanceStatus: "ATTENDED" },
    });
    await db.eventSlot.update({
      where: { id: "manual-e1" },
      data: { capacity: 4 },
    });
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, plan([group(ids(0, 4), 1)])),
    );
    expect(preview.valid).toBe(false);
    expect(preview.issues.join(" ")).toContain("정원");
  });
  it("detects a competing automatic assignment after preview", async () => {
    await table();
    const p = plan([group(ids(0, 4), 1)]);
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, p),
    );
    await atomic((tx) => runMatch(tx, "manual-e1"));
    expect(
      await db.diningTable.count({
        where: { eventId: "manual-e1", status: "CONFIRMED" },
      }),
    ).toBeGreaterThan(0);
    await expect(
      atomic((tx) =>
        commitManualAllocation(tx, operator, {
          ...p,
          version: preview.version,
          requestId: "automatic-race",
        }),
      ),
    ).rejects.toThrow("미리보기 이후");
  });
  async function vacancy() {
    const source = await table(0, 5);
    await db.ticketEntry.update({
      where: { key: "manual-ledger4" },
      data: { key: "purchase:manual-p4" },
    });
    await db.ticketEntry.create({
      data: {
        userId: "manual-u4",
        applicationId: "manual-a4",
        paymentId: "manual-p4",
        key: "reserve:manual-a4",
        kind: "RESERVE",
        units: -1,
      },
    });
    await command(
      { id: "manual-u4", role: "PARTICIPANT", name: "취소 참가자" },
      "cancel",
      { applicationId: "manual-a4" },
    );
    expect(
      (await db.diningTable.findUniqueOrThrow({ where: { id: source.id } }))
        .status,
    ).toBe("CONFIRMED");
    return source;
  }
  async function offerOutsideSource(sourceId: string) {
    await command(
      { id: "manual-u8", role: "PARTICIPANT", name: "대기 참가자" },
      "waitlistJoin",
      { applicationId: "manual-a8", eventId: "manual-e0" },
    );
    const entry = await db.waitlistEntry.findUniqueOrThrow({
      where: { applicationId: "manual-a8" },
    });
    expect(entry.status).toBe("OFFERED");
    expect(entry.tableId).toBe(sourceId);
    const job = await db.job.findUniqueOrThrow({
      where: {
        key: `waitlist-offer:${entry.id}:${entry.expiresAt!.toISOString()}`,
      },
    });
    expect(job.status).toBe("PENDING");
    return { entry, job };
  }
  it.each(["MOVE", "UNASSIGN"] as const)(
    "refuses %s while an applicant outside the source members has its offered seat",
    async (operation) => {
      const source = await vacancy();
      const offered = await offerOutsideSource(source.id);
      const p =
        operation === "MOVE"
          ? plan([group(ids(0, 4), 1)])
          : plan([], "UNASSIGN", ids(0, 4));
      const preview = await atomic((tx) =>
        previewManualAllocation(tx, operator, p),
      );
      expect(preview.valid).toBe(false);
      expect(preview.issues.join(" ")).toContain("대기 등록·제안");
      await expect(
        atomic((tx) =>
          commitManualAllocation(tx, operator, {
            ...p,
            version: preview.version,
            requestId: `outside-${operation}`,
          }),
        ),
      ).rejects.toThrow("대기 등록·제안");
      expect(
        (await db.diningTable.findUniqueOrThrow({ where: { id: source.id } }))
          .status,
      ).toBe("CONFIRMED");
      expect(
        await db.application.count({
          where: { id: { in: ids(0, 4) }, tableId: source.id },
        }),
      ).toBe(4);
      expect(
        await db.waitlistEntry.findUnique({ where: { id: offered.entry.id } }),
      ).toEqual(offered.entry);
      expect(
        await db.job.findUnique({ where: { id: offered.job.id } }),
      ).toEqual(offered.job);
      expect(
        await db.auditLog.count({ where: { action: "MANUAL_ALLOCATION" } }),
      ).toBe(0);
    },
  );
  it("revalidates an outside offer created after a clean preview", async () => {
    const source = await vacancy();
    const plans = [
      plan([group(ids(0, 4), 1)]),
      plan([], "UNASSIGN", ids(0, 4)),
    ];
    const previews: Awaited<ReturnType<typeof previewManualAllocation>>[] = [];
    for (const p of plans) {
      const preview = await atomic((tx) =>
        previewManualAllocation(tx, operator, p),
      );
      expect(preview.valid).toBe(true);
      previews.push(preview);
    }
    const offered = await offerOutsideSource(source.id);
    for (const [index, p] of plans.entries()) {
      await expect(
        atomic((tx) =>
          commitManualAllocation(tx, operator, {
            ...p,
            version: previews[index].version,
            requestId: `raced-${index}`,
          }),
        ),
      ).rejects.toThrow("미리보기 이후");
      const fresh = await atomic((tx) =>
        previewManualAllocation(tx, operator, p),
      );
      expect(fresh.valid).toBe(false);
      await expect(
        atomic((tx) =>
          commitManualAllocation(tx, operator, {
            ...p,
            version: fresh.version,
            requestId: `fresh-${index}`,
          }),
        ),
      ).rejects.toThrow("대기 등록·제안");
    }
    expect(await db.job.findUnique({ where: { id: offered.job.id } })).toEqual(
      offered.job,
    );
    expect(
      (
        await db.waitlistEntry.findUniqueOrThrow({
          where: { id: offered.entry.id },
        })
      ).status,
    ).toBe("OFFERED");
  });
  it("reserves pending waitlist tables and refuses applicants with an active waitlist", async () => {
    await table();
    await db.waitlistEntry.create({
      data: {
        applicationId: "manual-a0",
        eventId: "manual-e0",
        status: "WAITING",
      },
    });
    const preview = await atomic((tx) =>
      previewManualAllocation(tx, operator, plan([group(ids(0, 4))])),
    );
    expect(preview.issues.join(" ")).toContain("대기 등록");
    await db.waitlistEntry.deleteMany();
    await db.diningTable.update({
      where: { id: tables[0] },
      data: { status: "WAITLIST_PENDING" },
    });
    const held = await atomic((tx) =>
      previewManualAllocation(tx, operator, plan([group(ids(0, 4))])),
    );
    expect(held.valid).toBe(false);
  });
});
