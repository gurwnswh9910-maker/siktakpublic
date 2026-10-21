"use client";
import { AdminMatchingPolicy } from "./admin-matching-policy";
import { AdminAllocation } from "./admin-allocation";
import { isMeetingDayOrLater } from "@/domain/cancellation-policy";
import { AdminContent } from "./admin-content";
import { AdminWaitlist } from "./admin-waitlist";
import { useState } from "react";
import {
  Activity,
  CalendarDays,
  Users,
  UtensilsCrossed,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Send,
  Settings,
  ArrowUpRight,
  Download,
  LogOut,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { AdminData } from "@/server/views";
import type { MatchFacts, MatchHistory } from "@/server/match-facts";
import { AdminOperationalSummary } from "./admin-operational-summary";
import { notificationTemplates } from "@/domain/notification-templates";
import {
  Brand,
  Badge,
  Field,
  Empty,
  date,
  time,
  useView,
  signOut,
  refundExplanation,
} from "./shared";
type OpsApplication = AdminData["applications"][number];
const relationshipLabels: Record<string, string> = {
  AVOID: "비선호",
  BLOCK: "차단",
  REPORT: "신고",
};
const jobHistoryLabels: Record<string, string> = {
  STARTED: "실행 시작",
  SUCCEEDED: "성공",
  RETRYING: "재시도 예약",
  FAILED: "실패",
  INTERRUPTED: "실행 중단",
  PUSH_UNCONFIGURED: "푸시 설정 미완료",
  PUSH_DELIVERY_FAILED: "외부 푸시 전송 실패",
  ATTEMPTS_EXHAUSTED: "자동 재시도 한도 도달",
  RECORD_NOT_FOUND: "처리할 기록을 찾을 수 없음",
  EXECUTION_FAILED: "작업 처리 오류",
  LEASE_EXPIRED: "실행 권한 만료 후 회수",
  CLAIM_LOST: "다른 실행자가 작업을 회수함",
  SENT: "푸시 전송 완료",
  NOT_SUBSCRIBED: "푸시 구독 없음",
  EXPIRED: "알림 유효 기간 경과",
  ALREADY_SENT: "이미 전송됨",
  COMPLETED: "처리 완료",
  SKIPPED: "현재 상태에 따라 처리 생략",
  RECOVERED: "중단된 실행 복구",
};
const kst = (v: FormDataEntryValue | null) =>
  new Date(String(v) + ":00+09:00").toISOString();
const factTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }) + " KST"
    : "기록 없음";
function MatchHistoryDetails({ history }: { history: MatchHistory }) {
  return (
    <>
      <p>
        자동 재배치:{" "}
        {history.reallocationCount === null
          ? `전체 횟수 미기록 · 확인된 성공 ${history.recordedReallocationCount}회`
          : `${history.reallocationCount}회`}
      </p>
      {history.lastReallocationAt && (
        <p>
          최근 재배치 {factTime(history.lastReallocationAt)}
          <small>
            {history.lastReallocationReason ?? "당시 사유 기록 없음"}
          </small>
        </p>
      )}
      <p>최근 확정 {factTime(history.confirmedAt)}</p>
      <p>최근 매칭 실패 {factTime(history.failedAt)}</p>
      <p>최종 사유: {history.finalReason ?? "당시 사유 기록 없음"}</p>
    </>
  );
}
function MatchFactsDetails({ facts }: { facts: MatchFacts | null }) {
  if (!facts)
    return (
      <details>
        <summary>확정 당시 조건·재배치 이력</summary>
        <p className="muted">
          당시 상세 기록 없음. 현재 프로필·신청 정보와 확정 당시 정보는 다를 수
          있습니다.
        </p>
      </details>
    );
  const constraintLabels: Record<keyof MatchFacts["constraints"], string> = {
    headcount: "인원 4~6명",
    ageGap: "나이 차이 8 이하",
    uniqueParticipants: "참가자 중복 없음",
    scheduleConsent: "동의한 날짜·지역 조합",
    paid: "결제 완료",
    submitted: "유효한 신청",
    profileConsent: "필수 정보 동의",
    unrestricted: "참가 제한 없음",
    noOverlappingAssignment: "겹치는 시간 중복 배정 없음",
    noExcludedRelationship: "차단·신고·기존 비선호 충돌 없음",
  };
  const memberName = (id: string) =>
    facts.members.find((m) => m.userId === id)?.name ?? id;
  return (
    <details>
      <summary>확정 당시 조건·재배치 이력</summary>
      <p className="small">확정 시각 {factTime(facts.confirmedAt)}</p>
      <p className="small">
        당시 일정 {factTime(facts.event.startsAt)} · {facts.event.region}
      </p>
      <p>
        확정 당시 {facts.headcount}명 · 최저 {facts.age.minimum}세 / 최고{" "}
        {facts.age.maximum}세 · 나이 차이 {facts.age.gap}세
      </p>
      <p>
        성별 구성:{" "}
        {facts.genderComposition
          .map((x) => `${x.value} ${x.count}명`)
          .join(" · ")}
      </p>
      <p>
        MBTI 구성:{" "}
        {facts.mbtiComposition
          .map((x) => `${x.value} ${x.count}명`)
          .join(" · ")}
      </p>
      <p>
        2명 이상 공통 관심사:{" "}
        {facts.commonInterests.length
          ? facts.commonInterests
              .map((x) => `${x.interest} (${x.participantCount}명)`)
              .join(" · ")
          : "없음"}
      </p>
      <p>
        이전 만남:{" "}
        {facts.priorMeetings.length
          ? facts.priorMeetings
              .map(
                (pair) =>
                  `${memberName(pair.fromId)} ↔ ${memberName(pair.toId)}`,
              )
              .join(" · ")
          : "확정 시점에 기록된 만남 없음"}
      </p>
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th>확정 당시 참가자</th>
              <th>희망 날짜·지역</th>
              <th>예산·식이</th>
              <th>자동 재배치 이력</th>
            </tr>
          </thead>
          <tbody>
            {facts.members.map((m) => (
              <tr key={m.applicationId}>
                <td>
                  {m.name}
                  <small>
                    {m.age}세 · {m.gender} · {m.mbti.join(" / ") || "미기록"}
                  </small>
                </td>
                <td>
                  날짜 {m.dateSatisfied ? "충족" : "미충족"} · 지역{" "}
                  {m.regionSatisfied ? "충족" : "미충족"}
                  <small>
                    동의한 조합{" "}
                    {m.selectedCombinationSatisfied ? "충족" : "미충족"}
                  </small>
                  <small>
                    희망 성향:{" "}
                    {m.preferenceFulfillment
                      ?.map(
                        (p) => `${p.desire} ${p.satisfied ? "충족" : "미충족"}`,
                      )
                      .join(" · ") ?? "당시 기록 없음"}
                  </small>
                  {m.preferenceFulfillment?.map((p) => (
                    <small key={p.desire}>
                      {p.desire} 사유:{" "}
                      {p.reason?.message ?? "당시 사유 기록 없음"}
                    </small>
                  ))}
                  <small>
                    선택 일정:{" "}
                    {m.selectedEvents
                      .map((e) => `${factTime(e.startsAt)} ${e.region}`)
                      .join(" / ")}
                  </small>
                </td>
                <td>
                  {m.budgets.join(" · ")}
                  <small>
                    {m.foodRestrictions} / 알레르기: {m.allergies}
                  </small>
                </td>
                <td>
                  <MatchHistoryDetails history={m.history} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="evaluation-grid">
        {(
          Object.keys(facts.constraints) as (keyof MatchFacts["constraints"])[]
        ).map((key) => (
          <div key={key}>
            <span>{constraintLabels[key]}</span>
            <strong>{facts.constraints[key] ? "충족" : "미충족"}</strong>
          </div>
        ))}
      </div>
      <p>최종 배치 사유: {facts.finalReason}</p>
      <p className="small muted">
        위 정보는 확정 당시 기록입니다. 선호도 관련 표시는 설계 확정 후
        제공됩니다.
      </p>
    </details>
  );
}
function TableCommunicationDetails({
  table,
}: {
  table: AdminData["tables"][number];
}) {
  const statusLabels: Record<string, string> = {
    PENDING: "처리 대기",
    RUNNING: "처리 중",
    DONE: "처리 완료",
    FAILED: "실패",
    SENT: "푸시 발송 완료",
    NOT_SUBSCRIBED: "푸시 구독 없음",
    UNCONFIGURED: "푸시 설정 필요",
    EXPIRED: "발송 기한 경과",
    CANCELED: "취소",
  };
  const kindLabels: Record<string, string> = {
    REMINDER: "행사 리마인드",
    START: "행사 시작·콘텐츠",
    END: "행사 종료·피드백 안내",
    FEEDBACK_REMINDER: "피드백 리마인드",
    SYSTEM: "시스템 안내",
    CONTENT: "대화 콘텐츠",
    CHAT: "참가자 메시지",
  };
  const memberName = (userId: string) =>
    table.matchFacts?.members.find((m) => m.userId === userId)?.name ??
    table.applications.find((a) => a.userId === userId)?.user.name ??
    userId;
  return (
    <details>
      <summary>단체방·안내 처리 현황</summary>
      <section aria-label="테이블 단체방·안내 처리 현황">
        <h4>단체방 최근 메시지</h4>
        <p className="small muted">최근 20개까지 최신순으로 표시합니다.</p>
        {table.room?.messages.length ? (
          table.room.messages.map((message) => (
            <article key={message.id} className="history-row">
              <div>
                <small>
                  {factTime(message.createdAt)} ·{" "}
                  {kindLabels[message.kind] ?? message.kind}
                  {message.userId && ` · ${memberName(message.userId)}`}
                </small>
                <p style={{ whiteSpace: "pre-wrap" }}>{message.body}</p>
              </div>
            </article>
          ))
        ) : (
          <p className="muted">
            {table.room ? "저장된 메시지가 없습니다." : "단체방 생성 전입니다."}
          </p>
        )}
        <h4>예약된 안내·행사 처리</h4>
        {table.noticeJobs.length ? (
          table.noticeJobs.map((job) => (
            <p className="small" key={job.id}>
              <strong>{kindLabels[job.kind] ?? job.kind}</strong> ·{" "}
              {statusLabels[job.status] ?? job.status}
              <small>예약 {factTime(job.runAt)}</small>
              {job.completedAt && (
                <small>처리 완료 {factTime(job.completedAt)}</small>
              )}
            </p>
          ))
        ) : (
          <p className="muted">연결된 예약 작업이 없습니다.</p>
        )}
        <h4>참가자 안내 발송</h4>
        {table.notices.length ? (
          table.notices.map((notice) => (
            <p className="small" key={notice.id}>
              <strong>{notice.title}</strong> · {memberName(notice.userId)}
              <small>앱 내 안내 생성 {factTime(notice.createdAt)}</small>
              <small>
                푸시 처리:{" "}
                {statusLabels[notice.pushStatus] ?? notice.pushStatus}
              </small>
            </p>
          ))
        ) : (
          <p className="muted">아직 생성된 참가자 안내가 없습니다.</p>
        )}
      </section>
    </details>
  );
}
export default function Admin() {
  const [safetySearch, setSafetySearch] = useState("");
  const [tab, setTab] = useState("dashboard"),
    [scope, setScope] = useState(""),
    [search, setSearch] = useState(""),
    [exceptionStarted, setExceptionStarted] = useState<Record<string, number>>(
      {},
    );
  const { data, error, notice, busy, perform, reload } = useView<AdminData>(
    "/api/view?admin=1" + (scope ? "&event=" + encodeURIComponent(scope) : ""),
  );
  if (!data)
    return (
      <main className="loading">
        <Brand />
        <p>운영 현황을 불러오는 중…</p>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  const ops = ["ADMIN", "OPERATIONS"].includes(data.user.role),
    safety = ["ADMIN", "SAFETY"].includes(data.user.role);
  const apps = data.applications.filter(
    (a): a is OpsApplication => "paymentStatus" in a,
  );
  const visible = apps.filter((a) =>
    [a.user.name, a.id, a.matchStatus, a.paymentStatus].some((s) =>
      s.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  const tabs = [
    ["dashboard", "운영 개요", Activity],
    ...(ops
      ? [
          ["events", "회차·식당", CalendarDays],
          ["applications", "신청·결제", Users],
          ["matching", "매칭·테이블", UtensilsCrossed],
          ["waitlist", "대기자", Users],
          ["content", "콘텐츠", Send],
          ["exceptions", "예외·작업", AlertCircle],
          ["attendance", "참석·피드백", CheckCircle2],
          ["messages", "메시지", Send],
          ["settings", "운영 설정", Settings],
        ]
      : []),
    ...(safety ? [["safety", "안전 관리", ShieldCheck]] : []),
  ] as [string, string, typeof Activity][];
  const currentTitle = tabs.find((t) => t[0] === tab)?.[1] ?? "운영 개요";
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Brand />
        <span className="admin-caption">운영자 워크스페이스</span>
        <nav aria-label="운영 메뉴">
          {tabs.map(([key, title, Icon]) => {
            const I = Icon as typeof Activity;
            return (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => setTab(key)}
              >
                <I size={19} />
                {title}
                {key === "exceptions" &&
                  data.exceptions.some((e) => e.status === "OPEN") && (
                    <b className="nav-count">
                      {
                        data.exceptions.filter((e) => e.status === "OPEN")
                          .length
                      }
                    </b>
                  )}
              </button>
            );
          })}
        </nav>
        <div className="admin-sidebar-bottom">
          <span className="avatar">{data.user.name[0]}</span>
          <div>
            <strong>{data.user.name}</strong>
            <small>{data.user.role}</small>
          </div>
          <button
            className="icon-button"
            aria-label="로그아웃"
            onClick={() => void signOut()}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-top">
          <span>
            WORKSPACE <span className="muted">/ {currentTitle}</span>
          </span>
          <div className="row">
            <span
              className="live-dot"
              style={{
                background: data.automation.online ? undefined : "#a6a09a",
              }}
            />
            <span
              title={
                data.automation.lastRunAt
                  ? `최근 실행 ${new Date(data.automation.lastRunAt).toLocaleString("ko-KR")} · 처리 ${data.automation.processed} · 성공 ${data.automation.succeeded} · 재시도 ${data.automation.retrying} · 실패 ${data.automation.failed} · 중단 ${data.automation.interrupted}`
                  : "아직 자동 실행 기록이 없습니다."
              }
            >
              {data.automation.mode === "scheduler"
                ? {
                    IDLE: "예약 작업 대기",
                    WAITING: "예약 작업 기동·처리 대기",
                    RUNNING: "예약 작업 처리 중",
                    READY: "예약 호출 정상",
                    DELAYED: "예약 작업 처리 지연",
                    ATTENTION: "예약 작업 확인 필요",
                    OFFLINE: "예약 호출 확인 필요",
                  }[data.automation.state]
                : data.automation.online
                  ? "상시 자동 운영 실행 중"
                  : "작업 서버 연결 대기"}
            </span>
            <a href="/app" className="secondary small">
              참가자 앱 <ArrowUpRight size={15} />
            </a>
          </div>
        </header>
        <div className="admin-content">
          <div className="admin-page-title">
            <div>
              <span className="eyebrow">SIKTAK OPERATIONS</span>
              <h1>{currentTitle}</h1>
              <p>정상적인 만남은 자동으로, 도움이 필요한 순간은 세심하게.</p>
            </div>
            <div className="row">
              <select
                aria-label="회차 필터"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="">전체 회차</option>
                {data.events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {date(e.startsAt)} {e.region}
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                aria-label="새로고침"
                onClick={() => void reload()}
              >
                <RefreshCw size={18} />
              </button>
            </div>
          </div>
          {data.demo && (
            <div className="demo-banner">
              시연 환경 · 합성 참가자, 모의 결제·환불, 가상 식당 데이터를
              사용합니다.
            </div>
          )}
          {error && (
            <p className="error banner" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="success banner" role="status">
              {notice}
            </p>
          )}
          {tab === "dashboard" && (
            <>
              <div className="stats-grid">
                {[
                  [
                    "참가 신청",
                    apps.filter((a) => a.applicationStatus !== "DRAFT").length,
                    "건",
                  ],
                  [
                    "모임 확정",
                    apps.filter((a) => a.matchStatus === "CONFIRMED").length,
                    "명",
                  ],
                  [
                    "자동 확정 테이블",
                    data.tables.filter((t) => t.status === "CONFIRMED").length,
                    "개",
                  ],
                  [
                    "확인이 필요한 예외",
                    data.exceptions.filter((e) => e.status === "OPEN").length,
                    "건",
                  ],
                ].map(([label, value, unit], i) => (
                  <section
                    className={`stat-card ${i === 3 ? "accent" : ""}`}
                    key={label}
                  >
                    <span>{label}</span>
                    <strong>
                      {value}
                      <small>{unit}</small>
                    </strong>
                    <span className="stat-foot">
                      {i === 3
                        ? "안전·실패 복구 중심으로 확인"
                        : "선택한 회차의 저장된 기록 기준"}
                    </span>
                  </section>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel">
                  <div className="panel-title">
                    <h2>진행 중인 회차</h2>
                    <button
                      className="text-link"
                      onClick={() => setTab("events")}
                    >
                      회차 관리 <ArrowUpRight size={16} />
                    </button>
                  </div>
                  {data.events.slice(0, 5).map((e) => (
                    <div className="event-admin-row" key={e.id}>
                      <div className="date-box">
                        <strong>
                          {new Date(e.startsAt).toLocaleDateString("ko-KR", {
                            timeZone: "Asia/Seoul",
                            day: "numeric",
                          })}
                        </strong>
                        <span>
                          {new Date(e.startsAt).toLocaleDateString("ko-KR", {
                            timeZone: "Asia/Seoul",
                            month: "short",
                          })}
                        </span>
                      </div>
                      <div className="grow">
                        <strong>{e.title}</strong>
                        <p>
                          {e.region} · {time(e.startsAt)} · 정원 {e.capacity}명
                        </p>
                      </div>
                      <Badge value={e.status} />
                    </div>
                  ))}
                </section>
                <section className="panel">
                  <div className="panel-title">
                    <h2>운영 체크</h2>
                    <span className="live-pill">LIVE</span>
                  </div>
                  {[
                    [
                      "대안 선택 대기",
                      apps.filter(
                        (a) =>
                          ["ALTERNATIVE_OFFERED", "NO_MATCH"].includes(
                            a.matchStatus,
                          ) &&
                          !a.resolution &&
                          a.applicationStatus === "SUBMITTED",
                      ).length,
                    ],
                    [
                      "노쇼 검토 후보",
                      apps.filter((a) => a.attendanceReviewRequired).length,
                    ],
                    [
                      "환불 실패",
                      apps.filter((a) => a.paymentStatus === "REFUND_FAILED")
                        .length,
                    ],
                    [
                      "작업 실패",
                      data.jobs.filter((j) => j.status === "FAILED").length,
                    ],
                    [
                      "미처리 안전 신고",
                      data.reports.filter((r) => r.status === "OPEN").length,
                    ],
                  ].map(([label, n]) => (
                    <div className="check-row" key={label}>
                      <span>{label}</span>
                      <strong>
                        {n}
                        <small> 건</small>
                      </strong>
                    </div>
                  ))}
                  <p className="small muted">
                    참가자의 대안 선택 대기는 정상 상태이며 운영자 승인이
                    필요하지 않습니다.
                  </p>
                </section>
              </div>
              <AdminOperationalSummary summary={data.operationalSummary} />
              <section className="panel">
                <div className="panel-title">
                  <h2>운영 성과</h2>
                  <span className="small muted">
                    {scope ? "선택 회차" : "전체 기록"} · 분자 / 분모 표시
                    <br />
                    {data.period.from
                      ? date(data.period.from)
                      : "기록 없음"} ~ {date(data.period.to)} · 한국 시간
                  </span>
                </div>
                <div className="metrics-grid">
                  {data.metrics.map((m) => (
                    <div className="metric" key={m.label}>
                      <span>{m.label}</span>
                      <strong>
                        {m.value === null
                          ? "—"
                          : `${(m.value * 100).toFixed(1)}%`}
                      </strong>
                      <small>
                        {m.n} / {m.d}
                        {m.d === 0 ? " · 산출 불가" : ""}
                        {"unknown" in m &&
                          !!m.unknown &&
                          ` · 취소 시각 미확인 ${m.unknown}건 제외`}
                      </small>
                      <div className="meter">
                        <i
                          style={{
                            width: `${Math.min(100, (m.value ?? 0) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <div className="metric">
                    <span>운영 시간</span>
                    <strong>{Math.floor(data.operatingSeconds / 60)}분</strong>
                    <small>실제 예외 처리 기록 합계</small>
                  </div>
                </div>
              </section>
            </>
          )}
          {tab === "events" && (
            <>
              <section className="panel">
                <div className="panel-title">
                  <h2>회차 목록</h2>
                  <span className="small muted">모든 시간은 한국 시간</span>
                </div>
                {data.demo && (
                  <div className="row wrap demo-scenario">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void perform("demoScenario", {})}
                    >
                      심사용 시연 회차 만들기
                    </button>
                    <span className="small muted">
                      3일 뒤 저녁 회차와 모의 결제를 마친 합성 참가자 11명을
                      만듭니다. 참가자 계정으로 신청한 뒤 아래 시연 시간 이동의
                      매칭 시각 → 시작 시각 → 종료 시각을 차례로 누르세요.
                    </span>
                  </div>
                )}
                <div className="data-table">
                  <table>
                    <thead>
                      <tr>
                        <th>회차</th>
                        <th>날짜·지역</th>
                        <th>마감 / 매칭</th>
                        <th>식당 재고</th>
                        <th>상태</th>
                        {data.demo && <th>시연 시간 이동</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.events.map((e) => (
                        <tr key={e.id}>
                          <td>
                            <strong>{e.title}</strong>
                            <small>정원 {e.capacity}명</small>
                          </td>
                          <td>
                            {date(e.startsAt)} {time(e.startsAt)}
                            <small>{e.region}</small>
                          </td>
                          <td>
                            {date(e.closesAt)} {time(e.closesAt)}
                            <small>
                              매칭 {date(e.matchAt)} {time(e.matchAt)}
                            </small>
                          </td>
                          <td>
                            {e.venues.map((v) => (
                              <div key={v.id}>
                                {v.name}
                                <small>
                                  {v.capacity}인 × {v.totalTables}테이블 ·{" "}
                                  {v.price.toLocaleString()}원
                                </small>
                              </div>
                            ))}
                          </td>
                          <td>
                            <Badge value={e.status} />
                          </td>
                          {data.demo && (
                            <td>
                              <div className="row wrap">
                                {[
                                  ["MATCH", "매칭 시각"],
                                  ["START", "시작 시각"],
                                  ["END", "종료 시각"],
                                ].map(([phase, label]) => (
                                  <button
                                    key={phase}
                                    className="secondary tiny"
                                    disabled={busy}
                                    onClick={() =>
                                      void perform("demoAdvance", {
                                        eventId: e.id,
                                        phase,
                                      })
                                    }
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <div className="dashboard-grid">
                <section className="panel">
                  <h2>새 회차 만들기</h2>
                  <form
                    className="stack"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const form = e.currentTarget,
                        f = new FormData(form);
                      if (
                        await perform("event", {
                          title: f.get("title"),
                          region: f.get("region"),
                          startsAt: kst(f.get("startsAt")),
                          endsAt: kst(f.get("endsAt")),
                          closesAt: kst(f.get("closesAt")),
                          matchAt: kst(f.get("matchAt")),
                          cancelRefundCutoffAt: kst(f.get("cutoff")),
                          capacity: Number(f.get("capacity")),
                        })
                      )
                        form.reset();
                    }}
                  >
                    <Field label="회차 이름">
                      <input name="title" required />
                    </Field>
                    <div className="form-grid">
                      <Field label="지역">
                        <input name="region" required placeholder="홍대·합정" />
                      </Field>
                      <Field label="정원">
                        <input
                          name="capacity"
                          type="number"
                          min={4}
                          max={300}
                          defaultValue={24}
                        />
                      </Field>
                      {[
                        ["startsAt", "행사 시작"],
                        ["endsAt", "행사 종료"],
                        ["closesAt", "신청 마감"],
                        ["matchAt", "자동 매칭"],
                        ["cutoff", "변심 환불 제한 시작"],
                      ].map(([name, label]) => (
                        <Field key={name} label={label + " (KST)"}>
                          <input name={name} type="datetime-local" required />
                        </Field>
                      ))}
                    </div>
                    <button className="primary" disabled={busy}>
                      <Plus size={17} />
                      회차 생성
                    </button>
                  </form>
                </section>
                <section className="panel">
                  <h2>가상 식당 재고 추가</h2>
                  <form
                    className="stack"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      await perform("venue", {
                        eventId: f.get("eventId"),
                        name: f.get("name"),
                        address: f.get("address"),
                        mapUrl: f.get("mapUrl"),
                        reservationName: f.get("reservationName"),
                        price: Number(f.get("price")),
                        capacity: Number(f.get("capacity")),
                        totalTables: Number(f.get("totalTables")),
                        dietaryNotes: f.get("dietaryNotes"),
                      });
                    }}
                  >
                    <Field label="회차">
                      <select name="eventId">
                        {data.events.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.title} · {e.region}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {[
                      ["name", "식당명"],
                      ["address", "주소"],
                      ["mapUrl", "지도 HTTPS 링크"],
                      ["reservationName", "예약명"],
                      ["dietaryNotes", "식이·알레르기 확인 안내"],
                    ].map(([name, label]) => (
                      <Field key={name} label={label}>
                        <input name={name} required />
                      </Field>
                    ))}
                    <div className="form-grid">
                      <Field label="1인 식비">
                        <input
                          name="price"
                          type="number"
                          min={0}
                          defaultValue={25000}
                        />
                      </Field>
                      <Field label="테이블 수용 인원">
                        <input
                          name="capacity"
                          type="number"
                          min={4}
                          max={6}
                          defaultValue={6}
                        />
                      </Field>
                      <Field label="예약 가능한 테이블 수">
                        <input
                          name="totalTables"
                          type="number"
                          min={1}
                          defaultValue={4}
                        />
                      </Field>
                    </div>
                    <button className="primary" disabled={busy}>
                      재고 저장
                    </button>
                  </form>
                </section>
              </div>
            </>
          )}
          {tab === "applications" && (
            <section className="panel">
              <div className="panel-title">
                <h2>신청·결제·환불 원장</h2>
                <a className="secondary" href="/api/export">
                  <Download size={16} />
                  CSV 내보내기
                </a>
              </div>
              <input
                className="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="이름, 신청 ID, 상태로 검색"
                aria-label="신청 검색"
              />
              <div className="data-table">
                <table>
                  <thead>
                    <tr>
                      <th>참가자</th>
                      <th>희망 일정</th>
                      <th>신청</th>
                      <th>결제</th>
                      <th>매칭</th>
                      <th>거래·환불</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <strong>{a.user.name}</strong>
                          <small>
                            {a.user.profile?.birthYear}년 ·{" "}
                            {a.user.profile?.gender}
                          </small>
                          <details>
                            <summary>프로필·신청</summary>
                            <p>{a.user.profile?.interests.join(" · ")}</p>
                            <p>MBTI: {a.user.profile?.mbti.join(" · ")}</p>
                            <p>
                              본인 성향: {a.user.profile?.traits.join(" · ")}
                            </p>
                            <p>
                              희망 성향:{" "}
                              {a.user.profile?.desiredTraits.join(" · ")}
                            </p>
                            <p>
                              식사 예산: {a.user.profile?.budgets.join(" · ")}
                            </p>
                            <p>식이: {a.user.profile?.foodRestrictions}</p>
                            <p>알레르기: {a.user.profile?.allergies}</p>
                            <p>
                              연락처: {a.user.profile?.contact} · 직업:{" "}
                              {a.user.profile?.occupation}
                            </p>
                            <p>
                              실제 참가 이력:{" "}
                              {
                                apps.filter(
                                  (x) =>
                                    x.userId === a.userId &&
                                    x.attendanceStatus === "ATTENDED",
                                ).length
                              }
                              회
                            </p>
                            <small>{a.id}</small>
                            {a.table &&
                              a.applicationStatus === "SUBMITTED" &&
                              a.attendanceStatus === "SCHEDULED" &&
                              isMeetingDayOrLater(a.table.event.startsAt) &&
                              new Date(a.table.event.endsAt) > new Date() && (
                                <form
                                  onSubmit={async (e) => {
                                    e.preventDefault();
                                    const f = new FormData(e.currentTarget);
                                    await perform("recordLateCancellation", {
                                      applicationId: a.id,
                                      reason: f.get("reason"),
                                    });
                                  }}
                                >
                                  <input
                                    name="reason"
                                    required
                                    maxLength={1000}
                                    aria-label={`${a.user.name} 당일 취소 확인 사유`}
                                  />
                                  <button className="secondary" disabled={busy}>
                                    실제 당일 취소 기록
                                  </button>
                                </form>
                              )}
                            <details>
                              <summary>연결된 이용권 원장</summary>
                              {data.ticketEntries
                                .filter((e) => e.applicationId === a.id)
                                .map((e) => (
                                  <p className="small" key={e.id}>
                                    {e.kind} · {e.units > 0 ? "+" : ""}
                                    {e.units}회 · {date(e.createdAt)}
                                    <br />원 거래: {e.paymentId ?? "별도 부여"}
                                  </p>
                                ))}
                            </details>
                          </details>
                        </td>
                        <td>
                          {a.options.map((o) => (
                            <div key={o.eventId}>
                              {date(o.event.startsAt)}
                              <small>{o.event.region}</small>
                            </div>
                          ))}
                        </td>
                        <td>
                          <Badge value={a.applicationStatus} />
                        </td>
                        <td>
                          <Badge value={a.paymentStatus} />
                        </td>
                        <td>
                          <Badge value={a.matchStatus} />
                          <details>
                            <summary>확정·실패·재배치 기록</summary>
                            <MatchHistoryDetails history={a.matchHistory} />
                          </details>
                        </td>
                        <td>
                          {a.payments.map((p) => (
                            <div key={p.id}>
                              <strong>{p.amount.toLocaleString()}원</strong>{" "}
                              <span className="small muted">
                                {p.method === "TICKET"
                                  ? "기존 이용권"
                                  : "모의 카드"}
                              </span>
                              <small>{p.id}</small>
                              <Badge value={p.status} />
                              {p.refunds.map((r) => (
                                <small key={r.id}>
                                  환불 {r.amount.toLocaleString()}원 ·{" "}
                                  <Badge value={r.status} />
                                  {refundExplanation(r.calculation) &&
                                    ` · ${refundExplanation(r.calculation)}`}
                                </small>
                              ))}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {tab === "waitlist" && (
            <AdminWaitlist
              entries={data.waitlist}
              events={data.events}
              busy={busy}
              perform={perform}
              responseMinutesByEvent={Object.fromEntries(
                data.settings
                  .filter((s) => s.key.startsWith("waitlist:"))
                  .map((s) => [
                    s.key.slice(9),
                    (s.value as { minutes: number }).minutes,
                  ]),
              )}
            />
          )}
          {tab === "content" && (
            <AdminContent
              items={data.contentCatalog}
              busy={busy}
              perform={perform}
            />
          )}
          {tab === "matching" && (
            <>
              <AdminAllocation data={data} reload={reload} />
              <section className="panel">
                <div className="panel-title">
                  <h2>자동 확정 테이블</h2>
                  <a className="secondary" href="/api/export?type=tables">
                    <Download size={16} />
                    결과 CSV
                  </a>
                </div>
                {data.tables.length ? (
                  <div className="table-grid">
                    {data.tables.map((t) => (
                      <article className="table-detail" key={t.id}>
                        <div className="row between">
                          <span className="eyebrow">{t.event.region}</span>
                          <Badge value={t.status} />
                        </div>
                        <h3>
                          {date(t.event.startsAt)} · {time(t.event.startsAt)}
                        </h3>
                        <div className="row wrap">
                          {t.applications
                            .filter(
                              (a) =>
                                a.applicationStatus === "SUBMITTED" &&
                                a.matchStatus === "CONFIRMED",
                            )
                            .map((a) => (
                              <span className="name-chip" key={a.id}>
                                {a.user.name}
                              </span>
                            ))}
                        </div>
                        <p>{t.explanation}</p>
                        <p className="muted">
                          {t.venueSlot?.name ?? "식당 확인 필요"} ·{" "}
                          {t.room ? "단체방 생성 완료" : "단체방 대기"}
                        </p>
                        <MatchFactsDetails facts={t.matchFacts} />
                        <TableCommunicationDetails table={t} />
                      </article>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title="아직 확정된 테이블이 없습니다"
                    body="예약된 매칭 시각이 되면 자동으로 생성됩니다."
                  />
                )}
              </section>
              <section className="panel">
                <h2>매칭 실행 이력</h2>
                {data.runs.map((r) => (
                  <div className="history-row" key={r.id}>
                    <div>
                      <strong>
                        {date(r.createdAt)} {time(r.createdAt)}
                      </strong>
                      <small>
                        {r.version} · {r.id}
                      </small>
                      <details>
                        <summary>결과 보기</summary>
                        <pre>{JSON.stringify(r.result, null, 2)}</pre>
                      </details>
                    </div>
                    <Badge value={r.status} />
                  </div>
                ))}
              </section>
            </>
          )}
          {tab === "exceptions" && (
            <>
              <section className="panel">
                <h2>예외 처리함</h2>
                {data.exceptions.length ? (
                  data.exceptions.map((ex) => (
                    <article className="exception" key={ex.id}>
                      <div className="row between">
                        <strong>
                          {ex.kind} · {ex.reason}
                        </strong>
                        <Badge value={ex.status} />
                      </div>
                      <small className="muted">
                        {ex.objectId} · {date(ex.createdAt)}{" "}
                        {time(ex.createdAt)}
                      </small>
                      {ex.kind === "PRIVACY" &&
                        ["OPEN", "REVIEWING"].includes(ex.status) && (
                          <form
                            className="stack"
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const f = new FormData(e.currentTarget);
                              await perform("privacyReview", {
                                exceptionId: ex.id,
                                note: f.get("note"),
                                decision: f.get("decision"),
                              });
                            }}
                          >
                            <p>
                              접수·검토 상태만 관리합니다. 삭제 완료로 표시하지
                              않습니다.
                            </p>
                            <select name="decision">
                              <option value="REVIEWING">
                                검토 중 / 추가 조치 안내
                              </option>
                              <option value="REJECTED">
                                처리 불가 사유 안내
                              </option>
                            </select>
                            <textarea
                              name="note"
                              required
                              maxLength={1000}
                              aria-label="개인정보 요청 검토 안내"
                            />
                            <button className="primary" disabled={busy}>
                              검토 안내 저장
                            </button>
                          </form>
                        )}
                      {ex.status === "OPEN" && ex.kind !== "PRIVACY" && (
                        <>
                          {["VENUE", "DATA", "MATCHING", "CONDITION"].includes(
                            ex.kind,
                          ) && (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                void perform("retryMatch", {
                                  exceptionId: ex.id,
                                })
                              }
                            >
                              보완 후 매칭 재시도
                            </button>
                          )}
                          {!exceptionStarted[ex.id] ? (
                            <button
                              className="secondary"
                              onClick={() =>
                                setExceptionStarted((x) => ({
                                  ...x,
                                  [ex.id]: Date.now(),
                                }))
                              }
                            >
                              처리 시작
                            </button>
                          ) : (
                            <form
                              className="row"
                              onSubmit={async (e) => {
                                e.preventDefault();
                                const f = new FormData(e.currentTarget);
                                await perform("resolveException", {
                                  exceptionId: ex.id,
                                  note: f.get("note"),
                                  seconds: Math.floor(
                                    (Date.now() - exceptionStarted[ex.id]) /
                                      1000,
                                  ),
                                });
                              }}
                            >
                              <input
                                name="note"
                                required
                                placeholder="원인과 실제 조치 내용을 기록하세요"
                              />
                              <button className="primary" disabled={busy}>
                                해결 기록
                              </button>
                            </form>
                          )}
                        </>
                      )}
                    </article>
                  ))
                ) : (
                  <Empty
                    title="모든 흐름이 순조로워요"
                    body="자동 처리가 어려운 문제만 이곳에 표시됩니다."
                  />
                )}
              </section>
              <section className="panel">
                <h2>서버 작업·재시도</h2>
                <p className="muted">
                  {data.automation.mode === "scheduler"
                    ? "외부 예약 호출"
                    : "상시 작업 서버"}
                  {data.automation.lastRunAt
                    ? ` · 최근 실행 ${new Date(data.automation.lastRunAt).toLocaleString("ko-KR")}`
                    : " · 아직 실행 기록이 없습니다."}
                </p>
                {data.automation.mode === "scheduler" && (
                  <p className="muted">
                    {data.automation.lastDispatchCheckAt
                      ? `예약 확인 ${new Date(data.automation.lastDispatchCheckAt).toLocaleString("ko-KR")} · ${data.automation.hasDueJobs ? "처리할 작업 있음" : "실행 시각이 된 작업 없음"}`
                      : "예약 확인 기록이 없습니다."}
                    {data.automation.oldestDueAt &&
                      ` · 가장 이른 처리 예정 ${new Date(data.automation.oldestDueAt).toLocaleString("ko-KR")}`}
                  </p>
                )}
                {data.automation.mode === "scheduler" && (
                  <p className="muted">
                    최근 처리 {data.automation.processed} · 성공{" "}
                    {data.automation.succeeded} · 재시도{" "}
                    {data.automation.retrying} · 실패 {data.automation.failed} ·
                    중단 {data.automation.interrupted}
                    {data.automation.interrupted > 0 &&
                      " · 중단된 작업은 5분 후 자동 회수됩니다."}
                  </p>
                )}
                <div className="data-table">
                  <table>
                    <thead>
                      <tr>
                        <th>작업</th>
                        <th>예약 시각</th>
                        <th>상태</th>
                        <th>시도</th>
                        <th>마지막 오류 / 조치</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.jobs.map((j) => (
                        <tr key={j.id}>
                          <td>
                            {j.kind}
                            <small>{j.key}</small>
                          </td>
                          <td>
                            {date(j.runAt)} {time(j.runAt)}
                          </td>
                          <td>
                            <Badge value={j.status} />
                          </td>
                          <td>{j.attempts}</td>
                          <td>
                            {j.lastError}
                            <details>
                              <summary>시도별 실행 기록</summary>
                              {j.attemptHistory.length ? (
                                j.attemptHistory.map((entry) => (
                                  <p className="small" key={entry.id}>
                                    {factTime(entry.occurredAt)} ·{" "}
                                    {entry.attempt}차 ·{" "}
                                    {jobHistoryLabels[entry.outcome] ??
                                      entry.outcome}
                                    {entry.result && (
                                      <small>
                                        결과:{" "}
                                        {jobHistoryLabels[entry.result] ??
                                          entry.result}
                                      </small>
                                    )}
                                    {entry.reason && (
                                      <small>
                                        사유:{" "}
                                        {jobHistoryLabels[entry.reason] ??
                                          entry.reason}
                                      </small>
                                    )}
                                    {entry.nextRunAt && (
                                      <small>
                                        다음 실행: {factTime(entry.nextRunAt)}
                                      </small>
                                    )}
                                  </p>
                                ))
                              ) : (
                                <p className="muted">이전 시도별 기록 없음</p>
                              )}
                            </details>
                            {j.status === "FAILED" && (
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void perform("retryJob", { jobId: j.id })
                                }
                              >
                                실패 작업 재시도
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          {tab === "attendance" && (
            <section className="panel">
              <h2>참석·피드백 확인</h2>
              <p className="muted">
                미체크인은 노쇼 후보입니다. 실제 참석 여부를 확인한 뒤
                기록하세요.
              </p>
              <div className="data-table">
                <table>
                  <thead>
                    <tr>
                      <th>참가자</th>
                      <th>참석 상태</th>
                      <th>피드백</th>
                      <th>검토</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apps
                      .filter((a) => a.matchStatus === "CONFIRMED")
                      .map((a) => (
                        <tr key={a.id}>
                          <td>{a.user.name}</td>
                          <td>
                            <Badge value={a.attendanceStatus} />
                          </td>
                          <td>
                            {a.feedback ? (
                              <span>
                                분위기 {a.feedback.atmosphere} · 대화{" "}
                                {a.feedback.conversation} · 식당{" "}
                                {a.feedback.venue}
                                <small>
                                  재참여{" "}
                                  {a.feedback.returnIntent ? "희망" : "미정"} ·
                                  추천 {a.feedback.recommend}/10
                                </small>
                                {a.feedback.comment}
                              </span>
                            ) : (
                              "미제출"
                            )}
                          </td>
                          <td>
                            {a.attendanceReviewRequired ? (
                              <form
                                className="stack"
                                onSubmit={async (e) => {
                                  e.preventDefault();
                                  const f = new FormData(e.currentTarget);
                                  await perform("attendance", {
                                    applicationId: a.id,
                                    status: f.get("status"),
                                    reason: f.get("reason"),
                                  });
                                }}
                              >
                                <select name="status">
                                  <option value="ATTENDED">
                                    실제 참석 확인
                                  </option>
                                  <option value="NO_SHOW">
                                    실제 불참 확인
                                  </option>
                                </select>
                                <input
                                  name="reason"
                                  required
                                  placeholder="확인 근거"
                                />
                                <button
                                  className="primary tiny"
                                  disabled={busy}
                                >
                                  검토 결과 저장
                                </button>
                              </form>
                            ) : (
                              <span className="muted">검토 대상 아님</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {tab === "safety" && (
            <section className="panel">
              <h2>개인별 비공개 제외 관계</h2>
              <p className="muted">
                저장된 비선호·차단·신고를 검토합니다. 활성 관계는 두 사람의 다음
                매칭을 분리합니다.
              </p>
              <Field label="참가자 이름 또는 ID로 관계 찾기">
                <input
                  value={safetySearch}
                  onChange={(e) => setSafetySearch(e.target.value)}
                  placeholder="신청자 또는 상대방 검색"
                />
              </Field>
              <div className="data-table">
                <table>
                  <thead>
                    <tr>
                      <th>신청자 → 상대방</th>
                      <th>종류</th>
                      <th>현재 제외</th>
                      <th>기록 시각·출처</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.safetyRelationships
                      .filter((r) =>
                        [r.fromName, r.toName, r.fromId, r.toId].some((v) =>
                          v.toLowerCase().includes(safetySearch.toLowerCase()),
                        ),
                      )
                      .map((r) => (
                        <tr key={r.id}>
                          <td>
                            {r.fromName} → {r.toName}
                            <small>
                              {r.fromId} → {r.toId}
                            </small>
                          </td>
                          <td>{relationshipLabels[r.kind] ?? r.kind}</td>
                          <td>{r.active ? "분리 적용" : "분리 해제"}</td>
                          <td>
                            {factTime(r.createdAt)}
                            <small>{r.sourceId ?? "출처 기록 없음"}</small>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!data.safetyRelationships.length && (
                <p className="muted">저장된 제외 관계가 없습니다.</p>
              )}
              <h2>비공개 신고 검토</h2>
              <p className="muted">
                접수 즉시 향후 매칭에서 분리됩니다. 제재는 검토 결과로
                결정하세요.
              </p>
              {data.reports.length ? (
                data.reports.map((r) => (
                  <article className="exception" key={r.id}>
                    <div className="row between">
                      <h3>신고 {r.id.slice(-8)}</h3>
                      <Badge value={r.status} />
                    </div>
                    <p>{r.reason}</p>
                    <p>{r.evidence}</p>
                    <small>
                      신고자 {r.reporterId} · 대상 {r.targetId}
                    </small>
                    {r.status !== "REVIEWED" && !exceptionStarted[r.id] && (
                      <button
                        className="secondary"
                        onClick={() =>
                          setExceptionStarted((x) => ({
                            ...x,
                            [r.id]: Date.now(),
                          }))
                        }
                      >
                        검토 시작
                      </button>
                    )}
                    {r.status !== "REVIEWED" && exceptionStarted[r.id] && (
                      <form
                        className="row wrap"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          await perform("reviewReport", {
                            reportId: r.id,
                            action: f.get("action"),
                            note: f.get("note"),
                            seconds: Math.floor(
                              (Date.now() - exceptionStarted[r.id]) / 1000,
                            ),
                          });
                        }}
                      >
                        <select name="action">
                          <option value="WARNING">경고</option>
                          <option value="RESTRICTED">참가 제한</option>
                          <option value="BANNED">영구 제한</option>
                          <option value="DISMISS">
                            신고 기각·보호 분리 해제
                          </option>
                        </select>
                        <input
                          name="note"
                          required
                          placeholder="검토 근거와 처리 내용"
                        />
                        <button className="primary" disabled={busy}>
                          검토 저장
                        </button>
                      </form>
                    )}
                  </article>
                ))
              ) : (
                <Empty
                  title="접수된 신고가 없습니다"
                  body="안전 관련 신고와 조치를 이곳에서 관리합니다."
                />
              )}
            </section>
          )}
          {tab === "messages" && (
            <section className="panel">
              <h2>안내·리마인드 발송 이력</h2>
              <div className="data-table">
                <table>
                  <thead>
                    <tr>
                      <th>안내</th>
                      <th>수신자</th>
                      <th>앱 내 저장</th>
                      <th>푸시</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.notifications.map((n) => (
                      <tr key={n.id}>
                        <td>
                          <strong>{n.title}</strong>
                          <p>{n.body}</p>
                        </td>
                        <td>{n.userId}</td>
                        <td>
                          {date(n.createdAt)} {time(n.createdAt)}
                        </td>
                        <td>
                          <Badge value={n.pushStatus} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {tab === "settings" && (
            <>
              <AdminMatchingPolicy />
              <div className="dashboard-grid">
                <section className="panel">
                  <h2>자동 작업 재시도</h2>
                  <form
                    className="stack"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      await perform("setting", {
                        key: "automation",
                        value: {
                          retrySeconds: Number(f.get("retrySeconds")),
                          maxAttempts: Number(f.get("maxAttempts")),
                        },
                      });
                    }}
                  >
                    <Field label="첫 재시도 대기 (초)">
                      <input
                        name="retrySeconds"
                        type="number"
                        min={1}
                        max={3600}
                        defaultValue={Number(
                          (
                            data.settings.find((s) => s.key === "automation")
                              ?.value as Record<string, number> | undefined
                          )?.retrySeconds ?? 30,
                        )}
                      />
                    </Field>
                    <Field label="최대 시도 수">
                      <input
                        name="maxAttempts"
                        type="number"
                        min={1}
                        max={10}
                        defaultValue={Number(
                          (
                            data.settings.find((s) => s.key === "automation")
                              ?.value as Record<string, number> | undefined
                          )?.maxAttempts ?? 3,
                        )}
                      />
                    </Field>
                    <p className="small muted">
                      재시도 간격은 시도마다 2배로 늘어나며 반복 실패는 예외로
                      전환됩니다.
                    </p>
                    <button className="primary" disabled={busy}>
                      설정 저장
                    </button>
                  </form>
                </section>
                <section className="panel">
                  <h2>자동 안내 템플릿</h2>
                  <form
                    className="stack"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      await perform("setting", {
                        key: "notificationTemplates",
                        value: {
                          curation: f.get("curation"),
                          reminder: f.get("reminder"),
                          alternative: f.get("alternative"),
                        },
                      });
                    }}
                  >
                    {(
                      [
                        ["curation", "확정·큐레이션 안내"],
                        ["reminder", "행사 1일 전 안내"],
                        ["alternative", "대체 일정 안내"],
                      ] as const
                    ).map(([key, label]) => (
                      <Field key={key} label={label}>
                        <textarea
                          rows={3}
                          name={key}
                          required
                          maxLength={1000}
                          defaultValue={
                            notificationTemplates(
                              data.settings.find(
                                (s) => s.key === "notificationTemplates",
                              )?.value,
                            )[key]
                          }
                        />
                      </Field>
                    ))}
                    <p className="small muted">
                      큐레이션에는 조합·모임 정보가, 리마인드에는
                      시간·장소·예약·취소·노쇼 안내가, 대체 일정에는 사유·모집
                      중 일정·보관·환불 안내가 자동으로 추가됩니다. 저장 후 새로
                      생성하는 안내부터 반영되며 이미 생성된 안내는 바뀌지
                      않습니다.
                    </p>
                    <button className="primary" disabled={busy}>
                      템플릿 저장
                    </button>
                  </form>
                </section>
              </div>
              <section className="panel">
                <h2>주요 변경 이력</h2>
                <div className="data-table">
                  <table>
                    <thead>
                      <tr>
                        <th>시각</th>
                        <th>주체</th>
                        <th>변경</th>
                        <th>대상</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.audits.map((a) => (
                        <tr key={a.id}>
                          <td>
                            {date(a.createdAt)} {time(a.createdAt)}
                          </td>
                          <td>{a.actorId}</td>
                          <td>{a.action}</td>
                          <td>{a.objectId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
