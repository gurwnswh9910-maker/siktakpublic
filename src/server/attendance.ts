import { Tx } from "./db";

// Rebuild only this table's actual-attendance edges. A late check-in or an
// operator correction must have the same effect as the scheduled END job.
export async function syncMeetingHistory(tx: Tx, tableId: string) {
  const table = await tx.diningTable.findUnique({
    where: { id: tableId },
    include: {
      event: true,
      applications: { where: { attendanceStatus: "ATTENDED" } },
    },
  });
  if (!table || table.event.endsAt > new Date()) return;
  for (const application of table.applications) {
    const reserve = await tx.ticketEntry.findUnique({
      where: { key: `reserve:${application.id}` },
    });
    if (reserve)
      await tx.ticketEntry.upsert({
        where: { key: `consume:${application.id}` },
        create: {
          userId: application.userId,
          applicationId: application.id,
          paymentId: reserve.paymentId,
          expiresAt: reserve.expiresAt,
          kind: "CONSUME",
          units: 0,
          key: `consume:${application.id}`,
        },
        update: {},
      });
  }
  await tx.relationship.deleteMany({
    where: { kind: "MET", sourceId: tableId },
  });
  const users = [...new Set(table.applications.map((a) => a.userId))];
  for (const fromId of users)
    for (const toId of users) {
      if (fromId !== toId)
        await tx.relationship.create({
          data: { fromId, toId, kind: "MET", sourceId: tableId },
        });
    }
}
