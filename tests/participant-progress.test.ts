import { afterAll, describe, expect, it } from "vitest";
import { nextNotice, type NoticeJob } from "@/server/participant-notices";
import { availableTicketLots } from "@/domain/ticket-lots";
import { db } from "@/server/db";
import { participantView, adminView } from "@/server/views";

const now = new Date("2030-01-01T14:59:59Z");
const at = (offset: number) => new Date(now.getTime() + offset);
const event = {
  id: "e1",
  status: "OPEN",
  startsAt: at(3_600_000),
  endsAt: at(7_200_000),
};
const waiting = {
  applicationStatus: "SUBMITTED",
  paymentStatus: "PAID",
  matchStatus: "WAITING",
  attendanceStatus: "SCHEDULED",
  feedback: null,
  options: [{ event }],
  table: null,
};
const confirmed = {
  ...waiting,
  matchStatus: "CONFIRMED",
  table: { id: "table1", status: "CONFIRMED", event },
};
const job = (
  kind: string,
  status = "PENDING",
  offset = 1000,
  payload = kind === "MATCH" ? { eventId: "e1" } : { tableId: "table1" },
): NoticeJob => ({ kind, status, runAt: at(offset), payload });

describe("participant next notice follows actual scheduled work", () => {
  it.each([
    ["PENDING", 1000, "SCHEDULED"],
    ["PENDING", -1, "DELAYED"],
    ["RUNNING", -1, "PROCESSING"],
    ["FAILED", -1, "FAILED"],
  ])("maps %s at %s without exposing errors", (status, offset, state) => {
    const result = nextNotice(
      waiting,
      [job("MATCH", status as string, offset as number)],
      now,
    );
    expect(result.state).toBe(state);
    expect(result.kind).toBe("MATCH");
    expect(result.scheduledAt).toEqual(at(offset as number));
  });
  it("uses the next live job and ignores another event or old table", () => {
    expect(
      nextNotice(
        waiting,
        [job("MATCH", "FAILED", -1000, { eventId: "other" }), job("MATCH")],
        now,
      ).state,
    ).toBe("SCHEDULED");
    const jobs = [
      job("REMINDER", "DONE"),
      job("START", "PENDING", 3_600_000),
      job("END", "PENDING", 7_200_000),
      job("REMINDER", "FAILED", -10, { tableId: "old" }),
    ];
    expect(nextNotice(confirmed, jobs, now).kind).toBe("START");
    expect(
      nextNotice(
        { ...confirmed, table: { ...confirmed.table, id: "new" } },
        jobs,
        now,
      ).state,
    ).toBe("UNSCHEDULED");
  });
  it("does not invent dates when jobs are missing or claim an unresolved match is done", () => {
    expect(nextNotice(waiting, [], now).scheduledAt).toBeNull();
    expect(nextNotice(waiting, [job("MATCH", "DONE")], now).state).toBe(
      "UNSCHEDULED",
    );
    expect(
      nextNotice({ ...waiting, paymentStatus: "PENDING" }, [job("MATCH")], now)
        .state,
    ).toBe("UNSCHEDULED");
  });
  it("keeps reallocation scheduling and paid no-match resolution distinct from unpaid applications", () => {
    expect(
      nextNotice(
        { ...waiting, matchStatus: "REALLOCATING" },
        [job("MATCH")],
        now,
      ).kind,
    ).toBe("MATCH");
    const result = nextNotice(
      {
        ...waiting,
        paymentStatus: "REFUND_AVAILABLE",
        matchStatus: "NO_MATCH",
      },
      [],
      now,
    );
    expect(result.detail).toContain("이동·보관·환불");
    expect(result.detail).not.toContain("결제 완료 후");
  });
  it("canceled applications and jobs never appear as future notices", () => {
    expect(
      nextNotice(
        { ...waiting, applicationStatus: "CANCELED" },
        [job("MATCH")],
        now,
      ).state,
    ).toBe("CANCELED");
    expect(nextNotice(waiting, [job("MATCH", "CANCELED")], now).state).toBe(
      "CANCELED",
    );
    expect(
      nextNotice(
        {
          ...confirmed,
          table: {
            ...confirmed.table,
            event: { ...event, status: "CANCELED" },
          },
        },
        [job("START")],
        now,
      ).state,
    ).toBe("CANCELED");
  });
  it("expires pre-event work, then offers feedback only to an attendee who has not responded", () => {
    const ended = {
      ...confirmed,
      attendanceStatus: "ATTENDED",
      table: {
        ...confirmed.table,
        event: { ...event, startsAt: at(-2000), endsAt: at(-1000) },
      },
    };
    const jobs = [
      job("REMINDER", "FAILED", -3000),
      job("START", "FAILED", -2000),
      job("END", "DONE", -1000),
      job("FEEDBACK_REMINDER", "PENDING", 86_399_000),
    ];
    expect(nextNotice(ended, jobs, now).kind).toBe("FEEDBACK_REMINDER");
    expect(
      nextNotice({ ...ended, feedback: { id: "submitted" } }, jobs, now).state,
    ).toBe("COMPLETED");
    expect(
      nextNotice({ ...ended, attendanceStatus: "SCHEDULED" }, jobs, now).state,
    ).toBe("COMPLETED");
    expect(
      nextNotice(
        ended,
        jobs.filter((j) => j.kind !== "FEEDBACK_REMINDER"),
        now,
      ).state,
    ).toBe("UNSCHEDULED");
  });
  it("preserves the exact instant across a Korean date boundary", () => {
    const notice = nextNotice(waiting, [job("MATCH", "PENDING", 1000)], now);
    expect(notice.scheduledAt?.toISOString()).toBe("2030-01-01T15:00:00.000Z");
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        dateStyle: "short",
      }).format(notice.scheduledAt!),
    ).toBe("2030-01-02");
  });
});

describe("available ticket purchase lots", () => {
  const entry = (paymentId: string | null, units: number, expiry = 1000) => ({
    paymentId,
    units,
    expiresAt: expiry === Infinity ? null : at(expiry),
    createdAt: at(-10000),
  });
  it("counts reservations, refund holds, restoration and settled partial refunds exactly once", () => {
    const entries = [
      entry("purchase-a", 3),
      entry("purchase-a", -1),
      entry("purchase-a", -1),
      entry("purchase-b", 3, 2000),
      entry("purchase-b", -1, 2000),
      entry("purchase-b", 1, 2000),
      entry("purchase-b", -2, 2000),
      entry("purchase-b", 2, 2000),
      entry("purchase-b", -2, 2000),
      entry("expired", 3, -1),
    ];
    const lots = availableTicketLots(entries, now);
    expect(lots.map((l) => [l.id, l.units])).toEqual([
      ["purchase-a", 1],
      ["purchase-b", 1],
    ]);
    expect(lots.reduce((sum, l) => sum + l.units, 0)).toBe(
      entries
        .filter((e) => !e.expiresAt || e.expiresAt > now)
        .reduce((sum, e) => sum + e.units, 0),
    );
  });
  it("removes a lot exactly at expiry and retains non-expiring grants", () => {
    const entries = [entry("expiring", 2, 0), entry(null, 1, Infinity)];
    expect(availableTicketLots(entries, at(-1)).map((l) => l.units)).toEqual([
      2, 1,
    ]);
    expect(availableTicketLots(entries, now).map((l) => l.units)).toEqual([1]);
    expect(availableTicketLots(entries, at(1)).map((l) => l.units)).toEqual([
      1,
    ]);
    expect(
      availableTicketLots([entry("held", 3), entry("held", -3)], now),
    ).toEqual([]);
  });
});

describe("participant and safety projections isolate ownership", () => {
  afterAll(() => db.$disconnect());
  it("selects only owned schedules/lots and limits protected relationships to safety roles", async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
      throw new Error("Wrong database");
    const prefix = `progress-${Date.now()}`;
    const future = new Date(Date.now() + 86400000);
    for (const suffix of ["a", "b"]) {
      await db.user.create({
        data: {
          id: `${prefix}-${suffix}`,
          name: suffix,
          email: `${prefix}-${suffix}@test.local`,
        },
      });
      await db.eventSlot.create({
        data: {
          id: `${prefix}-${suffix}`,
          title: suffix,
          region: suffix,
          startsAt: future,
          endsAt: new Date(+future + 3600000),
          closesAt: future,
          matchAt: future,
          cancelRefundCutoffAt: future,
        },
      });
      await db.application.create({
        data: {
          id: `${prefix}-${suffix}`,
          userId: `${prefix}-${suffix}`,
          applicationStatus: "SUBMITTED",
          paymentStatus: "PAID",
          ticketType: "TRIPLE",
          options: { create: { eventId: `${prefix}-${suffix}` } },
        },
      });
      await db.job.create({
        data: {
          key: `${prefix}-${suffix}`,
          kind: "MATCH",
          payload: { eventId: `${prefix}-${suffix}` },
          status: suffix === "a" ? "PENDING" : "FAILED",
          runAt: future,
          lastError: "private diagnostic",
        },
      });
      await db.ticketEntry.create({
        data: {
          userId: `${prefix}-${suffix}`,
          paymentId: `${prefix}-${suffix}`,
          units: suffix === "a" ? 2 : 5,
          kind: "PURCHASE",
          key: `${prefix}-${suffix}`,
          expiresAt: future,
        },
      });
    }
    await db.relationship.create({
      data: {
        fromId: `${prefix}-a`,
        toId: `${prefix}-b`,
        kind: "AVOID",
        sourceId: `${prefix}-a`,
      },
    });
    const participant = { id: `${prefix}-a`, name: "a", role: "PARTICIPANT" };
    const data = await participantView(participant);
    expect(data.applications).toHaveLength(1);
    expect(data.applications[0].nextNotice.state).toBe("SCHEDULED");
    expect(data.ticketLots.map((l) => l.units)).toEqual([2]);
    expect(data.ticketBalance).toBe(2);
    expect(JSON.stringify(data)).not.toContain("private diagnostic");
    expect(data).not.toHaveProperty("safetyRelationships");
    expect(data.applications[0]).not.toHaveProperty("matchHistory");
    await expect(adminView(participant)).rejects.toMatchObject({ status: 403 });
    const operations = await adminView({ ...participant, role: "OPERATIONS" });
    expect(operations.safetyRelationships).toEqual([]);
    const safety = await adminView({ ...participant, role: "SAFETY" });
    expect(
      safety.safetyRelationships.some((r) => r.sourceId === `${prefix}-a`),
    ).toBe(true);
    expect(safety.tables).toEqual([]);
    expect(safety.applications).toEqual([]);
  });
});
