// A separate process gives the application pool an actual capacity of one.
async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.pathname.endsWith("_test")) throw new Error("Wrong database");
  url.searchParams.set("connection_limit", "1");
  process.env.DATABASE_URL = url.toString();
  const { db } = await import("../../src/server/db");
  const scheduler = await import("../../src/worker/scheduler");
  let release = () => {};
  let ready = () => {};
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      ready();
      await blocked;
    },
    { timeout: 20000 },
  );
  try {
    await acquired;
    const result = await scheduler.runScheduledBatch();
    if (result.busy || result.status !== "COMPLETED")
      throw new Error("Incomplete batch");
    process.send?.({
      type: "pool-isolation",
      completedWhileApplicationPoolOccupied: true,
    });
  } catch (error) {
    process.send?.({
      type: "pool-isolation",
      code: error instanceof Error && "code" in error ? error.code : "UNKNOWN",
    });
    process.exitCode = 1;
  } finally {
    release();
    await holding;
    await db.$disconnect();
    const control = scheduler as typeof scheduler & {
      schedulerDb?: { $disconnect(): Promise<void> };
    };
    await control.schedulerDb?.$disconnect();
  }
}
void main();
