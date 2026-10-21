import {
  decisionScores,
  MATCHING_VERSION,
  scoringContext,
  type ScoringContext,
} from "./matching-policy";

export type Candidate = {
  id: string;
  userId: string;
  age: number;
  gender: string;
  mbti: string[];
  interests: string[];
  traits: string[];
  desiredTraits: string[];
  deferredCount?: number;
  hasLaterDate?: boolean;
};
export type Relation = {
  fromId: string;
  toId: string;
  kind: string;
  active: boolean;
};
export type Evaluation = {
  score: number;
  version: string;
  age: number;
  balance: number;
  mbti: number;
  interests: number;
  traits: number;
  novelty: number;
  valid: boolean;
  reasons: string[];
  scoreSum?: number;
  scoreUnits?: number;
  repeatPairs?: number;
};
const blockedKinds = new Set(["BLOCK", "AVOID", "REPORT"]);
function traitTags(values: string[]) {
  return values.map((v) =>
    /깊은/.test(v)
      ? "deep"
      : /유머|편안한/.test(v)
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
  );
}
function desiredFit(a: Candidate, b: Candidate) {
  if (!a.desiredTraits.length || !b.traits.length) return 0.5;
  const own = traitTags(a.traits),
    other = traitTags(b.traits);
  const similarity = own.length
    ? own.filter((v) => other.includes(v)).length /
      Math.max(own.length, other.length)
    : 0.5;
  return (
    a.desiredTraits.reduce(
      (sum, desire) =>
        sum +
        (desire.includes("비슷한")
          ? similarity
          : desire.includes("다른 자극")
            ? 1 - similarity
            : Number(other.includes(traitTags([desire])[0]))),
      0,
    ) / a.desiredTraits.length
  );
}
export function validateGroup(
  group: Candidate[],
  relations: Relation[],
): string[] {
  const errors: string[] = [];
  if (group.length < 4 || group.length > 6)
    errors.push("인원은 4~6명이어야 합니다.");
  if (new Set(group.map((x) => x.userId)).size !== group.length)
    errors.push("중복 참가자");
  if (
    group.some((x) => !Number.isFinite(x.age)) ||
    Math.max(...group.map((x) => x.age)) -
      Math.min(...group.map((x) => x.age)) >
      8
  )
    errors.push("나이 차이 8 초과");
  const ids = new Set(group.map((x) => x.userId));
  if (
    relations.some(
      (r) =>
        r.active &&
        blockedKinds.has(r.kind) &&
        ids.has(r.fromId) &&
        ids.has(r.toId),
    )
  )
    errors.push("함께 배정할 수 없는 관계");
  return errors;
}
export function evaluate(
  group: Candidate[],
  relations: Relation[],
  version = "balanced-v1",
  context?: ScoringContext,
): Evaluation {
  const reasons = validateGroup(group, relations);
  if (version === MATCHING_VERSION) {
    return {
      ...decisionScores(group, relations, context ?? scoringContext(group)),
      version,
      valid: reasons.length === 0,
      reasons,
    };
  }
  if (!["balanced-v1", "demo-full-score-v1"].includes(version))
    throw new Error(`Unknown matching version: ${version}`);
  const ids = new Set(group.map((x) => x.userId));
  const pairs = group.flatMap((a, i) =>
    group.slice(i + 1).map((b) => [a, b] as const),
  );
  const overlap = (a: string[], b: string[]) =>
    a.length && b.length
      ? a.filter((v) => b.includes(v)).length / Math.max(a.length, b.length)
      : 0.5;
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const age = Math.max(
    0,
    1 -
      (Math.max(...group.map((x) => x.age)) -
        Math.min(...group.map((x) => x.age))) /
        16,
  );
  const male = group.filter((x) => x.gender === "남성").length,
    female = group.filter((x) => x.gender === "여성").length;
  const balance =
    male + female === group.length
      ? 1 - Math.abs(male - female) / group.length
      : 0.5;
  // Explicit demo heuristic, not a clinical or official MBTI compatibility table.
  const mbti = avg(
    pairs.map(([a, b]) =>
      a.mbti.length === 1 &&
      b.mbti.length === 1 &&
      /^[EI][NS][TF][JP]$/.test(a.mbti[0]) &&
      /^[EI][NS][TF][JP]$/.test(b.mbti[0])
        ? (a.mbti[0][0] !== b.mbti[0][0] ? 0.5 : 0.25) +
          (a.mbti[0][1] === b.mbti[0][1] ? 0.25 : 0) +
          (a.mbti[0][2] === b.mbti[0][2] ? 0.25 : 0)
        : 0.5,
    ),
  );
  const interests = avg(
    pairs.map(([a, b]) => overlap(a.interests, b.interests)),
  );
  const traits = avg(
    pairs.map(([a, b]) => (desiredFit(a, b) + desiredFit(b, a)) / 2),
  );
  const met = new Set(
    relations
      .filter(
        (r) =>
          r.kind === "MET" && r.active && ids.has(r.fromId) && ids.has(r.toId),
      )
      .map((r) => [r.fromId, r.toId].sort().join("|")),
  );
  const likedMet = new Set(
    relations
      .filter(
        (r) =>
          r.active &&
          r.kind === "LIKE" &&
          met.has([r.fromId, r.toId].sort().join("|")),
      )
      .map((r) => [r.fromId, r.toId].sort().join("|")),
  );
  // A positive previous encounter softens the repeat penalty but a new pair
  // still receives the highest value. AVOID/BLOCK/REPORT remain hard exclusions.
  const novelty =
    1 - (met.size - likedMet.size * 0.2) / Math.max(1, pairs.length);
  const score =
    version === "demo-full-score-v1"
      ? 100
      : Math.round(
          (age * 32 +
            balance * 24 +
            mbti * 18 +
            interests * 12 +
            traits * 9 +
            novelty * 5) *
            100,
        ) / 100;
  return {
    score,
    version,
    age,
    balance,
    mbti,
    interests,
    traits,
    novelty,
    valid: reasons.length === 0,
    reasons,
  };
}
export function compose(
  candidates: Candidate[],
  relations: Relation[],
  version = "balanced-v1",
  minimum = 45,
  limits: { maxParticipants?: number; tableCapacities?: number[] } = {},
) {
  const capacities = limits.tableCapacities?.toSorted((a, b) => b - a);
  function fits(groups: { members: Candidate[] }[]) {
    const sizes = groups.map((g) => g.members.length).sort((a, b) => b - a);
    return (
      sizes.reduce((sum, size) => sum + size, 0) <=
        (limits.maxParticipants ?? Infinity) &&
      (!capacities || sizes.every((size, i) => size <= (capacities[i] ?? 0)))
    );
  }
  const ordered = [...candidates].sort(
    (a, b) => a.age - b.age || a.id.localeCompare(b.id),
  );
  // Give every anchor an equal search budget. A global DFS budget alone would
  // be exhausted in the youngest cluster before later candidates are visited.
  // Proposal generation is independent of the evaluator for fair comparisons.
  const proposals: { members: Candidate[]; evaluation: Evaluation }[] = [];
  let visited = 0;
  let anchorVisits = 0;
  let limited = false;
  const budget = Math.max(8, Math.floor(24000 / Math.max(1, ordered.length)));
  function visit(start: number, group: Candidate[]) {
    if (anchorVisits >= budget) {
      limited = true;
      return;
    }
    anchorVisits++;
    visited++;
    if (group.length >= 4) {
      const e = evaluate(group, relations, version);
      if (e.valid && e.score >= minimum)
        proposals.push({ members: [...group], evaluation: e });
    }
    if (group.length === 6) return;
    for (let i = start; i < ordered.length; i++) {
      if (anchorVisits >= budget) {
        limited = true;
        break;
      }
      const x = ordered[i];
      if (group.length && x.age - group[0].age > 8) break;
      if (
        group.some(
          (g) =>
            g.userId === x.userId ||
            relations.some(
              (r) =>
                r.active &&
                blockedKinds.has(r.kind) &&
                ((r.fromId === x.userId && r.toId === g.userId) ||
                  (r.toId === x.userId && r.fromId === g.userId)),
            ),
        )
      )
        continue;
      visit(i + 1, [...group, x]);
    }
  }
  for (let anchor = 0; anchor < ordered.length; anchor++) {
    anchorVisits = 0;
    visit(anchor + 1, [ordered[anchor]]);
  }
  const trials = [4, 5, 6]
    .map((preferred) => {
      const used = new Set<string>();
      const tables: typeof proposals = [];
      const sorted = [...proposals].sort(
        (a, b) =>
          Number(b.members.length === preferred) -
            Number(a.members.length === preferred) ||
          b.evaluation.score - a.evaluation.score ||
          a.members
            .map((m) => m.id)
            .join()
            .localeCompare(b.members.map((m) => m.id).join()),
      );
      for (const p of sorted)
        if (
          p.members.every((m) => !used.has(m.userId)) &&
          fits([...tables, p])
        ) {
          tables.push(p);
          p.members.forEach((m) => used.add(m.userId));
        }
      // Repair provisional groups before confirmation: fill valid spare seats,
      // then split a group plus leftovers into two valid groups (e.g. 6+2→4+4).
      for (const x of ordered.filter((x) => !used.has(x.userId))) {
        const options = tables
          .filter((t) => t.members.length < 6)
          .map((t) => ({
            t,
            evaluation: evaluate([...t.members, x], relations, version),
          }))
          .filter(
            (p) =>
              p.evaluation.valid &&
              p.evaluation.score >= minimum &&
              fits(
                tables.map((t) =>
                  t === p.t ? { members: [...t.members, x] } : t,
                ),
              ),
          )
          .sort((a, b) => b.evaluation.score - a.evaluation.score);
        if (options[0]) {
          options[0].t.members = [...options[0].t.members, x];
          options[0].t.evaluation = options[0].evaluation;
          used.add(x.userId);
        }
      }
      let repairs = 0;
      for (let ti = 0; ti < tables.length && repairs < 1200; ti++) {
        const t = tables[ti];
        const rest = ordered
          .filter(
            (x) =>
              !used.has(x.userId) &&
              Math.max(x.age, ...t.members.map((m) => m.age)) -
                Math.min(x.age, ...t.members.map((m) => m.age)) <=
                8,
          )
          .slice(0, 12 - t.members.length);
        const pool = [...t.members, ...rest];
        if (pool.length < 8) continue;
        const bestSplit: { value: typeof proposals | null } = { value: null };
        let bestScore = -Infinity;
        function split(start: number, left: Candidate[]) {
          if (++repairs > 1200) return;
          const right = pool.filter((x) => !left.includes(x));
          if (left.length >= 4 && right.length >= 4 && right.length <= 6) {
            const a = evaluate(left, relations, version),
              b = evaluate(right, relations, version);
            if (
              a.valid &&
              b.valid &&
              a.score >= minimum &&
              b.score >= minimum &&
              fits([
                ...tables.filter((other) => other !== t),
                { members: left },
                { members: right },
              ]) &&
              a.score * left.length + b.score * right.length > bestScore
            ) {
              bestScore = a.score * left.length + b.score * right.length;
              bestSplit.value = [
                { members: [...left], evaluation: a },
                { members: right, evaluation: b },
              ];
            }
          }
          if (left.length === 6 || repairs >= 1200) return;
          for (let j = start; j < pool.length; j++)
            split(j + 1, [...left, pool[j]]);
        }
        split(1, [pool[0]]);
        if (bestSplit.value) {
          tables.splice(ti, 1, ...bestSplit.value);
          pool.forEach((m) => used.add(m.userId));
          ti++;
        }
      }
      return {
        tables,
        used,
        score: tables.reduce(
          (s, t) => s + t.evaluation.score * t.members.length,
          0,
        ),
      };
    })
    .sort((a, b) => b.used.size - a.used.size || b.score - a.score);
  const best = trials[0];
  return {
    tables: best.tables,
    unmatched: ordered.filter((x) => !best.used.has(x.userId)),
    visited,
    limited,
  };
}
