import {
  notificationTemplates,
  eventDateTime,
} from "@/domain/notification-templates";
import type { Tx } from "./db";
import {
  savedTicketOffer,
  ticketDescription,
  type TicketOffer,
} from "@/domain/ticket-products";
import { suitableAlternatives } from "./alternative-events";
import type { EventSlot, VenueSlot } from "@prisma/client";
import {
  cancellationCutoff,
  cancellationNotice,
} from "@/domain/cancellation-policy";

type ApplicationEvent = Pick<
  EventSlot,
  | "title"
  | "region"
  | "startsAt"
  | "matchAt"
  | "closesAt"
  | "cancelRefundCutoffAt"
>;

function eventDescription(event: ApplicationEvent) {
  return `${event.title} · ${eventDateTime(event.startsAt)} · ${event.region}`;
}

function selectedEvents(events: readonly ApplicationEvent[]) {
  return [...events].sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      a.title.localeCompare(b.title),
  );
}

export function applicationNotice(
  events: readonly ApplicationEvent[],
  ticketType: string,
  offer?: TicketOffer,
) {
  const ticket = ticketDescription(offer ?? savedTicketOffer(ticketType, null));
  return [
    "선택한 신청 내용:",
    ...selectedEvents(events).map(eventDescription),
    `참가권: ${ticket}`,
    "프로필은 마이의 ‘프로필 수정하기’에서 변경할 수 있어요. 신청 취소는 신청 상세의 ‘신청 취소 기록하기’에서 진행해 주세요. 신청 일정을 다시 선택하려면 취소 정책을 확인한 뒤 새로 신청해 주세요.",
    cancellationNotice(
      cancellationCutoff({ options: events.map((event) => ({ event })) }),
    ),
  ].join("\n");
}

export function pendingPaymentNotice(
  events: readonly ApplicationEvent[],
  ticketType: string,
) {
  return [
    ticketType === "EXISTING"
      ? "신청 상세의 ‘모의 결제 완료하기’를 누르면 보유 이용권 1회가 사용됩니다. 실제 금전 거래는 없습니다."
      : "신청 상세의 ‘모의 결제 완료하기’로 결제를 완료해 주세요. 실제 금전 거래는 없습니다.",
    "일정별 결제 마감 (한국 시간, 해당 시각 전까지):",
    ...selectedEvents(events).map(
      (event) =>
        `${eventDescription(event)}\n결제 마감: ${eventDateTime(event.closesAt)}`,
    ),
    "선택한 일정 중 모집 중이며 마감 전인 일정이 있어야 결제할 수 있어요.",
  ].join("\n");
}

export function matchScheduleNotice(events: readonly ApplicationEvent[]) {
  return selectedEvents(events)
    .map(
      (event) =>
        `${eventDescription(event)}\n자동 매칭 예약: ${eventDateTime(event.matchAt)} (한국 시간)`,
    )
    .join("\n");
}

export async function loadNotificationTemplates(tx: Tx) {
  const setting = await tx.setting.findUnique({
    where: { key: "notificationTemplates" },
  });
  return notificationTemplates(setting?.value);
}

export async function reminderNotice(
  tx: Tx,
  table: {
    event: Pick<EventSlot, "startsAt" | "region" | "cancelRefundCutoffAt">;
    venueSlot: Pick<VenueSlot, "name" | "address" | "reservationName"> | null;
  },
) {
  const templates = await loadNotificationTemplates(tx);
  const venue = table.venueSlot;
  return [
    templates.reminder,
    `${eventDateTime(table.event.startsAt)} · ${table.event.region}`,
    venue
      ? `${venue.name} · ${venue.address}\n예약명: ${venue.reservationName}`
      : "식당과 예약 정보는 모임 상세에서 확인해 주세요.",
    cancellationNotice(table.event.cancelRefundCutoffAt),
    "행사 종료까지 체크인이 없으면 운영자가 실제 참석 여부를 확인한 뒤 노쇼를 판단합니다. 안전 문제는 언제든 신고할 수 있어요.",
  ].join("\n");
}

export async function alternativeNotice(
  tx: Tx,
  excludedEventId: string,
  applicationId?: string,
) {
  if (applicationId) {
    const candidates = await suitableAlternatives(
      tx,
      applicationId,
      excludedEventId,
    );
    const feasible = candidates.filter((e) => e.status === "FEASIBLE");
    const templates = await loadNotificationTemplates(tx);
    return {
      count: feasible.length,
      body: (reason: string) =>
        `${templates.alternative}\n${reason}\n${
          feasible.length
            ? "현재 조건에 맞는 대체 일정:\n" +
              feasible
                .slice(0, 3)
                .map(
                  (e) =>
                    `${eventDateTime(e.startsAt)} · ${e.region} · ${e.title}`,
                )
                .join("\n")
            : "현재 적합성이 확인된 대체 일정은 없습니다. 모집 중인 일정의 대기 가능 여부는 상세에서 확인해 주세요."
        }\n참가자·재고 변동으로 확정이 보장되지는 않아요. 일정 이동은 직접 동의한 뒤 진행됩니다. 이용권 보관 또는 환불도 선택할 수 있어요.`,
    };
  }
  const now = new Date();
  const events = await tx.eventSlot.findMany({
    where: {
      id: { not: excludedEventId },
      status: "OPEN",
      closesAt: { gt: now },
      startsAt: { gt: now },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    select: { title: true, region: true, startsAt: true },
  });
  const templates = await loadNotificationTemplates(tx);
  const schedules = events.length
    ? `모집 중인 다른 일정:\n${events
        .slice(0, 3)
        .map(
          (event) =>
            `${eventDateTime(event.startsAt)} · ${event.region} · ${event.title}`,
        )
        .join(
          "\n",
        )}${events.length > 3 ? "\n더 많은 일정은 모임 상세에서 확인해 주세요." : ""}`
    : "현재 모집 중인 다른 일정은 없어요.";
  return {
    count: events.length,
    // Operational copy can change; resolution rights and available dates cannot
    // accidentally disappear when an operator edits the introduction.
    body: (reason: string) =>
      `${templates.alternative}\n${reason}\n${schedules}\n일정 이동은 직접 선택한 뒤 진행됩니다. 이용권 보관 또는 환불도 선택할 수 있어요.`,
  };
}
