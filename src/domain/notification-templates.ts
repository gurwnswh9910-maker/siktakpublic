export const defaultNotificationTemplates = {
  curation:
    "함께할 식탁을 소개해요. 편안한 마음으로 새로운 만남을 준비해 주세요.",
  reminder:
    "내일의 만남을 준비해 주세요. 시간·장소·예약명과 취소 및 노쇼 정책을 다시 확인해 주세요.",
  alternative:
    "다음 만남을 함께 찾아볼게요. 가능한 일정과 해결 방법을 확인해 주세요.",
};

export type NotificationTemplates = typeof defaultNotificationTemplates;

// Old installations may only have a reminder. Keep all other defaults usable.
export function notificationTemplates(value: unknown): NotificationTemplates {
  const saved = value && typeof value === "object" ? value : {};
  const result = { ...defaultNotificationTemplates };
  for (const key of Object.keys(result) as (keyof NotificationTemplates)[]) {
    const text = (saved as Record<string, unknown>)[key];
    if (typeof text === "string" && text.trim()) result[key] = text.trim();
  }
  return result;
}

export function eventDateTime(date: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function eventWeekday(date: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    weekday: "long",
  }).format(date);
}
