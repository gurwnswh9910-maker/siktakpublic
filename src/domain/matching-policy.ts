import { z } from "zod";
import type { Candidate, Relation } from "./matching";

export const MATCHING_VERSION = "decisions-v1";
export const policySchema = z.object({
  version: z.literal(MATCHING_VERSION).default(MATCHING_VERSION),
  // User-selected starting cutoff; not the legacy balanced-v1 cutoff of 45.
  minimum: z.number().finite().min(0).max(100).default(20),
  weights: z
    .tuple([
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
    ])
    .refine((w) => {
      const sum = w.reduce((a, b) => a + b, 0);
      return Number.isFinite(sum) && sum > 0;
    })
    .default([25 / 48, 13 / 48, 7 / 48, 3 / 48]),
  loneGenderMultiplier: z.number().finite().min(0).max(1).default(0),
});
export type MatchingPolicy = z.infer<typeof policySchema>;
export const defaultPolicy = policySchema.parse({});
// The general schema remains available for offline threshold experiments.
// Runtime commands may only re-save the user-fixed policy (equivalent ratios allowed).
export function isFixedPolicy(policy: MatchingPolicy) {
  const total = policy.weights.reduce((sum, value) => sum + value, 0);
  return (
    policy.minimum === defaultPolicy.minimum &&
    policy.loneGenderMultiplier === defaultPolicy.loneGenderMultiplier &&
    policy.weights.every(
      (value, i) => Math.abs(value / total - defaultPolicy.weights[i]) < 1e-12,
    )
  );
}
export type ScoringContext = {
  policy: MatchingPolicy;
  femaleTarget: number;
};
export const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const avg = (xs: number[], fallback = 0.5) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;
const unique = (xs: string[]) => [...new Set(xs)];
export const pairKey = (a: string, b: string) =>
  JSON.stringify([a, b].sort(compareId));

export function scoringContext(
  pool: Pick<Candidate, "userId" | "gender">[],
  policy: MatchingPolicy = defaultPolicy,
): ScoringContext {
  const people = [...new Map(pool.map((p) => [p.userId, p])).values()];
  const known = people.filter((p) => ["남성", "여성"].includes(p.gender));
  const female = known.filter((p) => p.gender === "여성").length;
  return {
    policy: policySchema.parse(policy),
    femaleTarget: Math.max(
      1 / 3,
      Math.min(2 / 3, known.length ? female / known.length : 0.5),
    ),
  };
}

function tags(values: string[]) {
  return unique(
    values.map((v) =>
      /깊은/.test(v)
        ? "deep"
        : /유머|편안|편하고/.test(v)
          ? "humor"
          : /경청|잘 듣/.test(v)
            ? "listen"
            : /활기|활발|열정/.test(v)
              ? "energy"
              : /잔잔|차분/.test(v)
                ? "calm"
                : /이끄/.test(v)
                  ? "lead"
                  : /새로운/.test(v)
                    ? "new"
                    : v,
    ),
  );
}

function fulfills(person: Candidate, other: Candidate, desire: string) {
  const mine = tags(person.traits),
    theirs = tags(other.traits);
  if (/비슷한|다른 자극/.test(desire)) {
    if (!mine.length || !theirs.length) return false;
    const union = new Set([...mine, ...theirs]);
    const similarity =
      mine.filter((t) => theirs.includes(t)).length / union.size;
    return desire.includes("비슷한") ? similarity >= 0.5 : similarity < 0.5;
  }
  return theirs.includes(tags([desire])[0]);
}

export const preferenceReasonSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["TRAIT", "SIMILAR", "DIFFERENT", "INSUFFICIENT_DATA"]),
  matchedCount: z.number().int().nonnegative(),
  comparedCount: z.number().int().nonnegative(),
  message: z.string(),
});
export type PreferenceFulfillment = {
  desire: string;
  satisfied: boolean;
  // Optional only for historical snapshots that saved a boolean without reasons.
  reason?: z.infer<typeof preferenceReasonSchema>;
};

// Explain exactly the existing fixed scoring predicate; do not infer new traits,
// expose other people's private preferences, or explain global optimizer tradeoffs.
export function preferenceFulfillment(person: Candidate, group: Candidate[]) {
  const peers = [
    ...new Map(
      group.filter((p) => p.userId !== person.userId).map((p) => [p.userId, p]),
    ).values(),
  ];
  return unique(person.desiredTraits).map((desire) => {
    const relative = /비슷한|다른 자극/.test(desire);
    const compared = peers.filter(
      (other) =>
        other.traits.length > 0 && (!relative || person.traits.length > 0),
    );
    const matchedCount = compared.filter((other) =>
      fulfills(person, other, desire),
    ).length;
    const kind = !compared.length
      ? ("INSUFFICIENT_DATA" as const)
      : relative
        ? desire.includes("비슷한")
          ? ("SIMILAR" as const)
          : ("DIFFERENT" as const)
        : ("TRAIT" as const);
    const criterion =
      kind === "SIMILAR"
        ? "나와 상대가 선택한 성향을 합쳐 중복 없이 비교했을 때, 공통 성향이 전체의 절반 이상"
        : "나와 상대가 선택한 성향을 합쳐 중복 없이 비교했을 때, 공통 성향이 전체의 절반 미만";
    const message =
      kind === "INSUFFICIENT_DATA"
        ? "확정 당시 비교에 필요한 성향 정보가 없어, 이 바람과 맞는지 확인하기 어려워요."
        : kind === "TRAIT"
          ? matchedCount
            ? `원하신 ‘${desire}’과 같은 성향으로 분류되는 항목을 프로필에서 선택한 분이 ${matchedCount}명 있어요.`
            : `성향을 확인할 수 있는 ${compared.length}명의 프로필 중에는 원하신 ‘${desire}’과 같은 성향으로 분류되는 항목이 없었어요.`
          : matchedCount
            ? `${criterion}인 분이 ${matchedCount}명 있어요. 이 기준으로 연결했어요.`
            : `성향을 비교할 수 있는 ${compared.length}명 중에는 공통 성향이 전체의 ${kind === "SIMILAR" ? "절반 이상" : "절반 미만"}인 분이 없었어요. 공통 성향의 비율은 두 사람이 선택한 성향을 합쳐 중복을 뺀 항목을 기준으로 확인해요.`;
    return {
      desire,
      satisfied: matchedCount > 0,
      reason: {
        version: 1 as const,
        kind,
        matchedCount,
        comparedCount: compared.length,
        message,
      },
    };
  });
}

export function decisionScores(
  group: Candidate[],
  relations: Relation[],
  context: ScoringContext,
) {
  const { policy, femaleTarget } = context;
  const male = group.filter((p) => p.gender === "남성").length;
  const female = group.filter((p) => p.gender === "여성").length;
  const balance =
    !male || !female
      ? 0
      : male + female !== group.length
        ? 0.5
        : Math.max(
            0,
            1 - Math.abs(female / group.length - femaleTarget) / 0.5,
          ) * (male === 1 || female === 1 ? policy.loneGenderMultiplier : 1);
  const mbtiOf = (p: Candidate) =>
    p.mbti.length === 1 && /^[EI][NS][TF][JP]$/.test(p.mbti[0])
      ? p.mbti[0]
      : null;
  const known = group.map(mbtiOf).filter((m): m is string => m !== null);
  const e = known.filter((m) => m[0] === "E").length;
  const diversity =
    known.length >= 2 ? (4 * e * (known.length - e)) / known.length ** 2 : 0.5;
  const weights = policy.weights.map(
    (w) => w / policy.weights.reduce((a, b) => a + b, 0),
  );
  const people = group.map((person) => {
    const others = group.filter((p) => p !== person);
    const mine = mbtiOf(person);
    const peers = others.map(mbtiOf).filter((m): m is string => m !== null);
    const mbti = mine
      ? (diversity +
          avg(
            peers.map(
              (m) => [1, 2, 3].filter((i) => m[i] === mine[i]).length / 3,
            ),
          )) /
        2
      : 0.5;
    const interests = avg(
      unique(person.interests).map((i) =>
        Number(others.some((p) => p.interests.includes(i))),
      ),
    );
    const traits = avg(
      unique(person.desiredTraits).map((d) => {
        const matches = others.filter((p) => fulfills(person, p, d));
        return matches.some(
          (p) =>
            ["남성", "여성"].includes(p.gender) &&
            ["남성", "여성"].includes(person.gender) &&
            p.gender !== person.gender,
        )
          ? 1
          : matches.length
            ? 0.8
            : 0;
      }),
    );
    return {
      userId: person.userId,
      balance,
      mbti,
      interests,
      traits,
      score:
        100 *
        [balance, mbti, interests, traits].reduce(
          (s, x, i) => s + x * weights[i],
          0,
        ),
    };
  });
  const ids = new Set(group.map((p) => p.userId));
  const repeats = new Set(
    relations
      .filter(
        (r) =>
          r.active &&
          r.kind === "MET" &&
          r.fromId !== r.toId &&
          ids.has(r.fromId) &&
          ids.has(r.toId),
      )
      .map((r) => pairKey(r.fromId, r.toId)),
  ).size;
  const scoreSum = people.reduce((s, p) => s + p.score, 0);
  return {
    score: group.length ? scoreSum / group.length : 0,
    scoreSum,
    // Integer objective precision is part of decisions-v1, not solver tolerance.
    scoreUnits: Math.round(scoreSum * 10_000),
    age: 0,
    balance,
    mbti: avg(
      people.map((p) => p.mbti),
      0,
    ),
    interests: avg(
      people.map((p) => p.interests),
      0,
    ),
    traits: avg(
      people.map((p) => p.traits),
      0,
    ),
    novelty: 1 - repeats / Math.max(1, (group.length * (group.length - 1)) / 2),
    repeatPairs: repeats,
    people,
    policy,
    femaleTarget,
  };
}
