"use client";

import { useState } from "react";
import type { AdminData } from "@/server/views";
import type {
  ManualAllocationPlan,
  ManualAllocationPreview,
} from "@/server/manual-allocation";
import { date, time, Field } from "./shared";

export function AdminAllocation({
  data,
  reload,
}: {
  data: AdminData;
  reload: () => Promise<void>;
}) {
  const [operation, setOperation] =
    useState<ManualAllocationPlan["operation"]>("MOVE");
  const [sources, setSources] = useState<string[]>([]);
  const [groups, setGroups] = useState<
    { eventId: string; venueSlotId: string }[]
  >([]);
  const [destinations, setDestinations] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ManualAllocationPreview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState("");
  const tables = data.tables.filter(
    (t) =>
      t.status === "CONFIRMED" &&
      new Date(t.event.startsAt).getTime() > Date.now(),
  );
  const events = data.events.filter(
    (e) =>
      ["OPEN", "MATCHED"].includes(e.status) &&
      new Date(e.startsAt).getTime() > Date.now(),
  );
  const sourceApps = data.tables
    .filter((t) => sources.includes(t.id))
    .flatMap((t) =>
      t.applications
        .filter((a) => a.applicationStatus === "SUBMITTED")
        .map((a) => a.id),
    );
  const candidates = data.applications.filter(
    (a) =>
      sourceApps.includes(a.id) ||
      (a.applicationStatus === "SUBMITTED" &&
        a.paymentStatus === "PAID" &&
        a.attendanceStatus === "SCHEDULED" &&
        (!a.table ||
          !["CONFIRMED", "WAITLIST_PENDING"].includes(a.table.status))),
  );
  const invalidate = () => {
    setPreview(null);
    setRequestId("");
    setNotice("");
  };
  function toggleSource(id: string, selected: boolean) {
    invalidate();
    const ids = selected ? [...sources, id] : sources.filter((t) => t !== id);
    setSources(ids);
    const selectedTables = data.tables.filter((t) => ids.includes(t.id));
    setGroups(
      operation === "UNASSIGN"
        ? []
        : selectedTables.map((t) => ({
            eventId: t.eventId,
            venueSlotId: t.venueSlotId ?? "",
          })),
    );
    setDestinations(
      Object.fromEntries(
        selectedTables.flatMap((t, i) =>
          t.applications.map((a) => [a.id, operation === "UNASSIGN" ? -1 : i]),
        ),
      ),
    );
  }
  function makePlan(): ManualAllocationPlan {
    return {
      operation,
      sourceTableIds: sources,
      reason,
      groups:
        operation === "UNASSIGN"
          ? []
          : groups.map((g, i) => ({
              ...g,
              applicationIds: candidates
                .filter((a) => destinations[a.id] === i)
                .map((a) => a.id),
            })),
      unassignApplicationIds: sourceApps.filter(
        (id) =>
          operation === "UNASSIGN" ||
          destinations[id] === undefined ||
          destinations[id] < 0,
      ),
    };
  }
  async function send(action: string, payload: unknown) {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data: payload }),
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        body.error + (body.details ? ` ${body.details.join(" ")}` : ""),
      );
    return body;
  }
  async function inspect() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setPreview(await send("manualAllocationPreview", makePlan()));
      setRequestId(crypto.randomUUID());
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "미리보기를 불러오지 못했어요.",
      );
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview?.valid) return;
    setBusy(true);
    setError("");
    try {
      await send("manualAllocationCommit", {
        ...makePlan(),
        version: preview.version,
        requestId,
      });
      setSources([]);
      setGroups([]);
      setDestinations({});
      setPreview(null);
      setReason("");
      setNotice("배정을 변경하고 새 안내를 예약했어요.");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "변경하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="card"
      aria-label="운영자 배정 수정"
      style={{ minWidth: 0 }}
    >
      <h2>운영자 배정 수정</h2>
      <p>
        이동·분리·병합·해제를 미리 확인하고 적용합니다. 모든 새 식탁은 4~6명이며
        기존 참가 조건을 충족해야 합니다.
      </p>
      <Field label="변경 종류">
        <select
          value={operation}
          disabled={busy}
          onChange={(e) => {
            invalidate();
            setOperation(e.target.value as typeof operation);
          }}
        >
          <option value="MOVE">이동·재배정</option>
          <option value="SPLIT">분리</option>
          <option value="MERGE">병합</option>
          <option value="UNASSIGN">전체 배정 해제</option>
        </select>
      </Field>
      <fieldset disabled={busy}>
        <legend>1. 변경할 원본 식탁</legend>
        {!tables.length && <p>수정할 시작 전 확정 식탁이 없습니다.</p>}
        {tables.map((t) => (
          <label key={t.id} style={{ display: "block", padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={sources.includes(t.id)}
              onChange={(e) => toggleSource(t.id, e.target.checked)}
            />{" "}
            {t.event.title} · {date(t.event.startsAt)} {time(t.event.startsAt)}{" "}
            · {t.venueSlot?.name ?? "식당 미지정"} ·{" "}
            {t.applications
              .filter((a) => a.applicationStatus === "SUBMITTED")
              .map((a) => a.user.name)
              .join(", ")}
          </label>
        ))}
      </fieldset>
      {operation !== "UNASSIGN" && (
        <fieldset disabled={busy}>
          <legend>2. 새 식탁 구성</legend>
          <p>
            분리할 인원이 부족하면 결제 완료 대기 참가자를 추가하세요. 병합 후
            남는 참가자의 해제는 미리보기에 표시됩니다.
          </p>
          {groups.map((g, i) => (
            <div
              key={i}
              style={{
                border: "1px solid #ddd",
                padding: 12,
                marginBottom: 10,
              }}
            >
              <h3>
                새 식탁 {i + 1} ·{" "}
                {candidates.filter((a) => destinations[a.id] === i).length}명
              </h3>
              <Field label={`새 식탁 ${i + 1} 회차`}>
                <select
                  value={g.eventId}
                  onChange={(e) => {
                    invalidate();
                    const eventId = e.target.value;
                    setGroups(
                      groups.map((old, n) =>
                        n === i
                          ? {
                              eventId,
                              venueSlotId:
                                events.find((ev) => ev.id === eventId)
                                  ?.venues[0]?.id ?? "",
                            }
                          : old,
                      ),
                    );
                  }}
                >
                  <option value="">회차 선택</option>
                  {events.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title} · {date(e.startsAt)} {time(e.startsAt)} ·{" "}
                      {e.region}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`새 식탁 ${i + 1} 식당`}>
                <select
                  value={g.venueSlotId}
                  onChange={(e) => {
                    invalidate();
                    setGroups(
                      groups.map((old, n) =>
                        n === i ? { ...old, venueSlotId: e.target.value } : old,
                      ),
                    );
                  }}
                >
                  <option value="">식당 선택</option>
                  {events
                    .find((e) => e.id === g.eventId)
                    ?.venues.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} · 최대 {v.capacity}명 · {v.totalTables}테이블
                      </option>
                    ))}
                </select>
              </Field>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  invalidate();
                  setGroups(groups.filter((_, n) => n !== i));
                  setDestinations(
                    Object.fromEntries(
                      Object.entries(destinations).map(([id, n]) => [
                        id,
                        n === i ? -1 : n > i ? n - 1 : n,
                      ]),
                    ),
                  );
                }}
              >
                새 식탁 {i + 1} 제거
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button secondary"
            disabled={!sources.length || groups.length >= 12}
            onClick={() => {
              invalidate();
              const event = events[0];
              setGroups([
                ...groups,
                {
                  eventId: event?.id ?? "",
                  venueSlotId: event?.venues[0]?.id ?? "",
                },
              ]);
            }}
          >
            새 식탁 추가
          </button>
          {sources.length > 0 &&
            candidates.map((a) => (
              <Field
                key={a.id}
                label={`${a.user.name} · ${sourceApps.includes(a.id) ? "원본 참가자" : "추가 가능한 대기 참가자"}`}
              >
                <select
                  value={destinations[a.id] ?? -1}
                  onChange={(e) => {
                    invalidate();
                    setDestinations({
                      ...destinations,
                      [a.id]: Number(e.target.value),
                    });
                  }}
                >
                  <option value={-1}>
                    {sourceApps.includes(a.id)
                      ? "배정 해제 → 이동·보관·환불 선택"
                      : "추가하지 않음"}
                  </option>
                  {groups.map((_, i) => (
                    <option key={i} value={i}>
                      새 식탁 {i + 1}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
        </fieldset>
      )}
      <Field label="변경 사유 (참가자에게 안내됩니다)">
        <textarea
          minLength={5}
          maxLength={500}
          value={reason}
          disabled={busy}
          onChange={(e) => {
            invalidate();
            setReason(e.target.value);
          }}
        />
      </Field>
      <button
        type="button"
        className="button secondary"
        disabled={busy || !sources.length || reason.trim().length < 5}
        onClick={async () => {
          setBusy(true);
          setError("");
          invalidate();
          try {
            await send("allocationException", { tableIds: sources, reason });
            setNotice(
              "운영 예외를 등록했습니다. 변경 내용을 미리보기로 확인해 주세요.",
            );
            await reload();
          } catch (e) {
            setError(e instanceof Error ? e.message : "예외 등록 실패");
          } finally {
            setBusy(false);
          }
        }}
      >
        실제 운영 예외 등록
      </button>
      <p className="small muted">
        실제 발생한 취소·안전·예약 문제를 사유에 적어 등록해 주세요. 등록과 배정
        변경은 운영 이력에 남습니다.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={busy || !sources.length || reason.trim().length < 5}
        onClick={inspect}
      >
        변경 미리보기
      </button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {preview && (
        <div aria-label="배정 변경 미리보기" style={{ marginTop: 16 }}>
          <h3>
            {preview.valid
              ? "적용 가능한 변경입니다"
              : "다음 조건을 해결해 주세요"}
          </h3>
          {preview.issues.length > 0 && (
            <ul>
              {preview.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <p>
            원본 {preview.sourceTables.length}개 식탁의 단체방을 닫습니다. 예약
            작업 {preview.canceledJobs.length}개를 취소합니다.
          </p>
          {preview.groups.map((g, i) => (
            <p key={i}>
              새 식탁 {i + 1}: {g.eventTitle} · {g.venueName} ·{" "}
              {g.members.map((a) => a.name).join(", ")}
            </p>
          ))}
          <p>
            배정 해제:{" "}
            {preview.unassigned.map((a) => a.name).join(", ") || "없음"}
          </p>
          <ul>
            {preview.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          <p>안내 사유: {preview.reason}</p>
          <button
            type="button"
            className="button primary"
            disabled={busy || !preview.valid}
            onClick={commit}
          >
            미리보기대로 배정 변경
          </button>
        </div>
      )}
    </section>
  );
}
