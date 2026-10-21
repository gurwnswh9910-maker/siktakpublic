// AI-06: only local disposable demo databases may compress a day to a minute.
export function notificationDayMs() {
  if (process.env.SIKTAK_NOTIFICATION_MINUTE !== "true") return 86400000;
  const url = new URL(process.env.DATABASE_URL!);
  if (
    process.env.DEMO_MODE !== "true" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  )
    throw new Error("1분 알림은 로컬 합성 테스트 DB에서만 사용할 수 있습니다.");
  return 60000;
}
