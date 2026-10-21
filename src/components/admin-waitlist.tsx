"use client";

import { Empty, Field, date, time } from "./shared";
import {
  type ParticipantWaitlistEntry,
  type WaitlistEvent,
  waitlistStatusLabels,
} from "./participant-waitlist";

export type AdminWaitlistEntry = ParticipantWaitlistEntry & {
  applicationId: string;
  createdAt: string;
  tableId: string | null;
  application: { user: { name: string } };
};

export function AdminWaitlist({
  entries,
  events,
  responseMinutesByEvent = {},
  perform,
  busy,
}: {
  entries: AdminWaitlistEntry[];
  events: WaitlistEvent[];
  responseMinutesByEvent?: Record<string, number>;
  perform: (action: string, payload: unknown) => Promise<boolean>;
  busy: boolean;
}) {
  const availableEvents = events.filter(
    (event) =>
      ["OPEN", "MATCHED"].includes(event.status) &&
      new Date(event.startsAt).getTime() > Date.now(),
  );
  const orderedEntries = [...entries].sort(
    (a, b) =>
      a.event.id.localeCompare(b.event.id) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.id.localeCompare(b.id),
  );
  const positions = new Map<string, number>();
  const queueCounts = new Map<string, number>();
  for (const entry of orderedEntries) {
    if (entry.status !== "WAITING") continue;
    const position = (queueCounts.get(entry.event.id) ?? 0) + 1;
    positions.set(entry.id, position);
    queueCounts.set(entry.event.id, position);
  }

  return (
    <div className="stack">
      <section className="panel">
        <h2>대기자 순차 안내</h2>
        <p className="muted">
          회차별 등록 시각과 ID 순서로 참가 조건에 맞는 대기자에게 제안합니다.
          응답 기한이 지나거나 거절하면 다음 대기자에게 자동으로 안내합니다.
          대기 순번은 참가 확정을 보장하지 않습니다.
        </p>
        <div className="row wrap">
          <span className="badge">
            대기 {entries.filter((entry) => entry.status === "WAITING").length}
            명
          </span>
          <span className="badge">
            응답 대기{" "}
            {entries.filter((entry) => entry.status === "OFFERED").length}명
          </span>
          <span className="badge green">
            수락 {entries.filter((entry) => entry.status === "ACCEPTED").length}
            명
          </span>
        </div>
        {entries.length ? (
          <div className="data-table">
            <table>
              <thead>
                <tr>
                  <th>참가자</th>
                  <th>회차</th>
                  <th>대기 상태</th>
                  <th>등록 · 응답 기한</th>
                </tr>
              </thead>
              <tbody>
                {orderedEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <strong>{entry.application.user.name}</strong>
                      <small>신청 {entry.applicationId}</small>
                    </td>
                    <td>
                      {entry.event.title}
                      <small>
                        {date(entry.event.startsAt)}{" "}
                        {time(entry.event.startsAt)} · {entry.event.region}
                      </small>
                    </td>
                    <td>
                      <span
                        className={`badge ${entry.status === "ACCEPTED" ? "green" : ""}`}
                      >
                        {waitlistStatusLabels[entry.status] ?? entry.status}
                      </span>
                      {positions.has(entry.id) && (
                        <small>현재 대기 {positions.get(entry.id)}번째</small>
                      )}
                      {entry.tableId && (
                        <small>제안 테이블 {entry.tableId}</small>
                      )}
                    </td>
                    <td>
                      등록 {date(entry.createdAt)} {time(entry.createdAt)}
                      {entry.expiresAt && (
                        <small>
                          응답 기한 {date(entry.expiresAt)}{" "}
                          {time(entry.expiresAt)} (한국 시간)
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="등록된 대기자가 없습니다"
            body="참가자가 신청 상세에서 대기 등록하면 이곳에서 확인할 수 있습니다."
          />
        )}
      </section>

      <section className="panel stack">
        <h2>회차별 응답 기한</h2>
        <p className="muted">
          기본 30분이며 1~120분으로 설정할 수 있습니다. 변경 후 새로 보내는
          제안부터 적용하고, 이미 보낸 제안의 기한은 바꾸지 않습니다. 행사 시작
          시각을 넘겨 응답할 수 없습니다.
        </p>
        {availableEvents.length ? (
          availableEvents.map((event) => (
            <form
              className="card stack"
              key={`${event.id}:${responseMinutesByEvent[event.id] ?? 30}`}
              onSubmit={(submit) => {
                submit.preventDefault();
                const form = new FormData(submit.currentTarget);
                void perform("waitlistSetting", {
                  eventId: event.id,
                  minutes: Number(form.get("minutes")),
                });
              }}
            >
              <h3>
                {event.title} · {event.region}
              </h3>
              <p className="small muted">
                {date(event.startsAt)} {time(event.startsAt)} (한국 시간)
              </p>
              <Field label="새 제안의 응답 시간 (분)">
                <input
                  type="number"
                  name="minutes"
                  min={1}
                  max={120}
                  step={1}
                  required
                  defaultValue={responseMinutesByEvent[event.id] ?? 30}
                  disabled={busy}
                />
              </Field>
              <button className="secondary" disabled={busy}>
                응답 기한 저장
              </button>
            </form>
          ))
        ) : (
          <p className="muted">대기 응답 기한을 설정할 미래 회차가 없습니다.</p>
        )}
      </section>
    </div>
  );
}
