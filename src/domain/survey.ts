import type { Candidate } from "./matching";
export type SurveyRow = {
  record_id: string;
  source_excel_row: number;
  fields: Record<string, string | number | null>;
};
// Split checkbox lists without splitting commas inside parentheses or numbers.
export function splitChoices(value: string) {
  const result: string[] = [];
  let start = 0,
    depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth = Math.max(0, depth - 1);
    if (
      value[i] === "," &&
      depth === 0 &&
      !(/\d/.test(value[i - 1] ?? "") && /\d/.test(value[i + 1] ?? ""))
    ) {
      result.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}
export const regionAliases = [
  ["홍대·합정", /홍대|합정/],
  ["강남·신논현", /강남|신논현/],
  ["종로·을지로", /종로|을지로/],
  ["잠실", /잠실/],
] as const;
export function normalizeSurvey(row: SurveyRow, assumedYear = 2026) {
  const f = row.fields;
  const raw = (k: string) => String(f[k] ?? "");
  const issues: string[] = [
    "연도 없는 날짜에 2026년 데모 가정 적용",
    "응답별 독립 가상 신원: 실제 고유인 여부 미검증",
    "결제·앱 동의·회원정보 없음",
  ];
  const regions = regionAliases
    .filter(([, re]) => re.test(raw("available_regions")))
    .map(([name]) => name);
  if (!regions.length)
    issues.push("표준 지역 확인 필요: 자유 입력을 자동 확대하지 않음");
  const mbtiRaw = raw("mbti").trim().toUpperCase();
  const recognizedTypes = [
    ...new Set(mbtiRaw.match(/[EI][NS][TF][JP]/g) ?? []),
  ];
  const mbtiStatus = /^[EI][NS][TF][JP]$/.test(mbtiRaw) ? "EXACT" : "UNCERTAIN";
  if (mbtiStatus === "UNCERTAIN")
    issues.push("MBTI 복수·비표준·추가 설명: 중립 평가");
  const dateMatches = [
    ...raw("available_dates").matchAll(/(\d{1,2})\/(\d{1,2})/g),
  ];
  const options = dateMatches.flatMap((m, i) => {
    const tail = raw("available_dates").slice(
      m.index,
      dateMatches[i + 1]?.index,
    );
    // Preserve date-specific restrictions, e.g. source Excel row 228.
    const restricted = regionAliases
      .filter(([, re]) => re.test(tail))
      .map(([name]) => name);
    const allowed = restricted.length
      ? regions.filter((r) => restricted.includes(r))
      : regions;
    if (restricted.length) issues.push("날짜별 지역 제한 유지");
    const date = `${assumedYear}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (new Date(date + "T10:30:00+09:00").toISOString().slice(0, 10) !== date)
      throw new Error(`Invalid date at ${row.record_id}`);
    return allowed.map((region) => ({ date, region }));
  });
  const candidate: Candidate = {
    id: row.record_id,
    userId: `synthetic-response:${row.record_id}`,
    age: Number(f.age),
    gender:
      raw("gender") === "남"
        ? "남성"
        : raw("gender") === "여"
          ? "여성"
          : raw("gender"),
    mbti: mbtiStatus === "EXACT" ? recognizedTypes : [],
    interests: splitChoices(raw("interests")),
    traits: splitChoices(raw("self_traits")),
    desiredTraits: splitChoices(raw("desired_traits")),
  };
  return {
    recordId: row.record_id,
    sourceExcelRow: row.source_excel_row,
    raw: f,
    candidate,
    options,
    mbtiStatus,
    recognizedTypes,
    budgets: splitChoices(raw("meal_budget")),
    foodRestrictions: f.food_restrictions,
    historicalConsent: raw("consent"),
    eligibility: {
      payment: "UNKNOWN",
      appConsent: "NOT_COLLECTED",
      identity: "UNVERIFIED",
    },
    assumptions: {
      year: assumedYear,
      slotTime: "19:30 Asia/Seoul (benchmark only)",
    },
    issues,
  };
}
