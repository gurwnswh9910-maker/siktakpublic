import type { Tx } from "./db";

export async function reservationExpiries(tx: Tx, applicationIds: string[]) {
  const entries = await tx.ticketEntry.findMany({
    where: { key: { in: applicationIds.map((id) => `reserve:${id}`) } },
    select: { applicationId: true, expiresAt: true },
  });
  return new Map(entries.map((e) => [e.applicationId!, e.expiresAt]));
}
export function coversEvent(expiry: Date | null | undefined, startsAt: Date) {
  // Historic fixture/grant records without an expiry remain valid.
  return !expiry || startsAt < expiry;
}
