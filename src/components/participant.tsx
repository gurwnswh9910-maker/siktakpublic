"use client";
import { ParticipantWaitlist } from "./participant-waitlist";
import { PreferenceExplanation } from "./preference-explanation";
import { PRIVACY_REVIEW_ORGANIZATION } from "@/domain/privacy-policy";
import {
  ticketProducts,
  ticketOffer,
  savedTicketOffer,
  ticketDescription,
} from "@/domain/ticket-products";
import { useState, useEffect } from "react";
import {
  ArrowRight,
  ArrowLeft,
  CalendarDays,
  MapPin,
  Bell,
  Home,
  MessageCircle,
  UserRound,
  Check,
  Clock,
  ChevronRight,
  LogOut,
  ShieldCheck,
  UtensilsCrossed,
  Plus,
} from "lucide-react";
import type { ParticipantData } from "@/server/views";
import {
  cancellationCutoff,
  cancellationNotice,
} from "@/domain/cancellation-policy";
import {
  Brand,
  BrandPanel,
  Badge,
  Empty,
  Field,
  Chips,
  date,
  time,
  useView,
  signOut,
  refundExplanation,
} from "./shared";
type App = ParticipantData["applications"][number];
export default function Participant() {
  const { data, error, notice, busy, perform, setNotice } =
    useView<ParticipantData>("/api/view");
  const [tab, setTab] = useState("home"),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  useEffect(() => {
    const t = new URLSearchParams(location.search).get("tab");
    if (t) setTab(t);
    const applicationId = new URLSearchParams(location.search).get(
      "application",
    );
    if (applicationId) setSelected(applicationId);
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js");
  }, []);
  if (!data)
    return (
      <main className="loading">
        <Brand />
        <p role="status">식탁을 준비하고 있어요…</p>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  const current =
    data.applications.find((a) => a.id === selected) ??
    data.applications.find((a) => a.applicationStatus === "SUBMITTED") ??
    data.applications[0];
  const active = data.applications.filter(
    (a) =>
      a.applicationStatus === "SUBMITTED" &&
      (!a.table || new Date(a.table.event.endsAt) > new Date()),
  );
  const go = (next: string, a?: App) => {
    if (a) setSelected(a.id);
    setTab(next);
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const start = async () => {
    const id = crypto.randomUUID();
    if (await perform("draft", { requestId: id })) {
      setDraft(id);
      setSelectedEvents([]);
      go(data.user.profile ? "apply" : "profile");
    }
  };
  const title: Record<string, string> = {
    home: "오늘의 우연",
    events: "다가오는 식탁",
    apply: "나의 식탁 신청",
    profile: "나를 소개해요",
    detail: "나의 모임",
    chat: "함께 나누는 이야기",
    feedback: "오늘의 식탁",
    mine: "나의 기록",
    notifications: "도착한 소식",
    safety: "안전한 만남",
  };
  async function push() {
    try {
      if (!data?.pushPublicKey) {
        setNotice(
          "앱 내 알림은 이용할 수 있어요. 이 환경의 푸시는 아직 설정되지 않았어요.",
        );
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotice(
          "푸시가 허용되지 않았어요. 앱 안에서 소식을 확인할 수 있어요.",
        );
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(
        atob(data.pushPublicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await perform("subscribe", sub.toJSON());
    } catch {
      setNotice(
        "이 브라우저에서는 푸시를 연결하지 못했어요. 지원되는 브라우저 또는 설치된 앱을 이용해 주세요.",
      );
    }
  }
  return (
    <main className="site-shell">
      <BrandPanel />
      <section className="phone">
        <header className="app-header">
          <button className="text-button" onClick={() => go("home")}>
            <Brand />
          </button>
          <button
            aria-label="알림"
            className="icon-button"
            onClick={() => {
              go("notifications");
              void perform("readNotifications", {});
            }}
          >
            <Bell size={21} />
            {data.notifications.some((n) => !n.readAt) && (
              <i className="unread-dot" />
            )}
          </button>
        </header>
        <div className="phone-content">
          {tab !== "home" && (
            <div className="page-heading">
              <button
                className="icon-button"
                aria-label="홈으로"
                onClick={() => go("home")}
              >
                <ArrowLeft size={19} />
              </button>
              <h1>{title[tab]}</h1>
            </div>
          )}
          {error && (
            <div role="alert" className="error banner">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="success banner">
              {notice}
            </div>
          )}
          {tab === "home" && (
            <>
              <div className="greeting">
                <span className="eyebrow">A TABLE FOR YOU</span>
                <h1>
                  {data.user.name}님,
                  <br />
                  오늘도 새로운 만남을.
                </h1>
                <p>좋은 대화는, 좋은 식탁에서 시작되니까.</p>
              </div>
              {active.length > 0 && (
                <section className="status-card">
                  <div className="row between">
                    <span className="eyebrow">나의 다음 식탁</span>
                  </div>
                  <div className="row wrap" aria-label="신청·결제·매칭 상태">
                    <Badge value={active[0].applicationStatus} />
                    <Badge value={active[0].paymentStatus} />
                    <Badge value={active[0].matchStatus} />
                  </div>
                  <h2>
                    {active[0].table
                      ? active[0].table.event.title
                      : active[0].paymentStatus === "PAID"
                        ? "어울리는 사람들을 찾고 있어요"
                        : "참가 준비를 마무리해요"}
                  </h2>
                  <p>
                    {active[0].reason ??
                      "신청·결제 상태와 다음 안내를 확인해 주세요."}
                  </p>
                  <NoticeSchedule notice={active[0].nextNotice} />
                  <button
                    onClick={() => go("detail", active[0])}
                    className="text-link"
                  >
                    진행 상황 확인하기 <ArrowRight size={16} />
                  </button>
                </section>
              )}
              <section className="hero">
                <div className="hero-top">
                  <span>우연한 식탁</span>
                  <span>4–6인 소셜다이닝</span>
                </div>
                <div className="hero-plates" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <span>
                    <UtensilsCrossed size={40} />
                  </span>
                </div>
                <div className="hero-copy">
                  <span className="eyebrow">낯설지만, 어쩐지 편안한</span>
                  <h2>
                    우리, 저녁 한 끼<br />
                    같이할까요?
                  </h2>
                  <button onClick={() => go("events")}>
                    이번 식탁 둘러보기 <ArrowRight size={18} />
                  </button>
                </div>
              </section>
              <div className="section-heading">
                <h2>다가오는 식탁</h2>
                <button
                  className="text-button muted"
                  onClick={() => go("events")}
                >
                  전체 보기 <ChevronRight size={16} />
                </button>
              </div>
              {data.events.slice(0, 2).map((e, i) => (
                <EventCard key={e.id} event={e} index={i} onClick={start} />
              ))}
              <div className="promise">
                <ShieldCheck size={23} />
                <div>
                  <strong>편안하게, 서로를 존중하며</strong>
                  <p>
                    비공개 피드백과 신고 기능으로
                    <br />
                    안전한 다음 만남을 함께 만들어요.
                  </p>
                </div>
              </div>
            </>
          )}
          {tab === "events" && (
            <>
              <p className="page-intro">
                가능한 날짜와 지역을 골라주세요.
                <br />
                나와 맞는 4–6명의 식탁을 준비할게요.
              </p>
              {data.events.length ? (
                data.events.map((e, i) => (
                  <EventCard key={e.id} event={e} index={i} onClick={start} />
                ))
              ) : (
                <Empty
                  title="새로운 식탁을 준비 중이에요"
                  body="다음 모집 소식을 알림으로 전해드릴게요."
                />
              )}
            </>
          )}
          {tab === "profile" && (
            <ProfileForm
              key={data.user.id}
              data={data}
              busy={busy}
              save={async (p) => {
                if (await perform("profile", p)) go(draft ? "apply" : "mine");
              }}
            />
          )}
          {tab === "apply" && (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                if (
                  await perform("apply", {
                    requestId: draft,
                    eventIds: f.getAll("eventIds"),
                    ticketType: f.get("ticketType"),
                    consent: f.get("consent") === "on",
                  })
                ) {
                  setSelected(draft);
                  setDraft("");
                  go("detail");
                }
              }}
            >
              <div className="steps">
                <b>01 일정</b>
                <span>02 참가권</span>
                <span>03 매칭</span>
              </div>
              <h2>어느 저녁이 좋으세요?</h2>
              <p className="muted">
                가능한 날짜·지역을 모두 선택해 주세요.
                <br />
                선택한 일정 중 한 번의 모임에 배정돼요.
              </p>
              {data.events.map((e) => (
                <label className="option-card" key={e.id}>
                  <input
                    type="checkbox"
                    name="eventIds"
                    value={e.id}
                    checked={selectedEvents.includes(e.id)}
                    onChange={(change) =>
                      setSelectedEvents((ids) =>
                        change.target.checked
                          ? [...ids, e.id]
                          : ids.filter((id) => id !== e.id),
                      )
                    }
                  />
                  <span>
                    <strong>
                      {date(e.startsAt)} · {time(e.startsAt)}
                    </strong>
                    <small>
                      {e.region} · 마감 {date(e.closesAt)} {time(e.closesAt)}
                    </small>
                  </span>
                </label>
              ))}
              <h2>참가권을 선택해 주세요</h2>
              <p className="small muted">
                멤버십 가격과 이용 횟수는 시연용 임시 기준이에요.
              </p>
              {[
                ...ticketProducts.map((p) => [
                  p.code,
                  p.name,
                  ticketDescription(ticketOffer(p.code)),
                ]),
                [
                  "EXISTING",
                  "보유 이용권 사용",
                  `사용 가능 ${data.ticketBalance}회`,
                ],
              ].map(([v, label, price], i) => (
                <label className="option-card" key={v}>
                  <input
                    type="radio"
                    name="ticketType"
                    value={v}
                    defaultChecked={i === 0}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{price}</small>
                  </span>
                </label>
              ))}
              <Policy
                cutoff={cancellationCutoff({
                  options: data.events
                    .filter((event) => selectedEvents.includes(event.id))
                    .map((event) => ({ event })),
                })}
              />
              <label className="check-label">
                <input type="checkbox" name="consent" required />
                운영 정책과 개인정보 이용 안내를 확인하고 동의합니다.
              </label>
              <button className="primary full" disabled={busy || !draft}>
                신청하고 결제하기 <ArrowRight size={18} />
              </button>
            </form>
          )}
          {tab === "detail" &&
            (current ? (
              <>
                <div className="row wrap">
                  <Badge value={current.applicationStatus} />
                  <Badge value={current.paymentStatus} />
                  <Badge value={current.matchStatus} />
                </div>
                <h2 className="detail-title">
                  {current.table?.event.title ?? "나의 다음 식탁"}
                </h2>
                <p className="muted">
                  {current.reason ??
                    "신청이 완료되었어요. 참가 준비를 확인해 주세요."}
                </p>
                {current.options.map((o) => (
                  <div className="info-row" key={o.eventId}>
                    <CalendarDays size={18} />
                    <span>
                      {date(o.event.startsAt)} {time(o.event.startsAt)}
                      <small>
                        {o.event.region} · 매칭 {date(o.event.matchAt)}{" "}
                        {time(o.event.matchAt)}
                      </small>
                    </span>
                  </div>
                ))}
                <NoticeSchedule notice={current.nextNotice} />
                <ParticipantWaitlist
                  application={current}
                  busy={busy}
                  perform={perform}
                />
                <p className="small muted">
                  {cancellationNotice(current.cancellationCutoffAt)}
                </p>
                {current.payments.some(
                  (payment) => payment.refunds.length > 0,
                ) && (
                  <section className="card stack">
                    <h3>모의 환불 내역</h3>
                    {current.payments.flatMap((payment) =>
                      payment.refunds.map((refund) => (
                        <div key={refund.id}>
                          <strong>{refund.amount.toLocaleString()}원</strong>{" "}
                          <Badge value={refund.status} />
                          <p className="small muted">
                            원 결제 {payment.amount.toLocaleString()}원
                            {refundExplanation(refund.calculation) &&
                              ` · ${refundExplanation(refund.calculation)}`}
                          </p>
                        </div>
                      )),
                    )}
                    <p className="small muted">
                      실제 금전 거래는 발생하지 않아요.
                    </p>
                  </section>
                )}
                {["PENDING", "FAILED"].includes(current.paymentStatus) &&
                  current.applicationStatus === "SUBMITTED" && (
                    <div className="card stack">
                      <h3>참가권 결제</h3>
                      <p>
                        {ticketDescription(
                          savedTicketOffer(
                            current.ticketType,
                            current.ticketOffer,
                          ),
                        )}
                      </p>
                      <div className="demo-note">
                        실제 금전 거래가 없는 모의 결제예요. 식비는 현장에서
                        각자 계산해요.
                        {current.ticketType.startsWith("MEMBERSHIP_") &&
                          " 멤버십 가격과 이용 횟수는 시연용 임시 기준이에요."}
                      </div>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void perform("pay", {
                            applicationId: current.id,
                            requestId: crypto.randomUUID(),
                          })
                        }
                      >
                        모의 결제 완료하기
                      </button>
                      {data.demo && (
                        <button
                          className="text-button muted"
                          disabled={busy}
                          onClick={() =>
                            void perform("pay", {
                              applicationId: current.id,
                              requestId: crypto.randomUUID(),
                              simulateFailure: true,
                            })
                          }
                        >
                          결제 실패 시나리오 확인
                        </button>
                      )}
                    </div>
                  )}
                {["ALTERNATIVE_OFFERED", "NO_MATCH", "EXCEPTION"].includes(
                  current.matchStatus,
                ) &&
                  !current.resolution &&
                  current.applicationStatus === "SUBMITTED" && (
                    <section className="card stack">
                      <h3>다음 만남은 어떻게 할까요?</h3>
                      <p>다른 일정으로 옮겨도 기존 결제는 유지돼요.</p>
                      {current.alternativeEvents
                        .filter(
                          (e) =>
                            !["INELIGIBLE", "UNAVAILABLE"].includes(e.status),
                        )
                        .map((e) => (
                          <button
                            disabled={busy}
                            key={e.id}
                            className="option-card"
                            onClick={() =>
                              void perform("resolve", {
                                applicationId: current.id,
                                choice: "TRANSFER",
                                eventId: e.id,
                              })
                            }
                          >
                            <span>
                              <strong>
                                {date(e.startsAt)} · {e.region}
                              </strong>
                              <small>{e.reason}</small>
                              <small>
                                {e.status === "FEASIBLE"
                                  ? "동의하고 이 일정으로 이동"
                                  : "미확정임을 확인하고 대기 신청으로 이동"}
                              </small>
                            </span>
                            <ChevronRight size={18} />
                          </button>
                        ))}
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void perform("resolve", {
                            applicationId: current.id,
                            choice: "KEEP",
                          })
                        }
                      >
                        이용권 보관하기
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void perform("resolve", {
                            applicationId: current.id,
                            choice: "REFUND",
                          })
                        }
                      >
                        {current.ticketType === "EXISTING"
                          ? "원래 이용권으로 돌려받기"
                          : "모의 환불 요청하기"}
                      </button>
                      {current.ticketType === "TRIPLE" && (
                        <p className="small muted">
                          시연 환불은 1회당 5,000원으로 계산해요. 이 신청의
                          1회와 유효한 미사용 잔여분만 환불하며, 다른 신청에
                          사용한 이용권은 유지해요. 실제 금전 거래는 없어요.
                        </p>
                      )}
                    </section>
                  )}
                {current.table && (
                  <>
                    <PreferenceExplanation
                      items={current.table.preferenceFulfillment}
                    />
                    <section className="venue-card">
                      <span className="eyebrow">OUR TABLE</span>
                      <h2>{current.table.venue?.name}</h2>
                      <p>{current.table.venue?.address}</p>
                      <div className="venue-details">
                        <span>
                          예약명 <b>{current.table.venue?.reservationName}</b>
                        </span>
                        <span>
                          식비{" "}
                          <b>
                            약 {current.table.venue?.price.toLocaleString()}원
                          </b>
                        </span>
                        <span>
                          모임 시각 <b>{time(current.table.event.startsAt)}</b>
                        </span>
                      </div>
                      <p className="small">
                        {current.table.venue?.dietaryNotes}
                      </p>
                      <a
                        href={current.table.venue?.mapUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-link"
                      >
                        <MapPin size={16} />
                        주변 지도 보기
                      </a>
                      <div className="demo-note">
                        가상 식당·모의 예약입니다.
                      </div>
                    </section>
                    <section className="card">
                      <h3>함께할 사람들</h3>
                      <div className="members">
                        {current.table.members.map((m, i) => (
                          <div key={m.id}>
                            <span className={`avatar tone-${i % 4}`}>
                              {m.name[0]}
                            </span>
                            <strong>{m.name}</strong>
                            <small>{m.interests.slice(0, 2).join(" · ")}</small>
                          </div>
                        ))}
                      </div>
                      <p className="muted small">{current.table.explanation}</p>
                    </section>
                    <button className="primary full" onClick={() => go("chat")}>
                      우리 단체방으로 <MessageCircle size={18} />
                    </button>
                    <div className="row">
                      <button
                        className="secondary grow"
                        disabled={
                          busy || current.attendanceStatus === "ATTENDED"
                        }
                        onClick={() =>
                          void perform("checkin", { applicationId: current.id })
                        }
                      >
                        {current.attendanceStatus === "ATTENDED"
                          ? "참석 완료"
                          : "체크인하기"}
                      </button>
                      <button
                        className="secondary grow"
                        disabled={
                          current.attendanceStatus !== "ATTENDED" ||
                          new Date(current.table.event.endsAt) > new Date()
                        }
                        onClick={() => go("feedback")}
                      >
                        피드백 남기기
                      </button>
                    </div>
                    <button
                      className="text-button muted"
                      onClick={() => go("safety")}
                    >
                      신고·차단 / 안전한 만남
                    </button>
                  </>
                )}
                <Policy cutoff={current.cancellationCutoffAt} />
                {current.cancellationBlocked &&
                  current.applicationStatus === "SUBMITTED" && (
                    <p className="info-box">
                      행사 당일에는 직접 취소·단체방 퇴장이 제한됩니다. 실제
                      불참이나 안전 문제는 운영자에게 알려 주세요.
                    </p>
                  )}
                {current.applicationStatus === "SUBMITTED" &&
                  !current.cancellationBlocked &&
                  current.attendanceStatus === "SCHEDULED" &&
                  (!current.table ||
                    new Date(current.table.event.endsAt) > new Date()) && (
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            "취소 시점에 따라 환불이 제한될 수 있어요. 신청을 취소할까요?",
                          )
                        )
                          void perform("cancel", { applicationId: current.id });
                      }}
                    >
                      신청 취소 기록하기
                    </button>
                  )}
              </>
            ) : (
              <Empty
                title="아직 신청한 식탁이 없어요"
                body="다가오는 일정에서 첫 만남을 찾아보세요."
              />
            ))}
          {tab === "chat" &&
            (current?.table?.room ? (
              <>
                <div className="chat-context">
                  <Badge value="CONFIRMED" />
                  <span>
                    {current.table.event.region} ·{" "}
                    {date(current.table.event.startsAt)}
                  </span>
                </div>
                <div className="messages">
                  {current.table.room.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`message ${m.kind !== "CHAT" ? "system" : m.userId === data.user.id ? "mine" : ""}`}
                    >
                      <small>
                        {m.sender} · {time(m.createdAt)}
                      </small>
                      <p>{m.body}</p>
                    </div>
                  ))}
                </div>
                <form
                  className="chat-compose"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const f = new FormData(form);
                    if (
                      await perform("message", {
                        roomId: current.table!.room!.id,
                        body: f.get("body"),
                        requestId: crypto.randomUUID(),
                      })
                    )
                      form.reset();
                  }}
                >
                  <input
                    aria-label="메시지"
                    name="body"
                    required
                    maxLength={2000}
                    placeholder="편안하게 인사를 나눠보세요"
                  />
                  <button
                    className="primary"
                    disabled={busy}
                    aria-label="메시지 보내기"
                  >
                    <ArrowRight size={20} />
                  </button>
                </form>
              </>
            ) : (
              <Empty
                title="만남이 정해지면 열려요"
                body="모임이 확정되면 함께할 사람들과 인사를 나눌 수 있어요."
              />
            ))}
          {tab === "feedback" && current?.table && (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                if (
                  await perform("feedback", {
                    applicationId: current.id,
                    atmosphere: Number(f.get("atmosphere")),
                    conversation: Number(f.get("conversation")),
                    venue: Number(f.get("venue")),
                    returnIntent: f.get("returnIntent") === "yes",
                    recommend: Number(f.get("recommend")),
                    comment: f.get("comment"),
                    liked: f.getAll("liked"),
                    avoided: f.getAll("avoided"),
                  })
                )
                  go("mine");
              }}
            >
              <p className="page-intro">
                솔직한 이야기가 다음 만남을 더 좋게 만들어요.
                <br />
                사람별 선택은 상대에게 공개되지 않아요.
              </p>
              {[
                ["atmosphere", "식탁 분위기"],
                ["conversation", "대화 만족도"],
                ["venue", "식당 만족도"],
              ].map(([name, label]) => (
                <Field key={name} label={label}>
                  <select
                    name={name}
                    defaultValue={current.feedback?.[name as "atmosphere"] ?? 5}
                  >
                    {[5, 4, 3, 2, 1].map((n) => (
                      <option key={n} value={n}>
                        {n}점
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
              <Field label="다시 참여하고 싶나요?">
                <select
                  name="returnIntent"
                  defaultValue={
                    current.feedback?.returnIntent === false ? "no" : "yes"
                  }
                >
                  <option value="yes">네, 다시 만나고 싶어요</option>
                  <option value="no">아직 잘 모르겠어요</option>
                </select>
              </Field>
              <Field label="친구에게 추천할 마음 (0~10)">
                <input
                  name="recommend"
                  type="number"
                  min={0}
                  max={10}
                  defaultValue={current.feedback?.recommend ?? 8}
                  required
                />
              </Field>
              <h3>사람별 비공개 선호</h3>
              {current.table.members
                .filter((m) => m.id !== data.user.id)
                .map((m) => (
                  <div key={m.id} className="card compact">
                    <strong>{m.name}</strong>
                    <div className="row wrap">
                      <label className="check-label">
                        <input
                          type="checkbox"
                          name="liked"
                          value={m.id}
                          defaultChecked={current.peerPreferences.some(
                            (p) => p.userId === m.id && p.kind === "LIKE",
                          )}
                        />
                        다시 만나고 싶어요
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          name="avoided"
                          value={m.id}
                          defaultChecked={current.peerPreferences.some(
                            (p) => p.userId === m.id && p.kind === "AVOID",
                          )}
                        />
                        다음에는 피하고 싶어요
                      </label>
                    </div>
                  </div>
                ))}
              <Field label="남기고 싶은 이야기">
                <textarea
                  name="comment"
                  maxLength={1000}
                  defaultValue={current.feedback?.comment ?? ""}
                />
              </Field>
              <button className="primary" disabled={busy}>
                비공개 피드백 저장
              </button>
            </form>
          )}
          {tab === "safety" && current?.table && (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                if (
                  await perform(String(f.get("kind")), {
                    applicationId: current.id,
                    targetId: f.get("targetId"),
                    reason: f.get("reason"),
                    evidence: f.get("evidence"),
                  })
                )
                  go("detail");
              }}
            >
              <div className="info-box">
                <ShieldCheck size={24} />
                <p>
                  신고 내용은 상대에게 공개되지 않아요. 접수 즉시 앞으로의
                  매칭에서 분리하고 운영자가 검토해요.
                </p>
              </div>
              <Field label="대상 참가자">
                <select name="targetId">
                  {current.table.members
                    .filter((m) => m.id !== data.user.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="처리 방법">
                <select name="kind">
                  <option value="report">운영자에게 신고</option>
                  <option value="block">앞으로 만나지 않도록 차단</option>
                </select>
              </Field>
              <Field label="사유">
                <textarea name="reason" required maxLength={1000} />
              </Field>
              <Field label="추가 설명·증빙 링크 (선택)">
                <textarea name="evidence" maxLength={2000} />
              </Field>
              <button className="primary" disabled={busy}>
                비공개로 접수하기
              </button>
            </form>
          )}
          {tab === "mine" && (
            <>
              <div className="profile-summary">
                <span className="avatar large">{data.user.name[0]}</span>
                <div>
                  <h2>{data.user.name}님</h2>
                  <p>{data.user.profile?.interests.join(" · ")}</p>
                </div>
              </div>
              <button className="secondary full" onClick={() => go("profile")}>
                프로필 수정하기
              </button>
              <div className="ticket-card">
                <span>보관·사용 가능한 이용권</span>
                <strong>
                  {data.ticketBalance}
                  <small> 회</small>
                </strong>
                <p>현재 유효한 이용권 원장 기준</p>
              </div>
              <section className="card stack" aria-label="보유 이용권 유효기간">
                <h3>구매별 사용 가능 이용권</h3>
                {data.ticketLots.length ? (
                  data.ticketLots.map((lot) => (
                    <div key={lot.id}>
                      <strong>{lot.units}회 사용 가능</strong>
                      <p className="small muted">
                        구매·지급 {date(lot.purchasedAt)}
                      </p>
                      <p className="small">
                        {lot.expiresAt
                          ? `${date(lot.expiresAt)} ${time(lot.expiresAt)} (한국 시간) 만료`
                          : "만료일 없음"}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="muted">현재 사용할 수 있는 이용권이 없어요.</p>
                )}
                <p className="small muted">
                  예약·환불 처리 중인 이용권과 만료된 이용권은 사용 가능
                  횟수에서 제외돼요.
                </p>
              </section>
              <h2>나의 식탁 기록</h2>
              <section className="card stack" aria-label="개인정보 요청">
                <h3>개인정보 삭제·탈퇴 요청</h3>
                <p>
                  {PRIVACY_REVIEW_ORGANIZATION} 담당자가 요청을 확인하고, 진행
                  중인 모임·환불·이용권과 삭제·보존 범위를 검토해요. 요청만으로
                  계정이나 거래가 삭제되지는 않아요.
                </p>
                <button
                  disabled={busy}
                  className="secondary"
                  onClick={() =>
                    void perform("privacyRequest", { scope: "DELETE" })
                  }
                >
                  개인정보 삭제 검토 요청
                </button>
                <button
                  disabled={busy}
                  className="secondary"
                  onClick={() =>
                    void perform("privacyRequest", { scope: "WITHDRAW" })
                  }
                >
                  탈퇴 검토 요청
                </button>
                {data.privacyRequests.map((r) => (
                  <div key={r.id}>
                    <p>
                      {r.reason} ·{" "}
                      {r.status === "OPEN"
                        ? "접수"
                        : r.status === "REVIEWING"
                          ? "검토 중"
                          : "처리 불가 안내"}
                    </p>
                    <p>{r.resolution}</p>
                  </div>
                ))}
                <a href="/privacy">삭제·보존 기준 확인</a>
              </section>
              {data.applications
                .filter((a) => a.applicationStatus !== "DRAFT")
                .map((a) => (
                  <button
                    className="history-row"
                    key={a.id}
                    onClick={() => go("detail", a)}
                  >
                    <div>
                      <strong>
                        {a.table
                          ? date(a.table.event.startsAt)
                          : a.options[0]
                            ? `희망 ${date(a.options[0].event.startsAt)}`
                            : "이전 신청"}
                      </strong>
                      <small>
                        {a.table
                          ? a.table.event.region
                          : a.options
                              .map((o) => o.event.region)
                              .join(" · ")}{" "}
                        · {a.feedback ? "피드백 완료" : "피드백 미작성"}
                      </small>
                    </div>
                    <Badge value={a.matchStatus} />
                  </button>
                ))}
              <button className="primary full" onClick={() => go("events")}>
                다음 식탁 둘러보기 <Plus size={17} />
              </button>
              {data.user.role !== "PARTICIPANT" && (
                <a className="secondary full" href="/admin">
                  운영자 화면으로
                </a>
              )}
              <button
                className="text-button muted"
                onClick={() => void signOut()}
              >
                <LogOut size={16} /> 로그아웃
              </button>
            </>
          )}
          {tab === "notifications" && (
            <>
              <button className="secondary full" onClick={() => void push()}>
                푸시 알림 연결하기
              </button>
              {data.notifications.length ? (
                data.notifications.map((n) => (
                  <button
                    key={n.id}
                    className="notification"
                    onClick={() => {
                      const target = new URL(n.href, location.origin);
                      const app = data.applications.find(
                        (a) => a.id === target.searchParams.get("application"),
                      );
                      go(target.searchParams.get("tab") ?? "detail", app);
                    }}
                  >
                    <span className="notification-icon">
                      <Bell size={18} />
                    </span>
                    <div>
                      <strong>{n.title}</strong>
                      <p>{n.body}</p>
                      <small>
                        {date(n.createdAt)} {time(n.createdAt)}
                      </small>
                    </div>
                  </button>
                ))
              ) : (
                <Empty
                  title="아직 도착한 소식이 없어요"
                  body="신청부터 모임까지 필요한 소식을 여기서 알려드릴게요."
                />
              )}
            </>
          )}
        </div>
        <nav className="bottom-nav" aria-label="주 메뉴">
          {[
            ["events", "일정", CalendarDays],
            ["notifications", "알림", Bell],
            ["home", "홈", Home],
            ["chat", "채팅", MessageCircle],
            ["mine", "마이", UserRound],
          ].map(([key, label, Icon]) => {
            const I = Icon as typeof Home;
            return (
              <button
                key={key as string}
                aria-label={label as string}
                aria-current={tab === key ? "page" : undefined}
                className={`${tab === key ? "active" : ""} ${key === "home" ? "home-nav" : ""}`}
                onClick={() => go(key as string)}
              >
                <I size={22} />
                <span>{label as string}</span>
              </button>
            );
          })}
        </nav>
      </section>
    </main>
  );
}
function EventCard({
  event: e,
  index,
  onClick,
}: {
  event: ParticipantData["events"][number];
  index: number;
  onClick: () => void;
}) {
  return (
    <button className="event-card" onClick={onClick}>
      <div className={`event-art art-${index % 3}`}>
        <UtensilsCrossed size={28} />
        <span>{e.region.split("·")[0]}</span>
      </div>
      <div>
        <span className="event-tag">모집 중 · 4–6명</span>
        <h3>{e.title}</h3>
        <p className="small">{e.recommendation}</p>
        <p>
          <CalendarDays size={13} />
          {date(e.startsAt)} {time(e.startsAt)}
        </p>
        <p>
          <MapPin size={13} />
          {e.region}
        </p>
        <strong className="event-price">
          9,900원 <small>/ 1회 참가권 · 식비 별도</small>
        </strong>
      </div>
      <ChevronRight size={18} className="muted" />
    </button>
  );
}
function NoticeSchedule({ notice }: { notice: App["nextNotice"] }) {
  const status = {
    SCHEDULED: "예정",
    DELAYED: "지연",
    PROCESSING: "처리 중",
    FAILED: "확인 필요",
    UNSCHEDULED: "일정 미정",
    COMPLETED: "안내 완료",
    CANCELED: "취소",
  }[notice.state];
  return (
    <section className="card stack" aria-label="다음 안내 일정">
      <h3>
        {notice.label} · {status}
      </h3>
      {notice.scheduledAt && (
        <strong>
          {date(notice.scheduledAt)} {time(notice.scheduledAt)} (한국 시간)
        </strong>
      )}
      <p className="small muted">{notice.detail}</p>
    </section>
  );
}
function Policy({ cutoff }: { cutoff: string | Date | null }) {
  return (
    <details className="policy">
      <summary>참가·취소·안전 안내</summary>
      <p>
        참가비와 식비는 별도이며 식비는 현장에서 각자 계산해요.{" "}
        {cancellationNotice(cutoff)} 서비스 매칭 실패 시에는 일정 이동·이용권
        보관·환불을 선택할 수 있어요. 당일 취소·노쇼는 기록되며 참가 제한 검토
        대상이 될 수 있어요. 당일 직접 취소·퇴장은 제한되며 실제 이탈은 운영자가
        기록합니다. 안전 신고는 언제든 가능해요. 이용권은 결제 시점부터 상품에
        표시된 기간 동안 유효하며 자동 갱신되지 않아요.
      </p>
      <p>
        모의 환불은 원결제액을 구매 횟수로 나눈 회당 금액을 적용해요. 취소·매칭
        실패한 구매 신청의 1회와 유효한 미사용분이 대상이며, 다른 신청에
        예약·사용 중인 이용권은 제외돼요. 만료된 미사용분은 제외하고, 서비스
        매칭 실패한 신청의 1회는 반환해요. 환불 뒤 다른 신청을 취소하면 해당
        이용권을 복원해요. 실제 결제 서비스의 환불 정책은 아직 확정하지
        않았어요.
      </p>
      <a href="/privacy">개인정보·탈퇴 처리 안내</a>
    </details>
  );
}
function ProfileForm({
  data,
  busy,
  save,
}: {
  data: ParticipantData;
  busy: boolean;
  save: (p: unknown) => Promise<void>;
}) {
  const p = data.user.profile;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await save({
          name: f.get("name"),
          contact: f.get("contact"),
          birthYear: Number(f.get("birthYear")),
          gender: f.get("gender"),
          occupation: f.get("occupation"),
          mbti: f.getAll("mbti"),
          interests: f.getAll("interests"),
          traits: f.getAll("traits"),
          desiredTraits: f.getAll("desiredTraits"),
          budgets: f.getAll("budgets"),
          foodRestrictions: f.get("foodRestrictions"),
          allergies: f.get("allergies"),
          consent: f.get("consent") === "on",
        });
      }}
    >
      <p className="page-intro">
        편안한 만남을 위해 조금만 알려주세요.
        <br />
        연락처와 출생연도는 다른 참가자에게 공개되지 않아요.
      </p>
      <div className="form-grid">
        <Field label="이름">
          <input
            name="name"
            required
            maxLength={40}
            defaultValue={data.user.name}
          />
        </Field>
        <Field label="연락처">
          <input
            name="contact"
            required
            minLength={6}
            defaultValue={p?.contact}
          />
        </Field>
        <Field label="출생연도">
          <input
            name="birthYear"
            type="number"
            min={1900}
            max={new Date().getFullYear() - 18}
            required
            defaultValue={p?.birthYear}
          />
        </Field>
        <Field label="성별">
          <select name="gender" defaultValue={p?.gender}>
            {["여성", "남성", "기타"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="직업">
        <input name="occupation" required defaultValue={p?.occupation} />
      </Field>
      <h3>나의 MBTI</h3>
      <Chips
        name="mbti"
        values={[
          "ENFP",
          "ENFJ",
          "ENTP",
          "ENTJ",
          "ESFP",
          "ESFJ",
          "ESTP",
          "ESTJ",
          "INFP",
          "INFJ",
          "INTP",
          "INTJ",
          "ISFP",
          "ISFJ",
          "ISTP",
          "ISTJ",
          "잘 모르겠어요",
        ]}
        selected={p?.mbti}
      />
      <p className="small muted">
        불확실하면 여러 유형이나 ‘잘 모르겠어요’를 선택할 수 있어요.
      </p>
      <h3>요즘 관심 있는 것</h3>
      <Chips
        name="interests"
        values={[
          "여행",
          "음식",
          "운동",
          "문화",
          "자기계발",
          "책",
          "음악",
          "일상",
        ]}
        selected={p?.interests}
      />
      <h3>나는 이런 사람</h3>
      <Chips
        name="traits"
        values={[
          "편안한 대화",
          "깊은 대화",
          "새로운 경험",
          "잘 듣는 사람",
          "활발한 분위기",
          "차분한 분위기",
        ]}
        selected={p?.traits}
      />
      <h3>만나고 싶은 사람</h3>
      <Chips
        name="desiredTraits"
        values={[
          "편안한 대화",
          "깊은 대화",
          "새로운 경험",
          "잘 듣는 사람",
          "활발한 분위기",
          "차분한 분위기",
        ]}
        selected={p?.desiredTraits}
      />
      <h3>편안한 식사 예산</h3>
      <Chips
        name="budgets"
        values={["1만~2만원", "2만~3만원", "3만~4만원", "4만원 이상"]}
        selected={p?.budgets}
      />
      <Field label="못 먹는 음식·기호 (없으면 없음)">
        <input
          name="foodRestrictions"
          required
          defaultValue={p?.foodRestrictions}
        />
      </Field>
      <Field label="알레르기 (없으면 없음)">
        <input name="allergies" required defaultValue={p?.allergies} />
      </Field>
      <label className="check-label">
        <input name="consent" type="checkbox" required defaultChecked={!!p} />
        개인정보 수집·이용과 운영 정책에 동의해요.
      </label>
      <a href="/privacy" className="small">
        개인정보 안내 보기
      </a>
      <button className="primary full" disabled={busy}>
        프로필 저장 <Check size={18} />
      </button>
    </form>
  );
}
