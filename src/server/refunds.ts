import { audit, ensure, type Tx } from "./db";
import { enqueue, notify } from "./jobs";

// A demonstration assumption only. Actual partial-refund terms and PG support
// are not defined by this policy. All mutations run inside atomic().
export const MOCK_REFUND_POLICY = "mock-equal-unit-v1";

export async function releaseTicket(
  tx: Tx,
  applicationId: string,
  kind = "RESTORE",
) {
  const reserve = await tx.ticketEntry.findUnique({
    where: { key: `reserve:${applicationId}` },
  });
  if (reserve)
    await tx.ticketEntry.upsert({
      where: { key: `release:${applicationId}` },
      create: {
        userId: reserve.userId,
        applicationId,
        paymentId: reserve.paymentId,
        expiresAt: reserve.expiresAt,
        kind,
        units: 1,
        key: `release:${applicationId}`,
      },
      update: {},
    });
}

export async function requestRefund(
  tx: Tx,
  applicationId: string,
  reason: string,
) {
  const a = await tx.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { payments: { where: { status: "PAID" } } },
  });
  const p =
    a.payments.find((p) => p.method === "MOCK_CARD") ??
    a.payments.find((p) => p.method === "TICKET");
  ensure(p, "환불 가능한 거래가 없습니다.");
  if (p.method === "TICKET") {
    await releaseTicket(tx, a.id);
    await tx.payment.update({
      where: { id: p.id },
      data: { status: "REFUNDED" },
    });
    await tx.application.update({
      where: { id: a.id },
      data: {
        paymentStatus: "REFUNDED",
        reason: "현금 거래 없이 원래 이용권을 복원했어요.",
      },
    });
    await notify(
      tx,
      a.userId,
      `ticket-restored:${p.id}`,
      "이용권이 복원되었어요",
      "사용한 이용권 1회를 원래 이용권으로 돌려드렸어요. 현금 환불은 발생하지 않습니다.",
      `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
    );
    await audit(tx, "SYSTEM", "TICKET_RESTORED", a.id, undefined, {
      paymentId: p.id,
      reason,
      units: 1,
    });
    return;
  }
  // The payment's unique refund keeps duplicate requests from re-quoting a
  // changed balance or taking a second hold after another ticket is restored.
  const existing = await tx.refund.findUnique({ where: { paymentId: p.id } });
  if (existing) return;
  const entries = await tx.ticketEntry.findMany({ where: { paymentId: p.id } });
  const purchase = entries.find((e) => e.key === `purchase:${p.id}`);
  const reserve = entries.find((e) => e.key === `reserve:${a.id}`);
  ensure(
    purchase &&
      purchase.units > 0 &&
      reserve?.units === -1 &&
      !entries.some((e) => e.key === `release:${a.id}`),
    "환불 대상 이용권 원장을 확인할 수 없습니다.",
  );
  const net = entries.reduce((sum, e) => sum + e.units, 0);
  ensure(net >= 0, "이용권 원장 잔액을 확인해 주세요.");
  const expired = purchase.expiresAt && purchase.expiresAt <= new Date();
  const availableUnits = expired ? 0 : net;
  const refundedUnits = availableUnits + 1;
  const unitAmount = p.amount / purchase.units;
  ensure(
    Number.isInteger(unitAmount) &&
      unitAmount > 0 &&
      refundedUnits <= purchase.units,
    "모의 환불 금액을 확인할 수 없습니다.",
  );
  const calculation = {
    policyVersion: MOCK_REFUND_POLICY,
    purchasedUnits: purchase.units,
    applicationUnits: 1,
    availableUnits,
    expiredUnusedUnits: expired ? net : 0,
    refundedUnits,
    unitAmount,
  };
  const r = await tx.refund.create({
    data: {
      paymentId: p.id,
      amount: unitAmount * refundedUnits,
      reason,
      calculation,
    },
  });
  // Return the canceled application's reservation, then hold exactly the
  // quoted units. Other applications keep their reservations and used units.
  await releaseTicket(tx, a.id, "REFUND_RELEASE");
  await tx.ticketEntry.create({
    data: {
      userId: a.userId,
      applicationId: a.id,
      paymentId: p.id,
      kind: "REFUND_HOLD",
      units: -refundedUnits,
      key: `refund-hold:${r.id}`,
      expiresAt: purchase.expiresAt,
    },
  });
  await tx.application.update({
    where: { id: a.id },
    data: { paymentStatus: "REFUND_REQUESTED" },
  });
  await enqueue(tx, `refund:${r.id}`, "REFUND", { refundId: r.id });
  await notify(
    tx,
    a.userId,
    `refund-request:${r.id}`,
    "환불 요청을 받았어요",
    `${r.amount.toLocaleString()}원 모의 환불을 처리 중입니다. 데모 산식: ${refundedUnits}회 × ${unitAmount.toLocaleString()}원. 다른 신청에 배정된 이용권은 유지돼요. 실제 금전 거래는 없습니다.`,
    `/app?tab=detail&application=${encodeURIComponent(applicationId)}`,
  );
  await audit(tx, "SYSTEM", "REFUND_REQUESTED", a.id, undefined, {
    refundId: r.id,
    amount: r.amount,
    ...calculation,
  });
}

export async function completeMockRefund(tx: Tx, refundId: string) {
  const r = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { payment: { include: { application: true } } },
  });
  if (r.status === "REFUNDED") return;
  ensure(
    r.payment.method === "MOCK_CARD" &&
      r.amount > 0 &&
      r.amount <= r.payment.amount,
    "모의 환불 거래 금액을 확인해 주세요.",
  );
  const hold = await tx.ticketEntry.findUnique({
    where: { key: `refund-hold:${r.id}` },
  });
  ensure(
    hold && hold.paymentId === r.paymentId && hold.units <= 0,
    "환불 이용권 보류 원장을 확인해 주세요.",
  );
  await tx.refund.update({
    where: { id: r.id },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  await tx.application.update({
    where: { id: r.payment.applicationId },
    data: { paymentStatus: "REFUND_PROCESSING" },
  });
  await audit(
    tx,
    "SYSTEM",
    "REFUND_PROCESSING",
    r.payment.applicationId,
    undefined,
    { refundId: r.id },
  );
  // Commit the original hold only. A different application's cancellation may
  // have restored a unit while this job was queued or failed; it remains usable.
  const entry = {
    userId: r.payment.application.userId,
    applicationId: r.payment.applicationId,
    paymentId: r.paymentId,
    expiresAt: hold.expiresAt,
  };
  await tx.ticketEntry.create({
    data: {
      ...entry,
      kind: "REFUND_HOLD_RELEASE",
      units: -hold.units,
      key: `refund-hold-release:${r.id}`,
    },
  });
  await tx.ticketEntry.create({
    data: {
      ...entry,
      kind: "REFUND",
      units: hold.units,
      key: `refund:${r.id}`,
    },
  });
  await tx.refund.update({ where: { id: r.id }, data: { status: "REFUNDED" } });
  await tx.payment.update({
    where: { id: r.paymentId },
    data: {
      status: r.amount < r.payment.amount ? "PARTIALLY_REFUNDED" : "REFUNDED",
    },
  });
  await tx.application.update({
    where: { id: r.payment.applicationId },
    data: { paymentStatus: "REFUNDED" },
  });
  await notify(
    tx,
    r.payment.application.userId,
    `refunded:${r.id}`,
    "모의 환불이 완료되었어요",
    `${r.amount.toLocaleString()}원을 원 결제에 연결해 모의 환불 처리했어요. 다른 신청에 배정된 이용권은 유지돼요. 실제 금전 거래는 없습니다.`,
    `/app?tab=detail&application=${encodeURIComponent(r.payment.applicationId)}`,
  );
  await audit(
    tx,
    "SYSTEM",
    "REFUND_COMPLETED",
    r.payment.applicationId,
    undefined,
    { refundId: r.id, amount: r.amount, calculation: r.calculation },
  );
}
