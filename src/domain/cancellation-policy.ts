type Cutoff = Date | string;
type CancellationEvent = { cancelRefundCutoffAt: Cutoff };
export function isMeetingDayOrLater(startsAt: Cutoff, now = new Date()) {
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  return day(now) >= day(new Date(startsAt));
}

// This selects the existing policy; it does not derive a new cutoff from the
// event start. A confirmed table takes precedence over earlier selected dates.
export function cancellationCutoff(application: {
  options: readonly { event: CancellationEvent }[];
  table?: { event: CancellationEvent } | null;
}): Date | null {
  if (application.table)
    return new Date(application.table.event.cancelRefundCutoffAt);
  const selected = application.options.map((option) =>
    new Date(option.event.cancelRefundCutoffAt).getTime(),
  );
  return selected.length ? new Date(Math.min(...selected)) : null;
}

export function isCancellationRestricted(
  cutoff: Cutoff | null,
  now = new Date(),
) {
  return cutoff !== null && now.getTime() >= new Date(cutoff).getTime();
}

// Browser and server notices use the same saved instant, including seconds
// when present, so a custom cutoff is never described as a fixed two days.
export function cancellationNotice(cutoff: Cutoff | null) {
  if (cutoff === null)
    return "일정을 선택하면 변심 환불 제한 시각을 안내해 드려요.";
  const date = new Date(cutoff);
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    ...(date.getUTCSeconds() || date.getUTCMilliseconds()
      ? { second: "2-digit" as const }
      : {}),
    ...(date.getUTCMilliseconds()
      ? { fractionalSecondDigits: 3 as const }
      : {}),
  }).format(date);
  return `${time} (한국 시간)부터 변심 환불이 제한됩니다.`;
}
