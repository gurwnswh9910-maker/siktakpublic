import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { atomic, db, type Actor } from "@/server/db";
import { command } from "@/server/commands";
import { completeMockRefund, MOCK_REFUND_POLICY } from "@/server/refunds";
import { runMatch } from "@/server/match-run";
import { participantView } from "@/server/views";
import { execute, tick } from "@/worker/runner";

const actor: Actor = {
  id: "refund-user",
  name: "환불 시연",
  role: "PARTICIPANT",
};
const operator: Actor = { id: "refund-admin", name: "운영자", role: "ADMIN" };
beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes("siktak_test"))
    throw new Error("Wrong database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await db.user.create({
    data: {
      ...actor,
      email: "refund@test.local",
      profile: {
        create: {
          contact: "01000000000",
          birthYear: 1995,
          gender: "여성",
          occupation: "시연",
          mbti: ["INTJ"],
          interests: ["음식"],
          traits: ["편안함"],
          desiredTraits: ["편안함"],
          budgets: ["2만~3만원"],
          foodRestrictions: "없음",
          allergies: "없음",
          consentVersion: "test",
          consentAt: new Date(),
        },
      },
    },
  });
  await db.user.create({
    data: { ...operator, email: "refund-admin@test.local" },
  });
  for (const [i, id] of ["original-event", "other-event"].entries()) {
    const startsAt = new Date(Date.now() + (4 + i) * 86400000);
    await db.eventSlot.create({
      data: {
        id,
        title: "환불 검증",
        region: "홍대",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 7200000),
        closesAt: new Date(startsAt.getTime() - 86400000),
        matchAt: new Date(startsAt.getTime() - 86400000),
        cancelRefundCutoffAt: new Date(startsAt.getTime() - 172800000),
      },
    });
  }
});
afterAll(() => db.$disconnect());

async function applyAndPay(id: string, ticketType = "EXISTING") {
  await command(actor, "apply", {
    requestId: id,
    ticketType,
    consent: true,
    eventIds: [id === "original" ? "original-event" : "other-event"],
  });
  await command(actor, "pay", {
    applicationId: id,
    requestId: `payment:${id}`,
  });
}
async function purchase(others = 1) {
  await applyAndPay("original", "TRIPLE");
  for (let i = 0; i < others; i++) await applyAndPay(`other-${i}`);
  return db.payment.findUniqueOrThrow({ where: { key: "payment:original" } });
}
async function cancel(id = "original") {
  await command(actor, "cancel", { applicationId: id });
}
async function refundJob() {
  return db.job.findFirstOrThrow({ where: { kind: "REFUND" } });
}
async function balance() {
  return (await participantView(actor)).ticketBalance;
}
async function lotNet(paymentId: string) {
  return (
    (
      await db.ticketEntry.aggregate({
        where: { paymentId },
        _sum: { units: true },
      })
    )._sum.units ?? 0
  );
}

describe("versioned mock partial package refunds", () => {
  it("refunds the failed application's unit plus unused units after the cutoff, preserving an attended unit", async () => {
    const payment = await purchase();
    await db.application.update({
      where: { id: "other-0" },
      data: { attendanceStatus: "ATTENDED" },
    });
    await db.eventSlot.update({
      where: { id: "original-event" },
      data: { cancelRefundCutoffAt: new Date(Date.now() - 1000) },
    });
    await atomic((tx) => runMatch(tx, "original-event"));
    await command(actor, "resolve", {
      applicationId: "original",
      choice: "REFUND",
    });
    const refund = await db.refund.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    expect(refund.amount).toBe(10000);
    expect(refund.reason).toBe("SERVICE_NO_MATCH");
    expect(refund.calculation).toEqual({
      policyVersion: MOCK_REFUND_POLICY,
      purchasedUnits: 3,
      applicationUnits: 1,
      availableUnits: 1,
      expiredUnusedUnits: 0,
      refundedUnits: 2,
      unitAmount: 5000,
    });
    expect(await balance()).toBe(0);
    const job = await refundJob();
    await Promise.all([execute(job), execute(job)]);
    expect(
      (await db.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .status,
    ).toBe("PARTIALLY_REFUNDED");
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "original" } }))
        .paymentStatus,
    ).toBe("REFUNDED");
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "other-0" } }))
        .attendanceStatus,
    ).toBe("ATTENDED");
    expect(
      (
        await db.payment.findUniqueOrThrow({
          where: { key: "payment:other-0" },
        })
      ).status,
    ).toBe("PAID");
    expect(await lotNet(payment.id)).toBe(0);
    expect(
      await db.ticketEntry.count({ where: { key: `refund:${refund.id}` } }),
    ).toBe(1);
    expect(
      await db.notification.count({ where: { key: `refunded:${refund.id}` } }),
    ).toBe(1);
  });

  it("refunds only one unit when both remaining units are reserved", async () => {
    const payment = await purchase(2);
    await cancel();
    expect(
      (await db.refund.findUniqueOrThrow({ where: { paymentId: payment.id } }))
        .amount,
    ).toBe(5000);
    await execute(await refundJob());
    expect(
      await db.application.count({
        where: {
          id: { startsWith: "other-" },
          paymentStatus: "PAID",
          applicationStatus: "SUBMITTED",
        },
      }),
    ).toBe(2);
    expect(await lotNet(payment.id)).toBe(0);
  });

  it("includes units restored before the request and caps an unused package at the original amount", async () => {
    const payment = await purchase();
    await cancel("other-0");
    expect(await balance()).toBe(2);
    await Promise.all([cancel(), cancel()]);
    const refund = await db.refund.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    expect(refund.amount).toBe(payment.amount);
    await execute(await refundJob());
    expect(
      (await db.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .status,
    ).toBe("REFUNDED");
    expect(await db.refund.count()).toBe(1);
    expect(await lotNet(payment.id)).toBe(0);
  });

  it.each(["before", "after"])(
    "keeps another application's restored unit usable %s refund completion",
    async (when) => {
      const payment = await purchase();
      await cancel();
      const job = await refundJob();
      if (when === "after") await execute(job);
      await cancel("other-0");
      expect(await balance()).toBe(1);
      if (when === "before") await execute(job);
      expect(await balance()).toBe(1);
      await applyAndPay("reuse-restored");
      expect(await balance()).toBe(0);
      await cancel("reuse-restored");
      await cancel();
      await execute(job);
      expect(await balance()).toBe(1);
      expect(await lotNet(payment.id)).toBe(1);
      expect(await db.refund.count()).toBe(1);
      expect(
        (
          await db.refund.findUniqueOrThrow({
            where: { paymentId: payment.id },
          })
        ).amount,
      ).toBe(10000);
    },
  );

  it("does not renew or cash-refund expired unused units, while returning the failed application's allocated unit", async () => {
    const payment = await purchase();
    await db.ticketEntry.updateMany({
      where: { paymentId: payment.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await atomic((tx) => runMatch(tx, "original-event"));
    await command(actor, "resolve", {
      applicationId: "original",
      choice: "REFUND",
    });
    const refund = await db.refund.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    expect(refund.amount).toBe(5000);
    expect(refund.calculation).toMatchObject({
      refundedUnits: 1,
      availableUnits: 0,
      expiredUnusedUnits: 1,
    });
    await execute(await refundJob());
    expect(await lotNet(payment.id)).toBe(1);
    expect(await balance()).toBe(0);
    await cancel("other-0");
    expect(await lotNet(payment.id)).toBe(2);
    expect(await balance()).toBe(0);
  });

  it("serializes the quote and a competing restoration without over-refunding or losing a unit", async () => {
    const payment = await purchase();
    await Promise.all([cancel(), cancel("other-0")]);
    await execute(await refundJob());
    const refund = await db.refund.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    expect([10000, 15000]).toContain(refund.amount);
    expect(refund.amount + (await balance()) * 5000).toBe(15000);
    expect(await lotNet(payment.id)).toBeGreaterThanOrEqual(0);
    expect(await db.refund.count()).toBe(1);
  });

  it("freezes quoted units so a concurrent payment cannot spend them", async () => {
    const payment = await purchase(0);
    await command(actor, "apply", {
      requestId: "competing",
      eventIds: ["other-event"],
      ticketType: "EXISTING",
      consent: true,
    });
    const outcomes = await Promise.allSettled([
      cancel(),
      command(actor, "pay", {
        applicationId: "competing",
        requestId: "competing-payment",
      }),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    await execute(await refundJob());
    const refund = await db.refund.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    const reserved = outcomes[1].status === "fulfilled" ? 1 : 0;
    expect(refund.amount + reserved * 5000).toBe(payment.amount);
    expect(await balance()).toBe(0);
    expect(await lotNet(payment.id)).toBe(0);
  });

  it.each([
    [-3, "이용권 원장 잔액"],
    [2, "모의 환불 금액"],
  ])(
    "rejects an inconsistent ledger delta %s without partial writes",
    async (units, message) => {
      const payment = await purchase(0);
      await db.ticketEntry.create({
        data: {
          userId: actor.id,
          paymentId: payment.id,
          kind: "INVALID_TEST_ENTRY",
          units: Number(units),
          key: "invalid-ledger",
        },
      });
      await expect(cancel()).rejects.toThrow(String(message));
      expect(await db.refund.count()).toBe(0);
      expect(
        await db.ticketEntry.count({ where: { key: "release:original" } }),
      ).toBe(0);
      expect(
        (await db.application.findUniqueOrThrow({ where: { id: "original" } }))
          .applicationStatus,
      ).toBe("SUBMITTED");
    },
  );

  it("rolls back a failed worker transaction and retries the same quote while preserving a later restoration", async () => {
    const payment = await purchase();
    await cancel();
    const refund = await db.refund.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    const job = await refundJob();
    await db.job.updateMany({
      where: { kind: { not: "REFUND" } },
      data: { status: "DONE" },
    });
    await db.setting.create({
      data: { key: "automation", value: { maxAttempts: 1, retrySeconds: 1 } },
    });
    // Force an error after PROCESSING and hold-release writes; the transaction
    // must roll those writes back before the worker records the final failure.
    await db.ticketEntry.create({
      data: {
        userId: actor.id,
        paymentId: payment.id,
        kind: "FAILURE_FIXTURE",
        units: 0,
        key: `refund:${refund.id}`,
      },
    });
    await tick();
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: job.id } })).status,
    ).toBe("FAILED");
    expect(
      (await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status,
    ).toBe("REFUND_FAILED");
    expect(
      (await db.application.findUniqueOrThrow({ where: { id: "original" } }))
        .paymentStatus,
    ).toBe("REFUND_FAILED");
    expect(
      await db.ticketEntry.count({
        where: { key: `refund-hold-release:${refund.id}` },
      }),
    ).toBe(0);
    expect(
      await db.notification.count({ where: { key: `refunded:${refund.id}` } }),
    ).toBe(0);
    expect(await db.exceptionCase.count({ where: { objectId: job.id } })).toBe(
      1,
    );
    expect(await balance()).toBe(0);
    await db.ticketEntry.delete({ where: { key: `refund:${refund.id}` } });
    await cancel("other-0");
    await command(operator, "retryJob", { jobId: job.id });
    for (let i = 0; i < 10 && (await tick()); i++);
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: job.id } })).status,
    ).toBe("DONE");
    expect(
      (await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).amount,
    ).toBe(10000);
    expect(
      (await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status,
    ).toBe("REFUNDED");
    expect(await balance()).toBe(1);
    expect(await lotNet(payment.id)).toBe(1);
  });

  it("finishes legacy pending refunds without recalculating or taking an unrelated restoration", async () => {
    const payment = await purchase(0);
    // Before v1, a full refund kept the original reserve and held only unused
    // units. The nullable calculation column must keep that job executable.
    const refund = await db.refund.create({
      data: { paymentId: payment.id, amount: payment.amount, reason: "LEGACY" },
    });
    const source = await db.ticketEntry.findUniqueOrThrow({
      where: { key: `purchase:${payment.id}` },
    });
    await db.ticketEntry.create({
      data: {
        userId: actor.id,
        paymentId: payment.id,
        applicationId: "original",
        kind: "REFUND_HOLD",
        units: -2,
        key: `refund-hold:${refund.id}`,
        expiresAt: source.expiresAt,
      },
    });
    await atomic((tx) => completeMockRefund(tx, refund.id));
    expect(
      (await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status,
    ).toBe("REFUNDED");
    expect(await lotNet(payment.id)).toBe(0);
  });
});
