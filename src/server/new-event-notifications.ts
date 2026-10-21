import type { EventSlot } from "@prisma/client";
import { eventDateTime, eventWeekday } from "@/domain/notification-templates";
import type { Tx } from "./db";
import { notify } from "./jobs";

export async function notifyNewEvent(tx: Tx, event: EventSlot) {
  const now = new Date();
  if (event.status !== "OPEN" || event.closesAt <= now || event.startsAt <= now)
    return;
  const users = await tx.user.findMany({
    where: {
      role: "PARTICIPANT",
      restriction: { in: ["NONE", "WARNING"] },
      applications: { some: { attendanceStatus: "ATTENDED" } },
    },
    select: {
      id: true,
      applications: {
        select: {
          attendanceStatus: true,
          options: { select: { event: { select: { region: true } } } },
          table: {
            select: { event: { select: { region: true, startsAt: true } } },
          },
          feedback: { select: { returnIntent: true } },
        },
      },
    },
  });
  for (const user of users) {
    // Use the same signals as the home recommendations: chosen regions and
    // weekdays of attended events with positive (or not yet given) feedback.
    const successful = user.applications.filter(
      (a) =>
        a.attendanceStatus === "ATTENDED" &&
        a.table &&
        (!a.feedback || a.feedback.returnIntent),
    );
    const regionMatches =
      user.applications.some((a) =>
        a.options.some((option) => option.event.region === event.region),
      ) || successful.some((a) => a.table!.event.region === event.region);
    const dayMatches = successful.some(
      (a) =>
        eventWeekday(a.table!.event.startsAt) === eventWeekday(event.startsAt),
    );
    if (!regionMatches || !dayMatches) continue;
    await notify(
      tx,
      user.id,
      `new-event:${event.id}:${user.id}`,
      "새로운 식탁이 열렸어요",
      `${eventDateTime(event.startsAt)} · ${event.region}. 이전에 선택한 지역과 참석했던 요일의 새 일정을 확인해 주세요.`,
      "/app?tab=events",
    );
  }
}
