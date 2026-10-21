// 공식 FAQ(2026-10-16): 1회권 9,900원, 멤버십 1·3·6개월 35,000/75,000/120,000원.
// 멤버십은 기간 안에 횟수 제한 없이 참여하고, 매칭에 실패하면 실패 1회당 이용 기한을
// 7일(주 1회 모임 기준) 연장한다. 모의 결제이며 PG 구독·자동 갱신이 아니다.
// 기존 횟수 원장을 유지하려고 멤버십에는 큰 횟수를 넣고 화면에는 "무제한"으로 보인다.
export const UNLIMITED_UNITS = 1000;
export const isUnlimitedUnits = (units: number) => units >= UNLIMITED_UNITS / 2;
export const MEMBERSHIP_EXTENSION_DAYS = 7;
export const ticketProducts = [
  { code: "SINGLE", name: "1회권", amount: 9900, units: 1, months: 2 },
  {
    code: "MEMBERSHIP_1",
    name: "1개월 멤버십",
    amount: 35000,
    units: UNLIMITED_UNITS,
    months: 1,
  },
  {
    code: "MEMBERSHIP_3",
    name: "3개월 멤버십",
    amount: 75000,
    units: UNLIMITED_UNITS,
    months: 3,
  },
  {
    code: "MEMBERSHIP_6",
    name: "6개월 멤버십",
    amount: 120000,
    units: UNLIMITED_UNITS,
    months: 6,
  },
] as const;
export type TicketOffer = {
  code: string;
  name: string;
  amount: number;
  units: number;
  months: number;
  policyVersion: string;
};
export function ticketOffer(code: string): TicketOffer {
  if (code === "EXISTING")
    return {
      code,
      name: "보유 이용권 1회 사용",
      amount: 0,
      units: 0,
      months: 0,
      policyVersion: "prepaid-demo-v1",
    };
  // Kept for existing integrations and historic three-ticket purchases.
  const product =
    code === "TRIPLE"
      ? { code, name: "3회권", amount: 15000, units: 3, months: 2 }
      : ticketProducts.find((p) => p.code === code);
  if (!product) throw new Error("알 수 없는 참가권입니다.");
  return {
    ...product,
    policyVersion: isUnlimitedUnits(product.units)
      ? "faq-20261016-membership"
      : "prepaid-demo-v1",
  };
}
export function savedTicketOffer(code: string, snapshot: unknown): TicketOffer {
  if (snapshot && typeof snapshot === "object" && "policyVersion" in snapshot)
    return snapshot as TicketOffer;
  const product = ticketOffer(code);
  return {
    ...product,
    amount: code === "SINGLE" ? 8000 : product.amount,
    policyVersion: "legacy-ticket-v1",
  };
}
export function ticketExpiry(now: Date, months: number) {
  // Korean calendar month, preserving local wall time and clamping month-end.
  const local = new Date(+now + 9 * 3600000);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0),
  ).getUTCDate();
  local.setUTCDate(Math.min(day, last));
  return new Date(+local - 9 * 3600000);
}
export function ticketDescription(offer: TicketOffer) {
  if (offer.code === "EXISTING") return offer.name;
  if (isUnlimitedUnits(offer.units))
    return `${offer.name} ${offer.amount.toLocaleString()}원 · 기간 내 횟수 제한 없음 · 결제일부터 ${offer.months}개월 · 매칭 실패 시 1회당 ${MEMBERSHIP_EXTENSION_DAYS}일 연장 · 자동갱신 없음`;
  return `${offer.name} ${offer.amount.toLocaleString()}원 · 총 ${offer.units}회 · 결제일부터 ${offer.months}개월 · 자동갱신 없음`;
}
