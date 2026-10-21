import { evaluate, type Candidate, type Relation } from "@/domain/matching";
import {
  MATCHING_VERSION,
  policySchema,
  scoringContext,
  type ScoringContext,
} from "@/domain/matching-policy";
import type { Tx } from "./db";

export const matchVersion = () =>
  process.env.MATCH_EVALUATOR ?? MATCHING_VERSION;
export function matchDay(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function dateBounds(date: Date) {
  const start = new Date(`${matchDay(date)}T00:00:00+09:00`);
  return { gte: start, lt: new Date(start.getTime() + 86400000) };
}
export async function loadMatchingPolicy(_tx: Tx) {
  // Historical editable settings must not override the user-fixed runtime policy.
  // Parsing creates fresh arrays so callers cannot mutate the shared defaults.
  return policySchema.parse({});
}
export async function allocationContext(
  tx: Tx,
  eventDate: Date,
  members: Candidate[],
): Promise<ScoringContext> {
  const policy = await loadMatchingPolicy(tx);
  const rows = await tx.application.findMany({
    where: {
      applicationStatus: "SUBMITTED",
      paymentStatus: "PAID",
      tableId: null,
      matchStatus: { in: ["WAITING", "MATCHING", "REALLOCATING"] },
      OR: [
        { waitlist: null },
        { waitlist: { status: { notIn: ["WAITING", "OFFERED"] } } },
      ],
      user: {
        restriction: { in: ["NONE", "WARNING"] },
        profile: { isNot: null },
      },
      options: {
        some: {
          event: {
            startsAt: dateBounds(eventDate),
            status: { in: ["OPEN", "MATCHED"] },
          },
        },
      },
    },
    include: { user: { include: { profile: true } } },
  });
  return scoringContext(
    [
      ...rows.map((r) => ({
        userId: r.userId,
        gender: r.user.profile!.gender,
      })),
      ...members,
    ],
    policy,
  );
}
export function evaluateAllocation(
  members: Candidate[],
  relations: Relation[],
  context: ScoringContext,
  version = matchVersion(),
) {
  const evaluation = evaluate(members, relations, version, context);
  const minimum =
    version === MATCHING_VERSION
      ? context.policy.minimum
      : version === "demo-full-score-v1"
        ? 100
        : 45;
  return {
    evaluation,
    minimum,
    passes: evaluation.valid && evaluation.score >= minimum,
  };
}

/** A cancellation must not leave a below-threshold table confirmed. */
export async function retainedTableQuality(tx: Tx, tableId: string) {
  const table = await tx.diningTable.findUniqueOrThrow({
    where: { id: tableId },
    include: {
      event: true,
      applications: {
        where: {
          applicationStatus: "SUBMITTED",
          matchStatus: { in: ["CONFIRMED", "REALLOCATING"] },
        },
        include: { user: { include: { profile: true } } },
      },
    },
  });
  const year = Number(matchDay(table.event.startsAt).slice(0, 4));
  const members: Candidate[] = table.applications.map((a) => ({
    id: a.id,
    userId: a.userId,
    age: a.user.profile ? year - a.user.profile.birthYear : NaN,
    gender: a.user.profile?.gender ?? "",
    mbti: a.user.profile?.mbti ?? [],
    interests: a.user.profile?.interests ?? [],
    traits: a.user.profile?.traits ?? [],
    desiredTraits: a.user.profile?.desiredTraits ?? [],
  }));
  const relations = await tx.relationship.findMany({
    where: {
      active: true,
      fromId: { in: members.map((m) => m.userId) },
      toId: { in: members.map((m) => m.userId) },
    },
  });
  const context = await allocationContext(tx, table.event.startsAt, members);
  const snapshot = table.evaluation as { femaleTarget?: number };
  if (
    typeof snapshot.femaleTarget === "number" &&
    Number.isFinite(snapshot.femaleTarget)
  )
    context.femaleTarget = snapshot.femaleTarget;
  const quality = evaluateAllocation(members, relations, context);
  return { ...quality, members };
}
