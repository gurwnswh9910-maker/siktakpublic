"use client";

import { date, time } from "./shared";

export type WaitlistEvent = {
  id: string;
  title: string;
  region: string;
  startsAt: string;
  status: string;
};

export type ParticipantWaitlistEntry = {
  id: string;
  status: string;
  expiresAt: string | null;
  event: WaitlistEvent;
};

export type WaitlistApplication = {
  id: string;
  applicationStatus: string;
  paymentStatus: string;
  matchStatus: string;
  attendanceStatus: string;
  tableId: string | null;
  resolution: string | null;
  options: { eventId: string; event: WaitlistEvent }[];
  waitlist?: ParticipantWaitlistEntry | null;
};

export const waitlistStatusLabels: Record<string, string> = {
  WAITING: "자리 기다리는 중",
  OFFERED: "참가 제안 도착",
  ACCEPTED: "제안 수락 완료",
  DECLINED: "제안 거절",
  EXPIRED: "대기 또는 제안 마감",
  WITHDRAWN: "대기 철회",
  CLOSED: "대기 종료",
};

export function ParticipantWaitlist({
  application,
  perform,
  busy,
}: {
  application: WaitlistApplication;
  perform: (action: string, payload: unknown) => Promise<boolean>;
  busy: boolean;
}) {
  const entry = application.waitlist;
  const active = entry && ["WAITING", "OFFERED"].includes(entry.status);
  const eligible =
    application.applicationStatus === "SUBMITTED" &&
    ["PAID", "REFUND_AVAILABLE"].includes(application.paymentStatus) &&
    application.attendanceStatus === "SCHEDULED" &&
    application.matchStatus !== "CONFIRMED" &&
    !application.tableId &&
    !application.resolution;
  const events = application.options
    .map((option) => option.event)
    .filter(
      (event) =>
        ["OPEN", "MATCHED"].includes(event.status) &&
        new Date(event.startsAt).getTime() > Date.now(),
    );
  const expired =
    entry?.status === "OFFERED" &&
    (!entry.expiresAt ||
      new Date(entry.expiresAt).getTime() <= Date.now() ||
      new Date(entry.event.startsAt).getTime() <= Date.now());

  if (!entry && (!eligible || !events.length)) return null;

  return (
    <section className="card stack" aria-label="취소 자리 대기">
      <h3>취소 자리 대기</h3>
      {entry && (
        <div className="stack">
          <p>
            <strong>
              {waitlistStatusLabels[entry.status] ?? "대기 상태 확인 중"}
            </strong>
            <br />
            {entry.event.title} · {entry.event.region}
            <br />
            <span className="small muted">
              {date(entry.event.startsAt)} {time(entry.event.startsAt)} (한국
              시간)
            </span>
          </p>
          {entry.status === "WAITING" && (
            <p className="small muted">
              참가 조건에 맞는 취소 자리가 생기면 등록 순서대로 제안해요. 제안을
              수락하기 전에는 참가가 확정되지 않아요.
            </p>
          )}
          {entry.status === "OFFERED" && (
            <>
              <p>
                {entry.expiresAt && (
                  <>
                    응답 기한:{" "}
                    <strong>
                      {date(entry.expiresAt)} {time(entry.expiresAt)}
                    </strong>{" "}
                    (한국 시간)
                    <br />
                  </>
                )}
                {expired
                  ? "응답 기한이 지났어요. 다음 대기자에게 순서가 넘어갑니다."
                  : "기한 안에 수락해 주세요. 거절하거나 응답하지 않으면 다음 대기자에게 안내해요."}
              </p>
              <p className="small muted">
                수락할 때 최신 참가 조건과 남은 자리를 확인해요. 조건이 달라진
                경우에는 확정되지 않을 수 있어요.
              </p>
              <div className="row wrap">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || expired || !eligible}
                  onClick={() =>
                    void perform("waitlistRespond", {
                      applicationId: application.id,
                      choice: "ACCEPT",
                    })
                  }
                >
                  참가 제안 수락
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || expired}
                  onClick={() =>
                    void perform("waitlistRespond", {
                      applicationId: application.id,
                      choice: "DECLINE",
                    })
                  }
                >
                  이번 제안 거절
                </button>
              </div>
            </>
          )}
          {entry.status === "ACCEPTED" && (
            <p className="small muted">
              현재 모임 장소와 참가 상태는 이 신청의 최신 안내를 확인해 주세요.
            </p>
          )}
        </div>
      )}
      {active ? (
        <>
          <p className="small muted">
            대기 중에는 다른 식탁의 자동 배정을 잠시 멈춰요. 대기를 철회해도
            신청이 취소되거나 자동 환불되지는 않아요.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void perform("waitlistWithdraw", {
                applicationId: application.id,
              })
            }
          >
            대기 철회
          </button>
        </>
      ) : eligible && events.length > 0 ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void perform("waitlistJoin", {
              applicationId: application.id,
              eventId: String(form.get("waitlistEventId")),
            });
          }}
        >
          <p className="small muted">
            선택했던 일정 중 한 회차의 취소 자리를 기다릴 수 있어요. 자리가
            생겨도 참가 조건에 따라 제안되지 않을 수 있으며, 대기 중에는 다른
            식탁의 자동 배정을 잠시 멈춰요.
          </p>
          <label className="field">
            <span>대기할 일정</span>
            <select name="waitlistEventId" required disabled={busy}>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {date(event.startsAt)} {time(event.startsAt)} · {event.region}{" "}
                  · {event.title}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary" disabled={busy}>
            취소 자리 대기 등록
          </button>
        </form>
      ) : null}
    </section>
  );
}
