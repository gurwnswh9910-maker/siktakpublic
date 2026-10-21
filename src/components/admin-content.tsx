"use client";
import { useState } from "react";
import {
  contentTags,
  type ContentCatalogEntry,
  type ContentDraft,
} from "@/domain/content-catalog";
import { Field } from "./shared";

const timingLabels = {
  START: "모임 시작",
  REMINDER: "전날 안내",
  END: "모임 종료",
};
const kindLabels = {
  QUESTION: "대화 주제",
  ACTIVITY: "아이스브레이킹",
  GUIDE: "진행 안내",
};
const blank: ContentDraft = {
  title: "",
  body: "",
  kind: "QUESTION",
  timing: "START",
  tag: "전체",
  priority: 50,
  validFrom: null,
  validUntil: null,
};
const localTime = (value: string | null) =>
  value
    ? new Date(new Date(value).getTime() + 9 * 3600000)
        .toISOString()
        .slice(0, 16)
    : "";
const utcTime = (value: string) =>
  value ? new Date(value + ":00+09:00").toISOString() : null;

export function AdminContent({
  items,
  busy,
  perform,
}: {
  items: ContentCatalogEntry[];
  busy: boolean;
  perform: (action: string, payload: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<{
    id: string;
    expectedVersion: number;
  } | null>(null);
  const [draft, setDraft] = useState<ContentDraft>(blank);
  const [preview, setPreview] = useState<ContentDraft | null>(null);
  const reset = () => {
    setEditing(null);
    setDraft(blank);
    setPreview(null);
  };
  return (
    <section className="stack" aria-label="콘텐츠 관리">
      <div className="panel">
        <h2>콘텐츠 등록·노출 규칙</h2>
        <p>
          관심사·대화 성향에 해당하는 태그만 적용합니다. 우선순위가 같으면
          콘텐츠 ID 순으로 최대 3개를 골라 예약합니다. 시작 콘텐츠가 부족하면
          기본 주제로 총 3개를 제공합니다.
        </p>
        <p>
          게시 후 새로 확정되는 식탁부터 적용됩니다. 편집·재게시는 기존 예약
          본문과 보낸 메시지를 바꾸지 않습니다. 중지는 기존 게시본의 미발송
          콘텐츠에도 적용되고, 다시 게시해도 중지된 과거 예약은 복구하지
          않습니다.
        </p>
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const target = editing ?? {
              id: crypto.randomUUID(),
              expectedVersion: 0,
            };
            // Keep the same identity when a response is lost and the user retries.
            if (!editing) setEditing(target);
            if (await perform("contentSave", { ...target, draft })) reset();
          }}
        >
          <h3>{editing ? "초안 편집" : "새 콘텐츠"}</h3>
          <Field label="콘텐츠 제목">
            <input
              required
              maxLength={100}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field label="콘텐츠 본문">
            <textarea
              required
              maxLength={2000}
              rows={5}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>
          <p className="muted">
            HTML·스크립트 없이 일반 텍스트만 입력해 주세요. 참여자가 답변을
            건너뛸 수 있도록 안내해 주세요.
          </p>
          <div
            className="form-grid"
            style={{
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
            }}
          >
            <Field label="콘텐츠 유형">
              <select
                value={draft.kind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    kind: e.target.value as ContentDraft["kind"],
                  })
                }
              >
                {Object.entries(kindLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="노출 시점">
              <select
                value={draft.timing}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    timing: e.target.value as ContentDraft["timing"],
                  })
                }
              >
                {Object.entries(timingLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="테이블 태그">
              <select
                value={draft.tag}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    tag: e.target.value as ContentDraft["tag"],
                  })
                }
              >
                {contentTags.map((tag) => (
                  <option key={tag}>{tag}</option>
                ))}
              </select>
            </Field>
            <Field label="우선순위 (0~100, 높을수록 우선)">
              <input
                type="number"
                min={0}
                max={100}
                required
                value={draft.priority}
                onChange={(e) =>
                  setDraft({ ...draft, priority: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="유효 시작 (KST, 선택)">
              <input
                type="datetime-local"
                value={localTime(draft.validFrom)}
                onChange={(e) =>
                  setDraft({ ...draft, validFrom: utcTime(e.target.value) })
                }
              />
            </Field>
            <Field label="유효 종료 (KST, 선택)">
              <input
                type="datetime-local"
                value={localTime(draft.validUntil)}
                onChange={(e) =>
                  setDraft({ ...draft, validUntil: utcTime(e.target.value) })
                }
              />
            </Field>
          </div>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}
          >
            <button
              className="secondary"
              type="button"
              onClick={() => setPreview(draft)}
            >
              입력 내용 미리보기
            </button>
            <button className="primary" disabled={busy} type="submit">
              초안 저장
            </button>
            {editing && (
              <button className="secondary" type="button" onClick={reset}>
                편집 취소
              </button>
            )}
          </div>
        </form>
      </div>
      {preview && (
        <div className="panel" aria-label="콘텐츠 미리보기">
          <h3>{preview.title || "제목을 입력해 주세요"}</h3>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {preview.body}
          </p>
          <p className="muted">
            {kindLabels[preview.kind]} · {timingLabels[preview.timing]} ·{" "}
            {preview.tag} · 우선순위 {preview.priority}
          </p>
          <p className="muted">
            {preview.validFrom
              ? new Date(preview.validFrom).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })
              : "시작 제한 없음"}{" "}
            ~{" "}
            {preview.validUntil
              ? new Date(preview.validUntil).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })
              : "종료 제한 없음"}{" "}
            (KST)
          </p>
        </div>
      )}
      {items.length === 0 && (
        <p className="empty">
          등록한 콘텐츠가 없습니다. 기존 기본 대화 주제는 자동으로 제공됩니다.
        </p>
      )}
      {items.map((item) => (
        <article className="panel" key={item.id}>
          <h3>{item.draft.title}</h3>
          <p>
            {item.published
              ? `게시 중 · 게시 버전 ${item.published.revision}`
              : item.stoppedThrough
                ? "게시 중지"
                : "초안"}{" "}
            · 수정 버전 {item.version}
          </p>
          <p className="muted">
            {kindLabels[item.draft.kind]} · {timingLabels[item.draft.timing]} ·{" "}
            {item.draft.tag} · 우선순위 {item.draft.priority}
          </p>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {item.draft.body}
          </p>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}
          >
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setEditing({ id: item.id, expectedVersion: item.version });
                setDraft(item.draft);
                setPreview(null);
              }}
            >
              편집
            </button>
            <button
              className="secondary"
              onClick={() => setPreview(item.draft)}
            >
              저장한 초안 미리보기
            </button>
            {item.published && (
              <button
                className="secondary"
                onClick={() => setPreview(item.published)}
              >
                게시본 미리보기
              </button>
            )}
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void perform("contentPublish", {
                  id: item.id,
                  expectedVersion: item.version,
                })
              }
            >
              저장한 초안 게시
            </button>
            <button
              className="secondary"
              disabled={busy || !item.published}
              onClick={() =>
                void perform("contentStop", {
                  id: item.id,
                  expectedVersion: item.version,
                })
              }
            >
              게시 중지
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
