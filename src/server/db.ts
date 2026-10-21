import { PrismaClient, Prisma } from "@prisma/client";
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalDb.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalDb.prisma = db;
export type Tx = Prisma.TransactionClient;
export const domainTransactionLimits = { maxWait: 15000, timeout: 60000 };
export const jobControlTransactionLimits = { maxWait: 5000, timeout: 10000 };
// Interactive transaction expiry alone does not interrupt an in-flight PostgreSQL
// lock wait. Cancel blocked control statements on the server before that expiry.
export function jobControlTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', '8000ms', true), set_config('lock_timeout', '6000ms', true)`;
    return fn(tx);
  }, jobControlTransactionLimits);
}
// A deliberate, small-product tradeoff: serialize domain writes, not page reads.
// This also protects cross-event allocations and competing resolution choices.
export async function atomic<T>(
  fn: (tx: Tx) => Promise<T>,
  limits = domainTransactionLimits,
): Promise<T> {
  const body = async (tx: Tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(739421)::text`;
    return fn(tx);
  };
  return limits === jobControlTransactionLimits
    ? jobControlTransaction(body)
    : db.$transaction(body, limits);
}
export async function audit(
  tx: Tx,
  actorId: string,
  action: string,
  objectId: string,
  before?: unknown,
  after?: unknown,
) {
  return tx.auditLog.create({
    data: {
      actorId,
      action,
      objectId,
      ...(before !== undefined
        ? { before: JSON.parse(JSON.stringify(before)) }
        : {}),
      ...(after !== undefined
        ? { after: JSON.parse(JSON.stringify(after)) }
        : {}),
    },
  });
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function ensure(
  value: unknown,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new AppError(message, status);
}
export type Actor = { id: string; role: string; name: string };
export function admin(
  actor: Actor,
  area: "operations" | "safety" | "all" = "operations",
) {
  const roles =
    area === "safety"
      ? ["ADMIN", "SAFETY"]
      : area === "all"
        ? ["ADMIN", "OPERATIONS", "SAFETY"]
        : ["ADMIN", "OPERATIONS"];
  ensure(roles.includes(actor.role), "접근 권한이 없습니다.", 403);
}
