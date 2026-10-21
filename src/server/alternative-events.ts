import type { Candidate } from "@/domain/matching";
import type { Tx } from "./db";
import {
  allocationContext,
  evaluateAllocation,
  matchDay,
} from "./matching-policy";
import { coversEvent, reservationExpiries } from "./ticket-eligibility";

// AI-04: bounded feasibility, never a promise of a future allocation.
export async function suitableAlternatives(
  tx: Tx,
  applicationId: string,
  excludedEventId?: string,
) {
  const applicant = await tx.application.findUnique({
    where: { id: applicationId },
    include: { user: { include: { profile: true } } },
  });
  if (
    !applicant?.user.profile ||
    !["NONE", "WARNING"].includes(applicant.user.restriction)
  )
    return [];
  const events = await tx.eventSlot.findMany({
    where: {
      id: excludedEventId ? { not: excludedEventId } : undefined,
      status: "OPEN",
      closesAt: { gt: new Date() },
      startsAt: { gt: new Date() },
    },
    include: {
      venues: {
        include: {
          tables: {
            where: { status: { in: ["CONFIRMED", "WAITLIST_PENDING"] } },
          },
        },
      },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const occupied = await tx.diningTable.findMany({
    where: { status: { in: ["CONFIRMED", "WAITLIST_PENDING"] } },
    include: {
      event: true,
      applications: {
        where: { applicationStatus: "SUBMITTED" },
        select: { userId: true },
      },
    },
  });
  const relations = await tx.relationship.findMany({ where: { active: true } });
  const output = [];
  const selfExpiry = (await reservationExpiries(tx, [applicationId])).get(
    applicationId,
  );
  for (const event of events) {
    const base = {
      id: event.id,
      title: event.title,
      region: event.region,
      startsAt: event.startsAt,
    };
    const conflicts = new Set(
      occupied
        .filter(
          (t) =>
            t.event.startsAt < event.endsAt && t.event.endsAt > event.startsAt,
        )
        .flatMap((t) => t.applications.map((a) => a.userId)),
    );
    if (
      conflicts.has(applicant.userId) ||
      !coversEvent(selfExpiry, event.startsAt)
    ) {
      output.push({
        ...base,
        status: "INELIGIBLE",
        reason: "겹치는 확정 일정 또는 이용권 기간을 확인해 주세요.",
      });
      continue;
    }
    const held = await tx.waitlistEntry.count({
      where: { eventId: event.id, status: "OFFERED" },
    });
    const capacity =
      event.capacity -
      held -
      occupied
        .filter((t) => t.eventId === event.id)
        .reduce((n, t) => n + t.applications.length, 0);
    const maxGroup = Math.min(
      6,
      capacity,
      Math.max(
        0,
        ...event.venues
          .filter((v) => v.tables.length < v.totalTables)
          .map((v) => v.capacity),
      ),
    );
    if (maxGroup < 4) {
      output.push({
        ...base,
        status: "UNAVAILABLE",
        reason: "현재 정원 또는 식당 재고가 부족합니다.",
      });
      continue;
    }
    const peers = await tx.application.findMany({
      where: {
        userId: { not: applicant.userId },
        applicationStatus: "SUBMITTED",
        paymentStatus: "PAID",
        attendanceStatus: "SCHEDULED",
        tableId: null,
        resolution: null,
        matchStatus: { in: ["WAITING", "MATCHING", "REALLOCATING"] },
        user: {
          restriction: { in: ["NONE", "WARNING"] },
          profile: { isNot: null },
        },
        options: { some: { eventId: event.id } },
        OR: [
          { waitlist: null },
          { waitlist: { status: { notIn: ["WAITING", "OFFERED"] } } },
        ],
      },
      include: { user: { include: { profile: true } } },
      orderBy: { id: "asc" },
    });
    const expiries = await reservationExpiries(
      tx,
      peers.map((a) => a.id),
    );
    const candidate = (a: typeof applicant): Candidate => ({
      id: a.id,
      userId: a.userId,
      age:
        Number(matchDay(event.startsAt).slice(0, 4)) -
        a.user.profile!.birthYear,
      gender: a.user.profile!.gender,
      mbti: a.user.profile!.mbti,
      interests: a.user.profile!.interests,
      traits: a.user.profile!.traits,
      desiredTraits: a.user.profile!.desiredTraits,
    });
    const self = candidate(applicant);
    const pool = peers
      .filter(
        (p) =>
          !conflicts.has(p.userId) &&
          coversEvent(expiries.get(p.id), event.startsAt),
      )
      .map(candidate)
      .filter(
        (p) =>
          Math.abs(p.age - self.age) <= 8 &&
          !relations.some(
            (r) =>
              ["BLOCK", "REPORT", "AVOID"].includes(r.kind) &&
              ((r.fromId === self.userId && r.toId === p.userId) ||
                (r.toId === self.userId && r.fromId === p.userId)),
          ),
      );
    const context = await allocationContext(tx, event.startsAt, [
      self,
      ...pool,
    ]);
    let visited = 0,
      found = false,
      limited = false;
    function search(group: Candidate[], start: number) {
      if (found || limited) return;
      if (group.length >= 4) {
        if (++visited > 2000) {
          limited = true;
          return;
        }
        if (evaluateAllocation(group, relations, context).passes) {
          found = true;
          return;
        }
      }
      if (group.length >= maxGroup) return;
      for (let i = start; i < pool.length && !found && !limited; i++)
        search([...group, pool[i]], i + 1);
    }
    search([self], 0);
    output.push({
      ...base,
      status: found ? "FEASIBLE" : limited ? "UNCHECKED" : "WAITING",
      reason: found
        ? "현재 조건에 맞는 조합이 있습니다. 참가자·재고 변동에 따라 결과는 달라질 수 있어요."
        : limited
          ? "현재 후보가 많아 적합성을 확인하지 못했습니다."
          : "현재 조건에 맞는 조합이 없어 추가 신청자를 기다려야 합니다.",
    });
  }
  return output;
}
