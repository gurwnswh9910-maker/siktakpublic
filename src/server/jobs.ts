import { Tx } from "./db";
import type { Prisma } from "@prisma/client";
export async function enqueue(
  tx: Tx,
  key: string,
  kind: string,
  payload: Prisma.InputJsonValue,
  runAt = new Date(),
) {
  return tx.job.upsert({
    where: { key },
    create: { key, kind, payload, runAt },
    update: {},
  });
}
export async function notify(
  tx: Tx,
  userId: string,
  key: string,
  title: string,
  body: string,
  href = "/app",
) {
  const recipient = await tx.user.findUnique({
    where: { id: userId },
    select: { restriction: true },
  });
  if (recipient?.restriction === "WITHDRAWN") return null;
  const n = await tx.notification.upsert({
    where: { key },
    create: { userId, key, title, body, href },
    update: {},
  });
  await enqueue(tx, `push:${key}`, "PUSH", { notificationId: n.id });
  return n;
}
