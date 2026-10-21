// AI-01/02: prepaid demo terms, not a PG subscription or automatic renewal.
export const ticketProducts = [
  { code: "SINGLE", name: "1회권", amount: 9900, units: 1, months: 2 },
  {
    code: "MEMBERSHIP_1",
    name: "1개월 멤버십",
    amount: 39600,
    units: 4,
    months: 1,
  },
  {
    code: "MEMBERSHIP_3",
    name: "3개월 멤버십",
    amount: 118800,
    units: 12,
    months: 3,
  },
  {
    code: "MEMBERSHIP_6",
    name: "6개월 멤버십",
    amount: 237600,
    units: 24,
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
  return { ...product, policyVersion: "prepaid-demo-v1" };
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
  return offer.code === "EXISTING"
    ? offer.name
    : `${offer.name} ${offer.amount.toLocaleString()}원 · 총 ${offer.units}회 · 결제일부터 ${offer.months}개월 · 자동갱신 없음`;
}
