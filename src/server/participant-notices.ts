import type { Job } from "@prisma/client";

export type NoticeJob = Pick<Job, "kind" | "payload" | "status" | "runAt">;
type Event = { id: string; status: string; startsAt: Date; endsAt: Date };
type Application = {
  applicationStatus: string;
  paymentStatus: string;
  matchStatus: string;
  attendanceStatus: string;
  feedback: unknown;
  options: { event: Event }[];
  table: { id: string; status: string; event: Event } | null;
};
type NoticeState =
  | "SCHEDULED"
  | "DELAYED"
  | "PROCESSING"
  | "FAILED"
  | "UNSCHEDULED"
  | "COMPLETED"
  | "CANCELED";
export type NextNotice = {
  kind: string | null;
  label: string;
  state: NoticeState;
  scheduledAt: Date | null;
  detail: string;
};
const labels: Record<string, string> = {
  MATCH: "매칭 결과 안내",
  REMINDER: "모임 전 안내",
  START: "모임 시작·대화 카드",
  END: "모임 종료·피드백 안내",
  FEEDBACK_REMINDER: "미작성 피드백 안내",
};
export function nextNotice(
  application: Application,
  jobs: NoticeJob[],
  now = new Date(),
): NextNotice {
  const none = (state: NoticeState, detail: string): NextNotice => ({
    kind: null,
    label: "다음 안내",
    state,
    scheduledAt: null,
    detail,
  });
  if (application.applicationStatus === "CANCELED")
    return none("CANCELED", "취소된 신청에는 모임 안내를 보내지 않아요.");
  if (application.applicationStatus !== "SUBMITTED")
    return none(
      "UNSCHEDULED",
      "신청을 완료하면 다음 안내 일정을 확인할 수 있어요.",
    );
  if (["PENDING", "FAILED"].includes(application.paymentStatus))
    return none("UNSCHEDULED", "결제 완료 후 매칭 안내 일정을 확인해 주세요.");
  if (application.paymentStatus !== "PAID")
    return none(
      "UNSCHEDULED",
      "이동·보관·환불 등 신청 상태에 맞는 다음 행동을 확인해 주세요.",
    );
  const table = application.table;
  let relevant: NoticeJob[];
  if (
    application.matchStatus === "CONFIRMED" &&
    table?.status === "CONFIRMED"
  ) {
    if (table.event.status === "CANCELED")
      return none(
        "CANCELED",
        "취소된 회차의 안내 일정이에요. 신청 상태를 확인해 주세요.",
      );
    const kinds = new Set([
      ...(now < table.event.startsAt ? ["REMINDER"] : []),
      ...(now < table.event.endsAt ? ["START"] : []),
      "END",
      ...(application.attendanceStatus === "ATTENDED" && !application.feedback
        ? ["FEEDBACK_REMINDER"]
        : []),
    ]);
    relevant = jobs.filter(
      (j) =>
        kinds.has(j.kind) &&
        (j.payload as Record<string, unknown> | null)?.tableId === table.id,
    );
  } else if (
    ["WAITING", "MATCHING", "REALLOCATING"].includes(application.matchStatus)
  ) {
    const eventIds = new Set(
      application.options
        .filter((o) => o.event.status !== "CANCELED")
        .map((o) => o.event.id),
    );
    relevant = jobs.filter(
      (j) =>
        j.kind === "MATCH" &&
        eventIds.has(
          String((j.payload as Record<string, unknown> | null)?.eventId),
        ),
    );
  } else {
    return none(
      "UNSCHEDULED",
      "이동·보관·환불 등 신청 상태에 맞는 다음 행동을 확인해 주세요.",
    );
  }
  const pending = relevant
    .filter((j) => j.status !== "DONE" && j.status !== "CANCELED")
    .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  const job = pending[0];
  if (!job) {
    if (relevant.some((j) => j.status === "CANCELED"))
      return none(
        "CANCELED",
        "예정된 안내가 취소되었어요. 새 일정이 정해지면 표시할게요.",
      );
    if (
      table &&
      now >= table.event.endsAt &&
      relevant.some((j) => j.kind === "END") &&
      (application.attendanceStatus !== "ATTENDED" ||
        application.feedback ||
        relevant.some((j) => j.kind === "FEEDBACK_REMINDER")) &&
      relevant.every((j) => j.status === "DONE")
    )
      return none(
        "COMPLETED",
        "현재 신청에 예약된 안내 처리가 완료되었어요. 도착한 소식을 알림에서 확인해 주세요.",
      );
    return none("UNSCHEDULED", "아직 다음 안내 일정이 정해지지 않았어요.");
  }
  const state: NoticeState =
    job.status === "FAILED"
      ? "FAILED"
      : job.status === "RUNNING"
        ? "PROCESSING"
        : job.runAt.getTime() < now.getTime()
          ? "DELAYED"
          : "SCHEDULED";
  const detail = {
    FAILED: "안내 처리가 실패해 운영자가 확인해야 해요.",
    PROCESSING: "안내를 처리하고 있어요.",
    DELAYED: "예정 시각이 지났어요. 예약 처리 결과를 기다리고 있어요.",
    SCHEDULED: "예약된 처리 시각이며 실제 안내 도착까지 시간이 걸릴 수 있어요.",
  }[state];
  return {
    kind: job.kind,
    label: labels[job.kind],
    state,
    scheduledAt: job.runAt,
    detail,
  };
}
