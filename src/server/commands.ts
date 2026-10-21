import {
  previewManualAllocation,
  commitManualAllocation,
} from "./manual-allocation";
import { contentCommand } from "./content-catalog";
import { z } from "zod";
import { isFixedPolicy, policySchema } from "@/domain/matching-policy";
import { retainedTableQuality } from "./matching-policy";
import { randomUUID } from "node:crypto";
import {
  ticketOffer,
  savedTicketOffer,
  ticketExpiry,
} from "@/domain/ticket-products";
import { reservationExpiries, coversEvent } from "./ticket-eligibility";
import { suitableAlternatives } from "./alternative-events";
import { atomic, audit, ensure, admin, Actor, Tx, AppError } from "./db";
import { enqueue, notify } from "./jobs";
import { syncMeetingHistory } from "./attendance";
import {
  extendMembershipForFailure,
  membershipPurchaseFor,
  releaseTicket,
  requestRefund,
} from "./refunds";
export { releaseTicket } from "./refunds";
import { notificationTemplates } from "@/domain/notification-templates";
import {
  cancellationCutoff,
  cancellationNotice,
  isCancellationRestricted,
  isMeetingDayOrLater,
} from "@/domain/cancellation-policy";
import {
  alternativeNotice,
  applicationNotice,
  pendingPaymentNotice,
  matchScheduleNotice,
} from "./notification-content";
import { notifyNewEvent } from "./new-event-notifications";
import {
  advanceWaitlist,
  closeTableOffers,
  withdrawWaitlist,
  waitlistCommand,
} from "./waitlist";

const id = z.string().min(1).max(150);
const text = z.string().trim().min(1).max(1000);
const choices = z.array(z.string().min(1).max(50)).min(1).max(20);
const profileSchema = z.object({
  name: z.string().trim().min(1).max(40),
  contact: z.string().trim().min(6).max(40),
  birthYear: z
    .number()
    .int()
    .min(1900)
    .max(new Date().getFullYear() - 18),
  gender: z.enum(["남성", "여성", "기타"]),
  occupation: z.string().trim().min(1).max(100),
  mbti: z.array(z.string().max(30)).min(1).max(4),
  interests: choices,
  traits: choices,
  desiredTraits: choices,
  budgets: choices,
  foodRestrictions: z.string().trim().min(1).max(500),
  allergies: z.string().trim().min(1).max(500),
  consent: z.literal(true),
});
const eventSchema = z.object({
  title: text,
  region: z.string().min(1).max(50),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
  matchAt: z.iso.datetime(),
  cancelRefundCutoffAt: z.iso.datetime(),
  capacity: z.number().int().min(4).max(300),
});
export const isStaff = (actor: Actor) =>
  ["ADMIN", "OPERATIONS", "SAFETY"].includes(actor.role);
async function application(tx: Tx, actor: Actor, applicationId: string) {
  const a = await tx.application.findUnique({
    where: { id: applicationId },
    include: {
      options: { include: { event: true } },
      payments: true,
      table: { include: { event: true } },
    },
  });
  ensure(a && a.userId === actor.id, "신청을 찾을 수 없습니다.", 404);
  return a;
}
async function balance(tx: Tx, userId: string) {
  const entries = await tx.ticketEntry.findMany({
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  const lots = new Map<
    string,
    { paymentId: string | null; expiresAt: Date | null; units: number }
  >();
  for (const e of entries) {
    const key = e.paymentId ?? "grant";
    const lot = lots.get(key) ?? {
      paymentId: e.paymentId,
      expiresAt: e.expiresAt,
      units: 0,
    };
    lot.units += e.units;
    lots.set(key, lot);
  }
  return [...lots.values()]
    .filter((x) => x.units > 0)
    .sort(
      (a, b) =>
        (a.expiresAt?.getTime() ?? Infinity) -
        (b.expiresAt?.getTime() ?? Infinity),
    );
}
export async function invalidateTable(
  tx: Tx,
  tableId: string,
  actorId: string,
  force = false,
) {
  const t = await tx.diningTable.findUnique({
    where: { id: tableId },
    include: {
      applications: {
        where: {
          applicationStatus: "SUBMITTED",
          matchStatus: { in: ["CONFIRMED", "REALLOCATING"] },
        },
      },
      event: true,
      room: true,
    },
  });
  if (!t || !["CONFIRMED", "WAITLIST_PENDING"].includes(t.status)) return;
  if (!force && (await advanceWaitlist(tx, tableId))) return;
  if (force) await closeTableOffers(tx, tableId);
  // A held table may have been released by the waitlist helper.
  const state = await tx.diningTable.findUnique({ where: { id: tableId } });
  if (state?.status === "REALLOCATING") return;
  if (!force && (await retainedTableQuality(tx, tableId)).passes) {
    if (t.room)
      await tx.message.create({
        data: {
          roomId: t.room.id,
          kind: "SYSTEM",
          body: "참가자 변경이 반영되었습니다. 모임 시간과 장소는 동일합니다.",
          key: `change:${randomUUID()}`,
        },
      });
    return;
  }
  await tx.diningTable.update({
    where: { id: tableId },
    data: { status: "REALLOCATING" },
  });
  await tx.application.updateMany({
    where: { id: { in: t.applications.map((x) => x.id) } },
    data: {
      matchStatus: "REALLOCATING",
      tableId: null,
      reason: "참가자 변경으로 조건에 맞는 테이블을 다시 찾고 있어요.",
    },
  });
  await audit(
    tx,
    actorId,
    "TABLE_REOPENED",
    tableId,
    { count: t.applications.length },
    { status: "REALLOCATING" },
  );
  if (t.event.startsAt > new Date())
    await enqueue(tx, `repair:${tableId}`, "MATCH", { eventId: t.eventId });
  else {
    const reason = "참가자 변경으로 기존 모임을 유지하기 어려워졌어요.";
    for (const a of t.applications) {
      const notice = await alternativeNotice(tx, t.eventId, a.id);
      await tx.application.update({
        where: { id: a.id },
        data: {
          matchStatus: notice.count ? "ALTERNATIVE_OFFERED" : "NO_MATCH",
          paymentStatus: "REFUND_AVAILABLE",
          reason,
        },
      });
      await notify(
        tx,
        a.userId,
        `repair-offer:${tableId}:${a.id}`,
        "모임 변경 안내",
        notice.body(reason),
        `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
      );
      await audit(tx, "SYSTEM", "MATCH_UNRESOLVED", a.id, undefined, {
        eventId: t.eventId,
        factsVersion: 1,
        failedAt: new Date().toISOString(),
        reason,
      });
    }
  }
}
export async function command(actor: Actor, action: string, input: unknown) {
  return atomic(async (tx) => {
    const account = await tx.user.findUnique({ where: { id: actor.id } });
    ensure(account, "로그인이 필요합니다.", 401);
    // Refresh role from storage; never trust client fields or a stale cookie role.
    actor = { id: account.id, name: account.name, role: account.role };
    let result: unknown = { ok: true };
    ensure(account.restriction !== "WITHDRAWN", "탈퇴 처리된 계정입니다.", 403);
    if (["contentSave", "contentPublish", "contentStop"].includes(action)) {
      result = await contentCommand(tx, actor, action, input);
    } else if (action === "privacyRequest") {
      const p = z
        .object({ scope: z.enum(["DELETE", "WITHDRAW"]) })
        .parse(input);
      const prior = await tx.exceptionCase.findFirst({
        where: {
          kind: "PRIVACY",
          objectId: actor.id,
          status: { in: ["OPEN", "REVIEWING"] },
        },
      });
      const reason =
        p.scope === "DELETE"
          ? "개인정보 삭제 요청"
          : "탈퇴 및 개인정보 처리 요청";
      if (prior) {
        ensure(
          prior.reason === reason,
          "다른 종류의 개인정보 요청을 검토 중입니다. 기존 요청 검토가 끝난 뒤 다시 요청해 주세요.",
          409,
        );
        return { id: prior.id, status: prior.status };
      }
      const request = await tx.exceptionCase.create({
        data: {
          key: `privacy:${actor.id}:${randomUUID()}`,
          kind: "PRIVACY",
          objectId: actor.id,
          reason,
        },
      });
      await audit(tx, actor.id, "PRIVACY_REQUESTED", actor.id, undefined, {
        requestId: request.id,
        scope: p.scope,
      });
      result = { id: request.id, status: request.status };
    } else if (action === "privacyReview") {
      ensure(
        actor.role === "ADMIN",
        "전체 관리자만 개인정보 요청을 검토할 수 있습니다.",
        403,
      );
      const p = z
        .object({
          exceptionId: id,
          note: text,
          decision: z.enum(["REVIEWING", "REJECTED"]),
        })
        .parse(input);
      const request = await tx.exceptionCase.findUnique({
        where: { id: p.exceptionId },
      });
      ensure(request?.kind === "PRIVACY", "개인정보 요청을 찾을 수 없습니다.");
      ensure(
        ["OPEN", "REVIEWING"].includes(request.status),
        "이미 종료된 요청입니다.",
      );
      await tx.exceptionCase.update({
        where: { id: request.id },
        data: {
          status: p.decision,
          resolution: p.note,
          assignedTo: actor.id,
          resolvedAt: p.decision === "REJECTED" ? new Date() : null,
        },
      });
      await audit(
        tx,
        actor.id,
        "PRIVACY_REVIEWED",
        request.objectId,
        undefined,
        { requestId: request.id, decision: p.decision, note: p.note },
      );
      await notify(
        tx,
        request.objectId,
        `privacy-review:${randomUUID()}`,
        "개인정보 요청 검토 안내",
        `${p.note}\n현재 검토 상태 안내이며 삭제·탈퇴 완료 통지가 아닙니다.`,
        "/app?tab=mine",
      );
    } else if (action === "allocationException") {
      admin(actor);
      const p = z
        .object({
          tableIds: z.array(id).min(1).max(12),
          reason: z.string().trim().min(5).max(500),
        })
        .parse(input);
      const tables = await tx.diningTable.findMany({
        where: {
          id: { in: p.tableIds },
          status: "CONFIRMED",
          event: { startsAt: { gt: new Date() } },
        },
      });
      ensure(
        tables.length === new Set(p.tableIds).size,
        "시작 전 확정 식탁의 예외만 등록할 수 있습니다.",
      );
      for (const table of tables) {
        const incident = await tx.exceptionCase.upsert({
          where: { key: `allocation:${table.id}` },
          create: {
            key: `allocation:${table.id}`,
            kind: "ALLOCATION",
            objectId: table.id,
            reason: p.reason,
            assignedTo: actor.id,
          },
          update: {
            reason: p.reason,
            status: "OPEN",
            resolvedAt: null,
            resolution: null,
            assignedTo: actor.id,
          },
        });
        await audit(
          tx,
          actor.id,
          "ALLOCATION_EXCEPTION_REPORTED",
          table.id,
          undefined,
          {
            exceptionId: incident.id,
            reason: p.reason,
            evidence: "OPERATOR_REPORTED",
          },
        );
      }
    } else if (action === "manualAllocationPreview") {
      result = await previewManualAllocation(tx, actor, input);
    } else if (action === "manualAllocationCommit") {
      result = await commitManualAllocation(tx, actor, input);
    } else if (
      [
        "waitlistJoin",
        "waitlistWithdraw",
        "waitlistRespond",
        "waitlistSetting",
      ].includes(action)
    ) {
      result = await waitlistCommand(tx, actor, action, input);
    } else if (action === "profile") {
      const { name, consent, ...p } = profileSchema.parse(input);
      await tx.user.update({ where: { id: actor.id }, data: { name } });
      await tx.profile.upsert({
        where: { userId: actor.id },
        create: {
          ...p,
          userId: actor.id,
          consentVersion: "2026-10-v1",
          consentAt: new Date(),
        },
        update: { ...p, consentVersion: "2026-10-v1", consentAt: new Date() },
      });
      await audit(tx, actor.id, "PROFILE_UPDATED", actor.id, undefined, {
        consentVersion: "2026-10-v1",
      });
    } else if (action === "draft") {
      const p = z.object({ requestId: id }).parse(input);
      ensure(
        account.restriction === "NONE" || account.restriction === "WARNING",
        "현재 참가가 제한된 계정입니다.",
      );
      const existing = await tx.application.findUnique({
        where: { id: p.requestId },
      });
      if (existing) {
        ensure(existing.userId === actor.id, "잘못된 신청입니다.", 403);
        return existing;
      }
      result = await tx.application.create({
        data: { id: p.requestId, userId: actor.id, ticketType: "SINGLE" },
      });
    } else if (action === "apply") {
      const p = z
        .object({
          requestId: id,
          eventIds: z.array(id).min(1).max(12),
          ticketType: z.enum([
            "SINGLE",
            "TRIPLE",
            "EXISTING",
            "MEMBERSHIP_1",
            "MEMBERSHIP_3",
            "MEMBERSHIP_6",
          ]),
          consent: z.literal(true),
        })
        .parse(input);
      ensure(
        account.restriction === "NONE" || account.restriction === "WARNING",
        "현재 참가가 제한된 계정입니다.",
      );
      const profile = await tx.profile.findUnique({
        where: { userId: actor.id },
      });
      ensure(profile, "프로필과 개인정보 동의를 먼저 완료해 주세요.");
      const events = await tx.eventSlot.findMany({
        where: {
          id: { in: p.eventIds },
          status: "OPEN",
          closesAt: { gt: new Date() },
        },
      });
      ensure(
        events.length === new Set(p.eventIds).size,
        "모집이 마감되었거나 유효하지 않은 일정입니다.",
      );
      const existing = await tx.application.findUnique({
        where: { id: p.requestId },
      });
      ensure(
        !existing || existing.userId === actor.id,
        "잘못된 신청입니다.",
        403,
      );
      if (existing && existing.applicationStatus !== "DRAFT") return existing;
      const data = {
        userId: actor.id,
        ticketType: p.ticketType,
        ticketOffer: { ...ticketOffer(p.ticketType) },
        applicationStatus: "SUBMITTED" as const,
        options: { create: events.map((e) => ({ eventId: e.id })) },
      };
      result = await tx.application.upsert({
        where: { id: p.requestId },
        create: { id: p.requestId, ...data },
        update: data,
      });
      await notify(
        tx,
        actor.id,
        `submitted:${p.requestId}`,
        "신청서가 도착했어요",
        applicationNotice(events, p.ticketType, ticketOffer(p.ticketType)),
        `/app?tab=detail&application=${encodeURIComponent(p.requestId)}`,
      );
      await notify(
        tx,
        actor.id,
        `payment-pending:${p.requestId}`,
        "참가권 결제 대기",
        pendingPaymentNotice(events, p.ticketType),
        `/app?tab=detail&application=${encodeURIComponent(p.requestId)}`,
      );
      await audit(
        tx,
        actor.id,
        "APPLICATION_SUBMITTED",
        p.requestId,
        undefined,
        {
          eventIds: p.eventIds,
          ticketType: p.ticketType,
          consentVersion: profile.consentVersion,
        },
      );
    } else if (action === "pay") {
      const p = z
        .object({
          applicationId: id,
          requestId: id,
          simulateFailure: z.boolean().default(false),
        })
        .parse(input);
      const a = await application(tx, actor, p.applicationId);
      ensure(a.applicationStatus === "SUBMITTED", "유효한 신청이 아닙니다.");
      if (a.paymentStatus === "PAID") return { ok: true };
      ensure(
        ["PENDING", "FAILED"].includes(a.paymentStatus),
        "이미 처리된 결제입니다.",
      );
      ensure(
        account.restriction === "NONE" || account.restriction === "WARNING",
        "현재 참가가 제한된 계정입니다.",
      );
      ensure(
        a.options.some(
          (x) => x.event.status === "OPEN" && x.event.closesAt > new Date(),
        ),
        "신청 마감으로 결제할 수 없습니다.",
      );
      const previous = await tx.payment.findUnique({
        where: { key: p.requestId },
      });
      if (previous) {
        ensure(previous.applicationId === a.id, "잘못된 결제 요청입니다.");
        return previous;
      }
      const offer = savedTicketOffer(a.ticketType, a.ticketOffer);
      const amount = offer.amount;
      if (p.simulateFailure) {
        ensure(process.env.DEMO_MODE === "true", "시연 환경에서만 가능합니다.");
        await tx.payment.create({
          data: {
            applicationId: a.id,
            amount,
            status: "FAILED",
            key: p.requestId,
          },
        });
        await tx.application.update({
          where: { id: a.id },
          data: { paymentStatus: "FAILED" },
        });
        await audit(tx, actor.id, "PAYMENT_FAILED", a.id);
        return { ok: true };
      }
      let lot: { paymentId: string | null; expiresAt: Date | null };
      const payment = await tx.payment.create({
        data: {
          applicationId: a.id,
          amount,
          status: "PAID",
          method: a.ticketType === "EXISTING" ? "TICKET" : "MOCK_CARD",
          key: p.requestId,
        },
      });
      if (a.ticketType === "EXISTING") {
        const lots = await balance(tx, actor.id);
        ensure(lots.length, "사용 가능한 이용권이 없습니다.");
        const eligible = lots.find((l) =>
          a.options.every((o) => coversEvent(l.expiresAt, o.event.startsAt)),
        );
        ensure(eligible, "선택한 모든 행사 시작까지 유효한 이용권이 없습니다.");
        lot = eligible;
      } else {
        const expiresAt = ticketExpiry(new Date(), offer.months);
        ensure(
          a.options.every((o) => coversEvent(expiresAt, o.event.startsAt)),
          "이용권 만료 전 시작하는 일정을 선택해 주세요.",
        );
        lot = { paymentId: payment.id, expiresAt };
        await tx.ticketEntry.create({
          data: {
            userId: actor.id,
            applicationId: a.id,
            paymentId: payment.id,
            expiresAt,
            kind: "PURCHASE",
            units: offer.units,
            key: `purchase:${payment.id}`,
          },
        });
      }
      await tx.ticketEntry.create({
        data: {
          ...lot,
          userId: actor.id,
          applicationId: a.id,
          kind: "RESERVE",
          units: -1,
          key: `reserve:${a.id}`,
        },
      });
      await tx.application.update({
        where: { id: a.id },
        data: { paymentStatus: "PAID" },
      });
      await notify(
        tx,
        actor.id,
        `paid:${a.id}`,
        "참가 준비가 끝났어요",
        `결제가 완료되었어요. 선택한 일정의 자동 매칭 결과를 안내할게요.\n${matchScheduleNotice(a.options.map((option) => option.event))}`,
        `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
      );
      await audit(
        tx,
        actor.id,
        "PAYMENT_COMPLETED",
        a.id,
        { status: a.paymentStatus },
        { status: "PAID", paymentId: payment.id },
      );
    } else if (action === "resolve") {
      const p = z
        .object({
          applicationId: id,
          choice: z.enum(["TRANSFER", "KEEP", "REFUND"]),
          eventId: id.optional(),
        })
        .parse(input);
      const a = await application(tx, actor, p.applicationId);
      if (a.resolution) {
        ensure(
          a.resolution === p.choice,
          "이미 다른 해결 방법이 처리되었습니다.",
          409,
        );
        return { ok: true };
      }
      ensure(
        ["ALTERNATIVE_OFFERED", "NO_MATCH", "EXCEPTION"].includes(
          a.matchStatus,
        ),
        "현재 해결 방법을 선택할 수 없습니다.",
      );
      if (await membershipPurchaseFor(tx, a.id)) {
        ensure(
          p.choice !== "REFUND" || a.ticketType === "EXISTING",
          "멤버십은 매칭에 실패하면 환불 대신 이용 기한이 연장돼요. 일정 이동이나 보관을 선택해 주세요.",
        );
        await extendMembershipForFailure(tx, a.id);
      }
      await withdrawWaitlist(tx, a.id);
      if (p.choice === "TRANSFER") {
        ensure(p.eventId, "이동할 일정을 선택해 주세요.");
        const e = await tx.eventSlot.findUnique({ where: { id: p.eventId } });
        ensure(
          e && e.status === "OPEN" && e.closesAt > new Date(),
          "이동할 수 없는 일정입니다.",
        );
        const expiry = (await reservationExpiries(tx, [a.id])).get(a.id);
        ensure(
          coversEvent(expiry, e.startsAt),
          "이용권 만료 전 시작하는 일정으로 이동해 주세요.",
        );
        const eligibility = (await suitableAlternatives(tx, a.id)).find(
          (item) => item.id === e.id,
        );
        ensure(
          eligibility &&
            !["INELIGIBLE", "UNAVAILABLE"].includes(eligibility.status),
          "겹치는 일정·이용권 기간·현재 식당 재고를 확인해 주세요.",
        );
        await audit(
          tx,
          actor.id,
          "MATCH_TRANSFERRED",
          a.id,
          {
            matchStatus: a.matchStatus,
            eventIds: a.options.map((x) => x.eventId),
          },
          { matchStatus: "TRANSFERRED", eventId: e.id },
        );
        await tx.applicationOption.deleteMany({
          where: { applicationId: a.id },
        });
        await tx.applicationOption.create({
          data: { applicationId: a.id, eventId: e.id },
        });
        await tx.application.update({
          where: { id: a.id },
          data: {
            matchStatus: "WAITING",
            paymentStatus: "PAID",
            resolution: null,
            reason: "선택한 새 일정으로 이동했어요.",
            deferredCount: Math.max(1, a.deferredCount),
            lastDeferredDate: null,
          },
        });
        await notify(
          tx,
          actor.id,
          `transfer:${a.id}:${e.id}`,
          "새 일정으로 이동했어요",
          `기존 결제는 유지됩니다. 변경된 일정의 매칭 결과를 기다려 주세요.\n${matchScheduleNotice([e])}\n${cancellationNotice(e.cancelRefundCutoffAt)}`,
          `/app?tab=detail&application=${encodeURIComponent(a.id)}`,
        );
      } else {
        if (p.choice === "KEEP") {
          await releaseTicket(tx, a.id);
          await tx.application.update({
            where: { id: a.id },
            data: {
              resolution: "KEEP",
              applicationStatus: "CANCELED",
              reason: "이용권이 보관되었어요.",
            },
          });
        } else {
          await requestRefund(tx, a.id, "SERVICE_NO_MATCH");
          await tx.application.update({
            where: { id: a.id },
            data: { resolution: "REFUND", applicationStatus: "CANCELED" },
          });
        }
        await audit(tx, actor.id, `RESOLUTION_${p.choice}`, a.id);
      }
    } else if (action === "cancel") {
      const p = z.object({ applicationId: id }).parse(input);
      const a = await application(tx, actor, p.applicationId);
      ensure(
        a.attendanceStatus === "SCHEDULED" ||
          a.applicationStatus === "CANCELED",
        "참석 결과가 기록된 신청은 취소할 수 없습니다.",
      );
      ensure(
        !a.table || a.table.event.endsAt > new Date(),
        "종료된 모임의 참석 기록은 운영자 확인을 통해 정정할 수 있습니다.",
      );
      if (a.applicationStatus === "CANCELED") return { ok: true };
      ensure(
        !a.table || !isMeetingDayOrLater(a.table.event.startsAt),
        "행사 당일에는 직접 취소하거나 단체방을 나갈 수 없습니다. 실제 불참·안전 문제는 운영자에게 알려 주세요.",
      );
      await withdrawWaitlist(tx, a.id);
      const canceledAt = new Date();
      const late = isCancellationRestricted(cancellationCutoff(a), canceledAt);
      if (a.paymentStatus === "PAID" && !late)
        await requestRefund(tx, a.id, "VOLUNTARY_EARLY");
      await tx.application.update({
        where: { id: a.id },
        data: {
          applicationStatus: "CANCELED",
          attendanceStatus: late ? "CANCELED_LATE" : "CANCELED_EARLY",
          reason: late
            ? "취소가 기록되었어요. 취소 제한 시점 이후에는 변심 환불이 제한됩니다."
            : "사전 취소가 처리되었어요.",
        },
      });
      if (a.tableId) await invalidateTable(tx, a.tableId, actor.id);
      await audit(tx, actor.id, "APPLICATION_CANCELED", a.id, undefined, {
        late,
        eventId: a.table?.eventId ?? null,
        eventStartsAt: a.table?.event.startsAt ?? null,
        canceledAt,
      });
    } else if (action === "checkin") {
      const p = z.object({ applicationId: id }).parse(input);
      const a = await application(tx, actor, p.applicationId);
      ensure(
        a.table &&
          a.table.status === "CONFIRMED" &&
          a.matchStatus === "CONFIRMED" &&
          a.applicationStatus === "SUBMITTED",
        "확정된 모임에서만 체크인할 수 있습니다.",
      );
      ensure(
        new Date() >=
          new Date(a.table.event.startsAt.getTime() - 60 * 60 * 1000) &&
          new Date() <=
            new Date(a.table.event.endsAt.getTime() + 24 * 60 * 60 * 1000),
        "체크인은 시작 1시간 전부터 종료 다음 날까지 가능합니다.",
      );
      await tx.application.update({
        where: { id: a.id },
        data: { attendanceStatus: "ATTENDED", attendanceReviewRequired: false },
      });
      await audit(tx, actor.id, "CHECKED_IN", a.id);
      await syncMeetingHistory(tx, a.table.id);
    } else if (action === "feedback") {
      const p = z
        .object({
          applicationId: id,
          atmosphere: z.number().int().min(1).max(5),
          conversation: z.number().int().min(1).max(5),
          venue: z.number().int().min(1).max(5),
          returnIntent: z.boolean(),
          recommend: z.number().int().min(0).max(10),
          comment: z.string().max(1000),
          liked: z.array(id).max(6),
          avoided: z.array(id).max(6),
        })
        .parse(input);
      const a = await application(tx, actor, p.applicationId);
      ensure(
        a.table &&
          a.table.event.endsAt <= new Date() &&
          a.attendanceStatus === "ATTENDED",
        "참석한 모임이 끝난 뒤 작성할 수 있어요.",
      );
      const peers = await tx.application.findMany({
        where: { tableId: a.tableId, matchStatus: "CONFIRMED" },
      });
      const valid = new Set(
        peers.map((x) => x.userId).filter((x) => x !== actor.id),
      );
      ensure(
        [...p.liked, ...p.avoided].every((x) => valid.has(x)) &&
          !p.liked.some((x) => p.avoided.includes(x)),
        "사람별 선호를 다시 확인해 주세요.",
      );
      const { liked, avoided, ...f } = p;
      await tx.feedback.upsert({
        where: { applicationId: a.id },
        create: f,
        update: f,
      });
      await tx.relationship.deleteMany({
        where: {
          sourceId: a.id,
          fromId: actor.id,
          kind: { in: ["LIKE", "AVOID"] },
        },
      });
      for (const [kind, ids] of [
        ["LIKE", liked],
        ["AVOID", avoided],
      ] as const)
        for (const toId of ids)
          await tx.relationship.create({
            data: { fromId: actor.id, toId, kind, sourceId: a.id },
          });
      await audit(tx, actor.id, "FEEDBACK_SAVED", a.id);
    } else if (action === "message") {
      const p = z
        .object({
          roomId: id,
          body: z.string().trim().min(1).max(2000),
          requestId: id,
        })
        .parse(input);
      const room = await tx.chatRoom.findUnique({
        where: { id: p.roomId },
        include: { table: { include: { applications: true } } },
      });
      ensure(
        room &&
          room.table.status === "CONFIRMED" &&
          room.table.applications.some(
            (a) =>
              a.userId === actor.id &&
              a.applicationStatus === "SUBMITTED" &&
              a.matchStatus === "CONFIRMED",
          ),
        "참여 중인 단체방이 아닙니다.",
        403,
      );
      const blocked = await tx.relationship.findMany({
        where: {
          active: true,
          kind: { in: ["BLOCK", "REPORT"] },
          OR: [{ fromId: actor.id }, { toId: actor.id }],
        },
      });
      ensure(
        !blocked.some((r) =>
          room.table.applications.some(
            (a) => a.userId === (r.fromId === actor.id ? r.toId : r.fromId),
          ),
        ),
        "안전 조치 중인 단체방에서는 메시지를 보낼 수 없습니다.",
      );
      result = await tx.message.upsert({
        where: { key: `chat:${actor.id}:${p.requestId}` },
        create: {
          roomId: p.roomId,
          userId: actor.id,
          body: p.body,
          key: `chat:${actor.id}:${p.requestId}`,
        },
        update: {},
      });
    } else if (action === "report" || action === "block") {
      const p = z
        .object({
          applicationId: id,
          targetId: id,
          reason: text,
          evidence: z.string().max(2000).optional(),
        })
        .parse(input);
      const a = await application(tx, actor, p.applicationId);
      ensure(a.tableId && p.targetId !== actor.id, "잘못된 대상입니다.");
      const peer = await tx.application.findFirst({
        where: { tableId: a.tableId, userId: p.targetId },
      });
      ensure(peer, "같은 모임의 참가자만 선택할 수 있습니다.");
      if (action === "report") {
        const report = await tx.safetyReport.create({
          data: { reporterId: actor.id, ...p },
        });
        await tx.relationship.create({
          data: {
            fromId: actor.id,
            toId: p.targetId,
            kind: "REPORT",
            sourceId: report.id,
          },
        });
        await tx.exceptionCase.create({
          data: {
            key: `report:${report.id}`,
            kind: "SAFETY",
            objectId: report.id,
            reason: "검토가 필요한 안전 신고",
          },
        });
      } else
        await tx.relationship.upsert({
          where: {
            fromId_toId_kind_sourceId: {
              fromId: actor.id,
              toId: p.targetId,
              kind: "BLOCK",
              sourceId: a.id,
            },
          },
          create: {
            fromId: actor.id,
            toId: p.targetId,
            kind: "BLOCK",
            sourceId: a.id,
          },
          update: { active: true },
        });
      // Protect an upcoming or ongoing meeting immediately, including other
      // already-confirmed tables shared by this pair. Past attendance remains.
      const shared = await tx.diningTable.findMany({
        where: {
          status: "CONFIRMED",
          event: { endsAt: { gt: new Date() } },
          AND: [actor.id, p.targetId].map((userId) => ({
            applications: {
              some: {
                userId,
                applicationStatus: "SUBMITTED",
                matchStatus: "CONFIRMED",
              },
            },
          })),
        },
        select: { id: true },
      });
      for (const table of shared)
        await invalidateTable(tx, table.id, actor.id, true);
      await audit(tx, actor.id, action.toUpperCase(), a.id);
    } else if (action === "readNotifications") {
      await tx.notification.updateMany({
        where: { userId: actor.id, readAt: null },
        data: { readAt: new Date() },
      });
    } else if (action === "subscribe") {
      const p = z
        .object({
          endpoint: z.url().startsWith("https://").max(2000),
          keys: z.object({
            p256dh: z.string().min(1).max(300),
            auth: z.string().min(1).max(300),
          }),
        })
        .parse(input);
      const host = new URL(p.endpoint).hostname;
      ensure(
        [
          "fcm.googleapis.com",
          "updates.push.services.mozilla.com",
          "web.push.apple.com",
        ].some((h) => host === h || host.endsWith("." + h)),
        "지원되는 푸시 서비스가 아닙니다.",
      );
      await tx.pushSubscription.upsert({
        where: { endpoint: p.endpoint },
        create: { userId: actor.id, endpoint: p.endpoint, ...p.keys },
        update: { userId: actor.id, ...p.keys },
      });
    } else if (action === "unsubscribe") {
      const p = z.object({ endpoint: z.url().max(2000) }).parse(input);
      await tx.pushSubscription.deleteMany({
        where: { userId: actor.id, endpoint: p.endpoint },
      });
    } else if (action === "event") {
      admin(actor);
      const p = eventSchema.parse(input);
      const dates = {
        startsAt: new Date(p.startsAt),
        endsAt: new Date(p.endsAt),
        closesAt: new Date(p.closesAt),
        matchAt: new Date(p.matchAt),
        cancelRefundCutoffAt: new Date(p.cancelRefundCutoffAt),
      };
      ensure(
        dates.closesAt <= dates.matchAt &&
          dates.matchAt < dates.startsAt &&
          dates.startsAt < dates.endsAt &&
          dates.cancelRefundCutoffAt <= dates.startsAt,
        "마감 → 매칭 → 시작 → 종료 순서를 확인해 주세요.",
      );
      const e = await tx.eventSlot.create({ data: { ...p, ...dates } });
      await enqueue(tx, `match:${e.id}`, "MATCH", { eventId: e.id }, e.matchAt);
      result = e;
      await audit(tx, actor.id, "EVENT_CREATED", e.id);
      await notifyNewEvent(tx, e);
    } else if (action === "venue") {
      admin(actor);
      const p = z
        .object({
          eventId: id,
          name: text,
          address: text,
          mapUrl: z.url().startsWith("https://"),
          reservationName: text,
          price: z.number().int().min(0).max(1000000),
          capacity: z.number().int().min(4).max(6),
          totalTables: z.number().int().min(1).max(100),
          dietaryNotes: z.string().max(500),
        })
        .parse(input);
      ensure(
        await tx.eventSlot.findUnique({ where: { id: p.eventId } }),
        "회차를 찾을 수 없습니다.",
      );
      result = await tx.venueSlot.create({ data: { ...p, demo: true } });
      await audit(tx, actor.id, "VENUE_CREATED", p.eventId);
    } else if (action === "recordLateCancellation") {
      admin(actor);
      const p = z.object({ applicationId: id, reason: text }).parse(input);
      const a = await tx.application.findUnique({
        where: { id: p.applicationId },
        include: { table: { include: { event: true } } },
      });
      ensure(
        a?.table &&
          isMeetingDayOrLater(a.table.event.startsAt) &&
          a.table.event.endsAt > new Date(),
        "행사 당일 종료 전 실제 취소만 기록할 수 있습니다.",
      );
      if (a.applicationStatus === "CANCELED") return { ok: true };
      ensure(
        a.applicationStatus === "SUBMITTED" &&
          a.attendanceStatus === "SCHEDULED",
        "참석 예정인 신청만 기록할 수 있습니다.",
      );
      await tx.application.update({
        where: { id: a.id },
        data: {
          applicationStatus: "CANCELED",
          attendanceStatus: "CANCELED_LATE",
          reason: `운영자가 실제 당일 취소를 기록했어요. ${p.reason}`,
        },
      });
      await audit(tx, actor.id, "APPLICATION_CANCELED", a.id, undefined, {
        late: true,
        source: "OPERATOR_RECORDED",
        reason: p.reason,
        eventId: a.table.eventId,
        eventStartsAt: a.table.event.startsAt,
        canceledAt: new Date(),
      });
      await invalidateTable(tx, a.tableId!, actor.id);
    } else if (action === "attendance") {
      admin(actor);
      const p = z
        .object({
          applicationId: id,
          status: z.enum(["ATTENDED", "NO_SHOW"]),
          reason: text,
        })
        .parse(input);
      const a = await tx.application.findUnique({
        where: { id: p.applicationId },
        include: { table: { include: { event: true } } },
      });
      ensure(
        a?.attendanceReviewRequired &&
          a.table &&
          a.table.event.endsAt <= new Date(),
        "노쇼 후보만 검토할 수 있습니다.",
      );
      await tx.application.update({
        where: { id: a.id },
        data: { attendanceStatus: p.status, attendanceReviewRequired: false },
      });
      await audit(
        tx,
        actor.id,
        "ATTENDANCE_REVIEWED",
        a.id,
        { status: a.attendanceStatus },
        { status: p.status, reason: p.reason },
      );
      await syncMeetingHistory(tx, a.table.id);
    } else if (action === "reviewReport") {
      admin(actor, "safety");
      const p = z
        .object({
          reportId: id,
          action: z.enum(["DISMISS", "WARNING", "RESTRICTED", "BANNED"]),
          note: text,
          seconds: z.number().int().min(0).max(86400).default(0),
        })
        .parse(input);
      const r = await tx.safetyReport.findUnique({ where: { id: p.reportId } });
      ensure(r, "신고를 찾을 수 없습니다.");
      ensure(r.status !== "REVIEWED", "이미 검토 결과가 저장된 신고입니다.");
      await tx.safetyReport.update({
        where: { id: r.id },
        data: { status: "REVIEWED", action: p.action, reviewedBy: actor.id },
      });
      if (p.action === "DISMISS")
        await tx.relationship.updateMany({
          where: { sourceId: r.id, kind: "REPORT" },
          data: { active: false },
        });
      else {
        const target = await tx.user.findUniqueOrThrow({
          where: { id: r.targetId },
        });
        const levels = ["NONE", "WARNING", "RESTRICTED", "BANNED"];
        await tx.user.update({
          where: { id: r.targetId },
          data: {
            restriction:
              target.restriction === "WITHDRAWN"
                ? "WITHDRAWN"
                : levels[
                    Math.max(
                      levels.indexOf(target.restriction),
                      levels.indexOf(p.action),
                    )
                  ],
          },
        });
      }
      await tx.exceptionCase.updateMany({
        where: { objectId: r.id, kind: "SAFETY" },
        data: {
          status: "RESOLVED",
          assignedTo: actor.id,
          resolution: p.note,
          resolvedAt: new Date(),
          handlingSeconds: p.seconds,
        },
      });
      await audit(tx, actor.id, "SAFETY_REVIEWED", r.id, undefined, p);
    } else if (action === "retryMatch") {
      admin(actor);
      const p = z.object({ exceptionId: id }).parse(input);
      const ex = await tx.exceptionCase.findUnique({
        where: { id: p.exceptionId },
      });
      ensure(
        ex &&
          ex.status === "OPEN" &&
          ["VENUE", "DATA", "MATCHING", "CONDITION"].includes(ex.kind),
        "재시도할 매칭 예외가 없습니다.",
      );
      const solverIssue =
        ex.kind === "MATCHING" && ex.key.startsWith("matching-solver:");
      const personIssue =
        ex.kind === "DATA" ||
        ex.kind === "CONDITION" ||
        (ex.kind === "MATCHING" && !solverIssue);
      const affected = await tx.application.findMany({
        where: {
          applicationStatus: "SUBMITTED",
          tableId: null,
          resolution: null,
          attendanceStatus: "SCHEDULED",
          paymentStatus: { in: ["PAID", "REFUND_AVAILABLE"] },
          matchStatus: {
            in: solverIssue
              ? ["WAITING", "MATCHING", "REALLOCATING"]
              : ["MATCHING", "CONDITION"].includes(ex.kind)
                ? ["EXCEPTION", "ALTERNATIVE_OFFERED"]
                : ["EXCEPTION"],
          },
          ...(personIssue
            ? { id: ex.objectId }
            : { options: { some: { eventId: ex.objectId } } }),
        },
        include: {
          options: { include: { event: true } },
          user: { include: { profile: true } },
        },
      });
      ensure(
        affected.every((a) => !!a.user.profile?.consentAt),
        "누락된 프로필과 동의를 먼저 보완해 주세요.",
      );
      const solverEvent = solverIssue
        ? await tx.eventSlot.findFirst({
            where: {
              id: ex.objectId,
              startsAt: { gt: new Date() },
              status: { in: ["OPEN", "MATCHED"] },
            },
          })
        : null;
      // Retry the failed solver scope, not every later option of its applicants.
      // Explicit MATCH jobs can run before matchAt, so broadening here would
      // prematurely close a still-recruiting future event.
      const events = solverIssue
        ? solverEvent
          ? [solverEvent.id]
          : []
        : [
            ...new Set(
              affected.flatMap((a) =>
                a.options
                  .filter(
                    (o) =>
                      o.event.startsAt > new Date() &&
                      ["OPEN", "MATCHED"].includes(o.event.status),
                  )
                  .map((o) => o.eventId),
              ),
            ),
          ];
      ensure(
        events.length,
        "다시 매칭할 수 있는 미래 일정이 없습니다. 참가자의 이동·보관·환불 선택을 확인해 주세요.",
      );
      if (ex.kind === "VENUE")
        ensure(
          await tx.venueSlot.count({ where: { eventId: ex.objectId } }),
          "식당 재고를 먼저 추가해 주세요.",
        );
      await tx.application.updateMany({
        where: { id: { in: affected.map((a) => a.id) } },
        data: {
          matchStatus: "WAITING",
          paymentStatus: "PAID",
          lastDeferredDate: null,
        },
      });
      for (const eventId of events)
        await enqueue(tx, `retry-match:${ex.id}:${randomUUID()}`, "MATCH", {
          eventId,
        });
      await audit(tx, actor.id, "MATCH_RETRY", ex.objectId, undefined, {
        exceptionId: ex.id,
      });
    } else if (action === "retryJob") {
      admin(actor);
      const p = z.object({ jobId: id }).parse(input);
      const job = await tx.job.findUnique({ where: { id: p.jobId } });
      ensure(
        job && job.status === "FAILED",
        "실패한 작업만 재시도할 수 있습니다.",
      );
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          attempts: 0,
          runAt: new Date(),
          lockedAt: null,
        },
      });
      await audit(tx, actor.id, "JOB_RETRY", job.id);
    } else if (action === "resolveException") {
      admin(actor, "all");
      const p = z
        .object({
          exceptionId: id,
          note: text,
          seconds: z.number().int().min(0).max(86400),
        })
        .parse(input);
      const ex = await tx.exceptionCase.findUnique({
        where: { id: p.exceptionId },
      });
      ensure(ex, "예외를 찾을 수 없습니다.");
      ensure(
        ex.kind !== "PRIVACY",
        "개인정보 요청 전용 검토에서 처리해 주세요.",
      );
      ensure(ex.status !== "RESOLVED", "이미 해결 결과가 저장된 예외입니다.");
      admin(actor, ex.kind === "SAFETY" ? "safety" : "operations");
      ensure(ex.kind !== "SAFETY", "안전 신고 검토에서 처리해 주세요.");
      if (ex.kind === "JOB") {
        const job = await tx.job.findUnique({ where: { id: ex.objectId } });
        ensure(
          job?.status === "DONE",
          "원인 작업이 성공한 뒤 해결 처리할 수 있습니다.",
        );
      }
      if (["VENUE", "DATA"].includes(ex.kind)) {
        const waiting = await tx.application.count({
          where: {
            applicationStatus: "SUBMITTED",
            matchStatus: { in: ["WAITING", "EXCEPTION", "REALLOCATING"] },
            ...(ex.kind === "DATA"
              ? { id: ex.objectId }
              : { options: { some: { eventId: ex.objectId } } }),
          },
        });
        ensure(
          !waiting,
          "매칭 재시도 결과 또는 참가자의 해결 선택이 완료된 뒤 기록해 주세요.",
        );
      }
      await tx.exceptionCase.update({
        where: { id: ex.id },
        data: {
          status: "RESOLVED",
          resolution: p.note,
          assignedTo: actor.id,
          handlingSeconds: p.seconds,
          resolvedAt: new Date(),
        },
      });
      await audit(tx, actor.id, "EXCEPTION_RESOLVED", ex.objectId, undefined, {
        exceptionId: ex.id,
        seconds: p.seconds,
      });
    } else if (action === "setting") {
      admin(actor);
      const p = z
        .object({
          key: z.enum([
            "notificationTemplates",
            "automation",
            "matchingPolicy",
          ]),
          value: z.record(z.string(), z.unknown()),
        })
        .parse(input);
      if (p.key === "automation")
        z.object({
          retrySeconds: z.number().int().min(1).max(3600),
          maxAttempts: z.number().int().min(1).max(10),
        }).parse(p.value);
      const previous = await tx.setting.findUnique({ where: { key: p.key } });
      if (p.key === "matchingPolicy") {
        const requested = policySchema.strict().parse(p.value);
        ensure(
          isFixedPolicy(requested),
          "현재 매칭 기준은 최소 20점과 정해진 가중치로 고정되어 있어요.",
        );
        p.value = policySchema.parse({});
      }
      if (p.key === "notificationTemplates") {
        const template = z.string().trim().min(1).max(1000);
        const changes = z
          .object({
            curation: template.optional(),
            reminder: template.optional(),
            alternative: template.optional(),
          })
          .strict()
          .refine((value) => Object.keys(value).length > 0)
          .parse(p.value);
        p.value = { ...notificationTemplates(previous?.value), ...changes };
      }
      await tx.setting.upsert({
        where: { key: p.key },
        create: { key: p.key, value: JSON.parse(JSON.stringify(p.value)) },
        update: { value: JSON.parse(JSON.stringify(p.value)) },
      });
      await audit(
        tx,
        actor.id,
        "SETTING_UPDATED",
        p.key,
        previous?.value,
        p.value,
      );
    } else if (action === "demoAdvance") {
      admin(actor);
      ensure(process.env.DEMO_MODE === "true", "시연 환경에서만 가능합니다.");
      const p = z
        .object({ eventId: id, phase: z.enum(["MATCH", "START", "END"]) })
        .parse(input);
      const e = await tx.eventSlot.findUnique({ where: { id: p.eventId } });
      ensure(e, "회차를 찾을 수 없습니다.");
      const now = new Date();
      if (p.phase === "MATCH") {
        await tx.eventSlot.update({
          where: { id: e.id },
          data: { matchAt: now, closesAt: now },
        });
        await tx.job.upsert({
          where: { key: `match:${e.id}` },
          create: {
            key: `match:${e.id}`,
            kind: "MATCH",
            payload: { eventId: e.id },
            runAt: now,
          },
          update: { runAt: now },
        });
      } else {
        const date =
          p.phase === "START"
            ? { startsAt: new Date(now.getTime() - 1000) }
            : { endsAt: new Date(now.getTime() - 1000) };
        await tx.eventSlot.update({ where: { id: e.id }, data: date });
        const tables = await tx.diningTable.findMany({
          where: { eventId: e.id, status: "CONFIRMED" },
        });
        for (const t of tables)
          await tx.job.upsert({
            where: { key: `${p.phase.toLowerCase()}:${t.id}` },
            create: {
              key: `${p.phase.toLowerCase()}:${t.id}`,
              kind: p.phase,
              payload: { tableId: t.id },
              runAt: now,
            },
            update: { runAt: now },
          });
      }
      await audit(tx, actor.id, "DEMO_TIME_CHANGED", e.id, undefined, p);
    } else throw new AppError("지원하지 않는 작업입니다.");
    return result;
  });
}
