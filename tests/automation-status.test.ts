import { describe, expect, it } from "vitest";
import { automationStatus } from "@/worker/automation-status";

const now = Date.parse("2026-10-15T12:00:00Z");
const ago = (milliseconds: number) =>
  new Date(now - milliseconds).toISOString();
const batch = (value: Record<string, unknown> = {}) => ({
  key: "schedulerHeartbeat",
  value: { at: ago(86400000), status: "COMPLETED", processed: 2, ...value },
});
const dispatch = (value: Record<string, unknown> = {}) => ({
  key: "schedulerDispatchHeartbeat",
  value: { at: ago(300000), hasDueJobs: false, oldestDueAt: null, ...value },
});
const check = (settings: { key: string; value: unknown }[]) =>
  automationStatus(settings, "scheduler", now);

describe("conditional scheduler visibility", () => {
  it("allows idle sleep without turning a DB check into a completed application run", () => {
    expect(check([dispatch()])).toMatchObject({
      online: true,
      state: "IDLE",
      status: null,
      lastRunAt: null,
      lastFinishedAt: null,
      processed: 0,
    });
    expect(check([batch(), dispatch()])).toMatchObject({
      online: true,
      state: "IDLE",
      status: "COMPLETED",
      lastRunAt: ago(86400000),
      processed: 2,
    });
  });

  it("distinguishes cold-start waiting from a queue that is not being processed", () => {
    expect(
      check([batch(), dispatch({ hasDueJobs: true, oldestDueAt: ago(60000) })]),
    ).toMatchObject({ online: true, state: "WAITING" });
    expect(
      check([
        batch(),
        dispatch({ hasDueJobs: true, oldestDueAt: ago(180000) }),
      ]),
    ).toMatchObject({ online: false, state: "DELAYED" });
    // A running process must not hide an overdue queue either.
    expect(
      check([
        batch({ at: ago(1000), status: "RUNNING" }),
        dispatch({ hasDueJobs: true, oldestDueAt: ago(240000) }),
      ]),
    ).toMatchObject({ online: false, state: "DELAYED" });
  });

  it.each([
    { status: "FAILED" },
    { status: "INTERRUPTED" },
    { status: "DEADLINE" },
    { status: "COMPLETED", failed: 1 },
    { status: "COMPLETED", interrupted: 1 },
    { status: "RUNNING" },
  ])(
    "preserves unresolved application failure %j while the DB cron is healthy",
    (value) => {
      expect(check([batch(value), dispatch()])).toMatchObject({
        online: false,
        state: "ATTENTION",
        status: value.status,
      });
    },
  );

  it.each([
    { at: ago(420000) },
    { at: ago(-1) },
    { at: "invalid timestamp" },
    { at: null },
    { hasDueJobs: "false" },
    { hasDueJobs: true, oldestDueAt: null },
    { hasDueJobs: true, oldestDueAt: "invalid timestamp" },
    { hasDueJobs: true, oldestDueAt: ago(-1) },
  ])(
    "does not report a stale or invalid dispatcher as healthy: %j",
    (value) => {
      expect(check([batch({ at: ago(1000) }), dispatch(value)])).toMatchObject({
        online: false,
        state: "OFFLINE",
      });
    },
  );

  it("recognizes actual running work and recovery without changing legacy scheduler or worker liveness", () => {
    expect(
      check([batch({ at: ago(1000), status: "RUNNING" }), dispatch()]),
    ).toMatchObject({ online: true, state: "RUNNING" });
    expect(check([batch({ at: ago(1000) })])).toMatchObject({
      online: true,
      state: "READY",
    });
    expect(check([batch()])).toMatchObject({ online: false, state: "OFFLINE" });
    expect(
      automationStatus(
        [{ key: "workerHeartbeat", value: { at: ago(1000) } }, dispatch()],
        "worker",
        now,
      ),
    ).toMatchObject({
      online: true,
      state: "READY",
      lastDispatchCheckAt: null,
    });
  });
});
