import { z } from "zod";
import type { Candidate, Relation } from "@/domain/matching";
import {
  preferenceFulfillment,
  preferenceReasonSchema,
} from "@/domain/matching-policy";

type Audit = {
  objectId: string;
  action: string;
  after: unknown;
  createdAt: Date | string;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const timestamp = (audit: Audit | undefined, key: string) => {
  if (!audit) return null;
  const saved = record(audit.after)[key];
  return typeof saved === "string"
    ? saved
    : new Date(audit.createdAt).toISOString();
};
const historyActions = new Set([
  "MATCH_STARTED",
  "MATCH_CONFIRMED",
  "MATCH_UNRESOLVED",
  "REALLOCATED",
]);

// Count completed assignments, never search rank/attempts. Old runs did not
// record same-event repairs, so their total is explicitly unknown.
export function applicationMatchHistory(
  applicationId: string,
  audits: Audit[],
) {
  const history = audits
    .filter((a) => a.objectId === applicationId && historyActions.has(a.action))
    .toSorted(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  const reallocations = history.filter((a) => a.action === "REALLOCATED");
  const lastReallocation = reallocations.at(-1);
  const confirmation = history.findLast((a) => a.action === "MATCH_CONFIRMED");
  const failure = history.findLast((a) => a.action === "MATCH_UNRESOLVED");
  const resolution = history.findLast((a) =>
    ["MATCH_CONFIRMED", "MATCH_UNRESOLVED"].includes(a.action),
  );
  const complete =
    history.length > 0 &&
    history.every((a) => record(a.after).factsVersion === 1);
  const finalReason = record(resolution?.after).reason;
  const reallocationReason = record(lastReallocation?.after).reason;
  return {
    reallocationCount: complete ? reallocations.length : null,
    recordedReallocationCount: reallocations.length,
    lastReallocationAt: timestamp(lastReallocation, "reallocatedAt"),
    lastReallocationReason:
      typeof reallocationReason === "string" ? reallocationReason : null,
    confirmedAt: timestamp(confirmation, "confirmedAt"),
    failedAt: timestamp(failure, "failedAt"),
    finalReason: typeof finalReason === "string" ? finalReason : null,
  };
}
export type MatchHistory = ReturnType<typeof applicationMatchHistory>;
const historySchema = z.object({
  reallocationCount: z.number().int().nonnegative().nullable(),
  recordedReallocationCount: z.number().int().nonnegative(),
  lastReallocationAt: z.string().nullable(),
  lastReallocationReason: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  finalReason: z.string().nullable(),
});
const eventSchema = z.object({
  id: z.string(),
  region: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});
const factsSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  confirmedAt: z.string(),
  finalReason: z.string(),
  event: eventSchema,
  headcount: z.number().int(),
  age: z.object({ minimum: z.number(), maximum: z.number(), gap: z.number() }),
  genderComposition: z.array(
    z.object({ value: z.string(), count: z.number() }),
  ),
  mbtiComposition: z.array(z.object({ value: z.string(), count: z.number() })),
  commonInterests: z.array(
    z.object({ interest: z.string(), participantCount: z.number() }),
  ),
  priorMeetings: z.array(z.object({ fromId: z.string(), toId: z.string() })),
  constraints: z.object({
    headcount: z.boolean(),
    ageGap: z.boolean(),
    uniqueParticipants: z.boolean(),
    scheduleConsent: z.boolean(),
    paid: z.boolean(),
    submitted: z.boolean(),
    profileConsent: z.boolean(),
    unrestricted: z.boolean(),
    noOverlappingAssignment: z.boolean(),
    noExcludedRelationship: z.boolean(),
  }),
  members: z.array(
    z.object({
      applicationId: z.string(),
      userId: z.string(),
      name: z.string(),
      age: z.number(),
      gender: z.string(),
      mbti: z.array(z.string()),
      interests: z.array(z.string()),
      budgets: z.array(z.string()),
      foodRestrictions: z.string(),
      allergies: z.string(),
      selectedEvents: z.array(eventSchema),
      dateSatisfied: z.boolean(),
      regionSatisfied: z.boolean(),
      selectedCombinationSatisfied: z.boolean(),
      preferenceFulfillment: z
        .array(
          z.object({
            desire: z.string(),
            satisfied: z.boolean(),
            reason: preferenceReasonSchema.optional(),
          }),
        )
        .optional(),
      history: historySchema,
    }),
  ),
});
export type MatchFacts = z.infer<typeof factsSchema>;

// Do not fill missing historical fields from current profiles/options. Parsing
// also prevents unrelated evaluation inputs from entering this display model.
export function projectMatchFacts(evaluation: unknown): MatchFacts | null {
  const parsed = factsSchema.safeParse(record(evaluation).facts);
  return parsed.success ? parsed.data : null;
}

type EventInput = {
  id: string;
  region: string;
  startsAt: Date;
  endsAt: Date;
};
type MemberInput = Candidate & {
  name: string;
  budgets: string[];
  foodRestrictions: string;
  allergies: string;
  selectedEvents: EventInput[];
  paymentStatus: string;
  applicationStatus: string;
  consented: boolean;
  restriction: string;
  history: MatchHistory;
};
const eventSnapshot = (event: EventInput) => ({
  id: event.id,
  region: event.region,
  startsAt: event.startsAt.toISOString(),
  endsAt: event.endsAt.toISOString(),
});
const kstDay = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
const composition = (values: string[]) =>
  [...new Set(values)].sort().map((value) => ({
    value,
    count: values.filter((v) => v === value).length,
  }));

export function captureMatchFacts(input: {
  event: EventInput;
  members: MemberInput[];
  relations: Relation[];
  occupiedUserIds: Set<string>;
  confirmedAt: Date;
  finalReason: string;
}): MatchFacts {
  const {
    event,
    members,
    relations,
    occupiedUserIds,
    confirmedAt,
    finalReason,
  } = input;
  const ids = new Set(members.map((m) => m.userId));
  const internalRelations = relations.filter(
    (r) => r.active && ids.has(r.fromId) && ids.has(r.toId),
  );
  const pairIds = new Map<string, { fromId: string; toId: string }>();
  for (const r of internalRelations.filter((r) => r.kind === "MET")) {
    const [fromId, toId] = [r.fromId, r.toId].sort();
    pairIds.set(JSON.stringify([fromId, toId]), { fromId, toId });
  }
  const ages = members.map((m) => m.age);
  const age = {
    minimum: Math.min(...ages),
    maximum: Math.max(...ages),
    gap: Math.max(...ages) - Math.min(...ages),
  };
  const capturedMembers = members.map((m) => ({
    applicationId: m.id,
    userId: m.userId,
    name: m.name,
    age: m.age,
    gender: m.gender,
    mbti: [...m.mbti],
    interests: [...m.interests],
    budgets: [...m.budgets],
    foodRestrictions: m.foodRestrictions,
    allergies: m.allergies,
    preferenceFulfillment: preferenceFulfillment(m, members),
    selectedEvents: m.selectedEvents.map(eventSnapshot),
    dateSatisfied: m.selectedEvents.some(
      (e) => kstDay(e.startsAt) === kstDay(event.startsAt),
    ),
    regionSatisfied: m.selectedEvents.some((e) => e.region === event.region),
    selectedCombinationSatisfied: m.selectedEvents.some(
      (e) => e.id === event.id,
    ),
    history: { ...m.history },
  }));
  return {
    version: 1,
    capturedAt: confirmedAt.toISOString(),
    confirmedAt: confirmedAt.toISOString(),
    finalReason,
    event: eventSnapshot(event),
    headcount: members.length,
    age,
    genderComposition: composition(members.map((m) => m.gender)),
    // Multi-choice/uncertain MBTI stays a single participant's submitted value.
    mbtiComposition: composition(
      members.map((m) => [...m.mbti].sort().join(" / ") || "미기록"),
    ),
    commonInterests: [...new Set(members.flatMap((m) => m.interests))]
      .sort()
      .map((interest) => ({
        interest,
        participantCount: members.filter((m) => m.interests.includes(interest))
          .length,
      }))
      .filter((i) => i.participantCount >= 2),
    priorMeetings: [...pairIds.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    constraints: {
      headcount: members.length >= 4 && members.length <= 6,
      ageGap: ages.every(Number.isFinite) && age.gap <= 8,
      uniqueParticipants: ids.size === members.length,
      scheduleConsent: capturedMembers.every(
        (m) => m.selectedCombinationSatisfied,
      ),
      paid: members.every((m) => m.paymentStatus === "PAID"),
      submitted: members.every((m) => m.applicationStatus === "SUBMITTED"),
      profileConsent: members.every((m) => m.consented),
      unrestricted: members.every((m) =>
        ["NONE", "WARNING"].includes(m.restriction),
      ),
      noOverlappingAssignment: members.every(
        (m) => !occupiedUserIds.has(m.userId),
      ),
      noExcludedRelationship: !internalRelations.some((r) =>
        ["BLOCK", "REPORT", "AVOID"].includes(r.kind),
      ),
    },
    members: capturedMembers,
  };
}
