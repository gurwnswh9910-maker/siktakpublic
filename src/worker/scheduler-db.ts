import { PrismaClient } from "@prisma/client";

// Reserve one connection for short lease/heartbeat transactions. Page reads and
// domain writes must not exhaust the pool used to finish or release a batch.
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("connection_limit", "1");
const globalControl = globalThis as unknown as {
  schedulerPrisma?: PrismaClient;
};
export const schedulerDb =
  globalControl.schedulerPrisma ??
  new PrismaClient({
    datasources: { db: { url: url.toString() } },
  });
if (process.env.NODE_ENV !== "production")
  globalControl.schedulerPrisma = schedulerDb;
