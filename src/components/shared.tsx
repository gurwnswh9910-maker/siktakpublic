"use client";
import { useCallback, useEffect, useState } from "react";
import { UtensilsCrossed, ArrowUpRight } from "lucide-react";
export const date = (v: string | Date) =>
  new Date(v).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
export const time = (v: string | Date) =>
  new Date(v).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const labels: Record<string, string> = {
  DRAFT: "작성 중",
  SUBMITTED: "신청 완료",
  CANCELED: "취소",
  PENDING: "결제 대기",
  PAID: "결제 완료",
  FAILED: "실패",
  REFUND_AVAILABLE: "환불 선택 가능",
  REFUND_REQUESTED: "환불 요청",
  REFUND_PROCESSING: "환불 처리 중",
  PROCESSING: "처리 중",
  REFUNDED: "환불 완료",
  PARTIALLY_REFUNDED: "부분 모의 환불 완료",
  REFUND_FAILED: "환불 실패",
  WAITING: "매칭 대기",
  MATCHING: "매칭 중",
  REALLOCATING: "다른 식탁 찾는 중",
  CONFIRMED: "모임 확정",
  WAITLIST_PENDING: "대기 참가자 충원 중",
  REPLACED: "이전 배정",
  ALTERNATIVE_OFFERED: "다음 만남 선택",
  TRANSFERRED: "일정 이동",
  NO_MATCH: "매칭 종료",
  EXCEPTION: "확인 중",
  SCHEDULED: "참석 예정",
  ATTENDED: "참석 완료",
  CANCELED_EARLY: "사전 취소",
  CANCELED_LATE: "제한 이후 취소",
  NO_SHOW: "노쇼 확정",
  OPEN: "모집 중",
  MATCHED: "매칭 실행 완료",
  DONE: "완료",
  RUNNING: "처리 중",
  RESOLVED: "해결됨",
  SENT: "발송 완료",
  NOT_SUBSCRIBED: "푸시 구독 없음",
  UNCONFIGURED: "푸시 설정 필요",
  REVIEWED: "검토 완료",
};
export function refundExplanation(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const calculation = value as Record<string, unknown>;
  return calculation.policyVersion === "mock-equal-unit-v1" &&
    typeof calculation.refundedUnits === "number" &&
    typeof calculation.unitAmount === "number"
    ? `${calculation.refundedUnits}회 × ${calculation.unitAmount.toLocaleString()}원 (모의 산식)`
    : null;
}
export function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${["CONFIRMED", "PAID", "ATTENDED", "DONE", "SENT", "RESOLVED"].includes(value) ? "green" : ["FAILED", "REFUND_FAILED", "EXCEPTION", "NO_SHOW"].includes(value) ? "red" : ""}`}
    >
      {labels[value] ?? value}
    </span>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-icon">
        <UtensilsCrossed size={20} />
      </span>
      우연한 식탁
    </span>
  );
}
export function BrandPanel() {
  return (
    <aside className="brand-panel">
      <Brand />
      <div className="brand-copy">
        <span className="eyebrow">A LITTLE CHANCE, A GOOD EVENING</span>
        <h1>
          좋은 사람들과,
          <br />
          좋은 저녁 한 끼.
        </h1>
        <p>
          취향이 닮은 낯선 사람들과
          <br />
          식탁 위에서 시작되는 새로운 이야기.
        </p>
        <div className="table-art" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <div>
            <UtensilsCrossed size={48} />
            <span>함께라서 더 맛있는 저녁</span>
          </div>
        </div>
        <div className="brand-values">
          <span>4–6명의 작은 모임</span>
          <b>·</b>
          <span>나와 닮은 취향</span>
        </div>
      </div>
      <p className="brand-bottom">
        우연한 만남이, 오래 남는 인연으로. <ArrowUpRight size={16} />
      </p>
    </aside>
  );
}
export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <UtensilsCrossed size={30} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Chips({
  name,
  values,
  selected = [],
}: {
  name: string;
  values: string[];
  selected?: string[];
}) {
  return (
    <div className="chips">
      {values.map((v) => (
        <label className="chip" key={v}>
          <input
            type="checkbox"
            name={name}
            value={v}
            defaultChecked={selected.includes(v)}
          />
          <span>{v}</span>
        </label>
      ))}
    </div>
  );
}
export function useView<T>(url: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 401) {
        location.href = "/login";
        return;
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setData(d);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "연결을 확인해 주세요.");
    }
  }, [url]);
  useEffect(() => {
    void reload();
    const handle = setInterval(() => {
      if (!document.hidden) void reload();
    }, 5000);
    return () => clearInterval(handle);
  }, [reload]);
  async function perform(action: string, payload: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, data: payload }),
      });
      const d = await r.json();
      if (!r.ok)
        throw new Error(d.error + (d.details ? " " + d.details.join(" ") : ""));
      await reload();
      if (d.ok === false)
        throw new Error(
          d.message || "상태가 변경되었습니다. 새 안내를 확인해 주세요.",
        );
      setNotice("변경 사항을 저장했어요.");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했어요.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { data, error, notice, busy, perform, reload, setNotice };
}
export async function signOut() {
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        const detached = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "unsubscribe",
            data: { endpoint: subscription.endpoint },
          }),
        });
        if (!detached.ok && detached.status !== 401)
          throw new Error("Push cleanup failed");
        // A server-side detach prevents delivery even if browser cleanup fails.
        const unsubscribed = await subscription
          .unsubscribe()
          .catch(() => false);
        if (!detached.ok && !unsubscribed)
          throw new Error("Push cleanup failed");
      }
      for (const notification of (await registration
        ?.getNotifications?.()
        .catch(() => [])) ?? [])
        notification.close();
    }
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("Sign out failed");
    location.href = "/login";
  } catch {
    window.alert(
      "로그아웃하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.",
    );
  }
}
