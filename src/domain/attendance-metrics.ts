type Entry = {
  attendanceStatus: string;
  startsAt: Date;
  endsAt: Date;
  canceledAt: Date | null;
};
const day = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
export function noShowMetric(entries: Entry[], now = new Date()) {
  let n = 0,
    d = 0,
    unknown = 0;
  for (const entry of entries) {
    if (entry.endsAt > now) continue;
    if (["CANCELED_EARLY", "CANCELED_LATE"].includes(entry.attendanceStatus)) {
      if (!entry.canceledAt) {
        unknown++;
        continue;
      }
      if (day(entry.canceledAt) < day(entry.startsAt)) continue;
    }
    d++;
    if (entry.attendanceStatus === "NO_SHOW") n++;
  }
  return { label: "노쇼율", n, d, value: d ? n / d : null, unknown };
}
