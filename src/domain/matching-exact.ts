import loadHighs, { type Highs } from "highs";
import {
  evaluate,
  type Candidate,
  type Evaluation,
  type Relation,
} from "./matching";
import {
  compareId,
  MATCHING_VERSION,
  scoringContext,
  pairKey,
  type MatchingPolicy,
  type ScoringContext,
} from "./matching-policy";

export type MatchPool = {
  eventId: string;
  candidates: Candidate[];
  maxParticipants: number;
  tableCapacities: number[];
};
export type Proposal = {
  eventId: string;
  members: Candidate[];
  evaluation: Evaluation;
};
export type Stage = {
  name: string;
  status: string;
  optimum?: number;
  proof?:
    | "solver"
    | "upper-bound"
    | "constant"
    | "integer-dominance"
    | "dynamic-programming";
};
export class MatchingIncomplete extends Error {
  constructor(
    message: string,
    public stages: Stage[] = [],
  ) {
    super(message);
  }
}
let solver: Promise<Highs> | undefined;
const names = [
  "deferred",
  "participants",
  "repeatPairs",
  "quality",
  "lastDate",
];
type Row = { terms: [number, number][]; bound: number; equal?: boolean };
/**
 * All pools belong to one date. Every candidate table is enumerated; limits
 * abort the entire run, never silently change it to a heuristic.
 */
export async function composeExact(
  pools: MatchPool[],
  relations: Relation[],
  policy: MatchingPolicy,
  limits: {
    maxProposals?: number;
    maxVisits?: number;
    timeLimitMs?: number;
  } = {},
) {
  const deadline = performance.now() + (limits.timeLimitMs ?? 20_000);
  const context = scoringContext(
    pools.flatMap((p) => p.candidates),
    policy,
  );
  const proposals: Proposal[] = [];
  const blocked = new Set(
    relations
      .filter((r) => r.active && ["BLOCK", "REPORT", "AVOID"].includes(r.kind))
      .map((r) => pairKey(r.fromId, r.toId)),
  );
  const seenEvents = new Set<string>();
  let visited = 0;
  for (const pool of [...pools].sort((a, b) =>
    compareId(a.eventId, b.eventId),
  )) {
    if (seenEvents.has(pool.eventId)) throw new Error("Duplicate event pool");
    seenEvents.add(pool.eventId);
    if (
      !Number.isInteger(pool.maxParticipants) ||
      pool.maxParticipants < 0 ||
      pool.tableCapacities.some((n) => !Number.isInteger(n) || n < 0)
    )
      throw new Error("Invalid matching capacity");
    if (
      new Set(pool.candidates.map((p) => p.id)).size !== pool.candidates.length
    )
      throw new Error("Duplicate application in matching pool");
    const ordered = [...pool.candidates].sort(
      (a, b) => a.age - b.age || compareId(a.id, b.id),
    );
    const maxSize = Math.min(
      6,
      pool.maxParticipants,
      Math.max(0, ...pool.tableCapacities),
    );
    if (maxSize < 4) continue;
    function visit(start: number, group: Candidate[]) {
      if (
        ++visited > (limits.maxVisits ?? 500_000) ||
        performance.now() >= deadline
      )
        throw new MatchingIncomplete("후보 전체 열거 한도를 초과했습니다.");
      if (group.length >= 4) {
        const evaluation = evaluate(
          group,
          relations,
          MATCHING_VERSION,
          context,
        );
        if (evaluation.valid && evaluation.score >= policy.minimum) {
          if (proposals.length >= (limits.maxProposals ?? 50_000))
            throw new MatchingIncomplete("후보 테이블 수 한도를 초과했습니다.");
          proposals.push({
            eventId: pool.eventId,
            members: [...group],
            evaluation,
          });
        }
      }
      if (group.length >= maxSize) return;
      for (let i = start; i < ordered.length; i++) {
        const person = ordered[i];
        if (!Number.isFinite(person.age)) continue;
        if (group.length && person.age - group[0].age > 8) break;
        if (
          group.some(
            (p) =>
              p.userId === person.userId ||
              blocked.has(pairKey(p.userId, person.userId)),
          )
        )
          continue;
        visit(i + 1, [...group, person]);
      }
    }
    visit(0, []);
  }
  const feasibleIds = new Set(
    proposals.flatMap((p) => p.members.map((m) => m.id)),
  );
  if (!proposals.length)
    return {
      tables: proposals,
      stages: [] as Stage[],
      context,
      visited,
      feasibleIds,
      proposalCount: 0,
      optimal: true as const,
    };
  const rows: Row[] = [];
  const users = new Map<string, [number, number][]>();
  const eventTerms = new Map<string, number[]>();
  proposals.forEach((p, i) => {
    for (const m of p.members) {
      if (!users.has(m.userId)) users.set(m.userId, []);
      users.get(m.userId)!.push([i, 1]);
    }
    if (!eventTerms.has(p.eventId)) eventTerms.set(p.eventId, []);
    eventTerms.get(p.eventId)!.push(i);
  });
  // If resources cannot bind even when every feasible person chooses one
  // region, only the used-person set matters. Small pools then have an exact
  // finite subset recurrence, avoiding difficult symmetric MIP proofs.
  if (
    users.size <= 20 &&
    pools
      .filter((p) => eventTerms.has(p.eventId))
      .every(
        (p) =>
          p.maxParticipants >= users.size &&
          p.tableCapacities.filter((n) => n >= 6).length >=
            Math.floor(users.size / 4),
      )
  ) {
    const result = solveSubsets(
      proposals,
      [...users.keys()].sort(compareId),
      deadline,
    );
    verifyTables(result.tables, pools, relations, context);
    return {
      ...result,
      context,
      visited,
      feasibleIds,
      proposalCount: proposals.length,
      optimal: true as const,
    };
  }
  for (const [, terms] of [...users].sort(([a], [b]) => compareId(a, b)))
    rows.push({ terms, bound: 1 });
  for (const pool of [...pools].sort((a, b) =>
    compareId(a.eventId, b.eventId),
  )) {
    const indices = eventTerms.get(pool.eventId) ?? [];
    if (!indices.length) continue;
    rows.push({
      terms: indices.map((i) => [i, proposals[i].members.length]),
      bound: pool.maxParticipants,
    });
    // Nested capacity constraints are sufficient for matching table sizes to
    // slots: e.g. two six-person groups require two slots with capacity >= 6.
    for (const size of [4, 5, 6])
      rows.push({
        terms: indices
          .filter((i) => proposals[i].members.length >= size)
          .map((i) => [i, 1]),
        bound: pool.tableCapacities.filter((n) => n >= size).length,
      });
  }
  const objectives = [
    proposals.map(
      (p) => p.members.filter((m) => (m.deferredCount ?? 0) > 0).length,
    ),
    proposals.map((p) => p.members.length),
    proposals.map((p) => -(p.evaluation.repeatPairs ?? 0)),
    proposals.map((p) => p.evaluation.scoreUnits!),
    proposals.map((p) => p.members.filter((m) => !m.hasLaterDate).length),
  ];
  // Feasible starts speed up the solver; only proven bounds permit skipping a
  // solve. A heuristic is never returned as an uncertified final assignment.
  let initial = proposals.map(() => 0);
  let initialObjective = objectives.map(() => 0);
  for (const size of [6, 4, 5]) {
    const used = new Set<string>();
    const usage = new Map<string, number[]>();
    const values = proposals.map(() => 0);
    const order = proposals
      .map((_, i) => i)
      .sort(
        (a, b) =>
          objectives[0][b] - objectives[0][a] ||
          Number(proposals[b].members.length === size) -
            Number(proposals[a].members.length === size) ||
          proposals[b].members.length - proposals[a].members.length ||
          objectives[3][b] - objectives[3][a] ||
          a - b,
      );
    for (const i of order) {
      const p = proposals[i],
        pool = pools.find((pool) => pool.eventId === p.eventId)!;
      if (p.members.some((m) => used.has(m.userId))) continue;
      const sizes = [...(usage.get(p.eventId) ?? []), p.members.length].sort(
        (a, b) => b - a,
      );
      const capacities = [...pool.tableCapacities].sort((a, b) => b - a);
      if (
        sizes.reduce((a, b) => a + b, 0) > pool.maxParticipants ||
        sizes.some((n, i) => n > (capacities[i] ?? 0))
      )
        continue;
      usage.set(p.eventId, sizes);
      values[i] = 1;
      p.members.forEach((m) => used.add(m.userId));
    }
    const objective = objectives.map((cs) =>
      cs.reduce((sum, c, i) => sum + c * values[i], 0),
    );
    const firstDifference = objective.findIndex(
      (v, i) => v !== initialObjective[i],
    );
    if (
      firstDifference >= 0 &&
      objective[firstDifference] > initialObjective[firstDifference]
    ) {
      initial = values;
      initialObjective = objective;
    }
  }
  const stages: Stage[] = [];
  const highs = await (solver ??= loadHighs().catch((error) => {
    solver = undefined;
    throw error;
  }));
  const model = highs.createModel();
  let selected: number[] = [];
  try {
    model.options.set({
      output_flag: false,
      mip_rel_gap: 0,
      mip_abs_gap: 0,
      random_seed: 0,
    });
    const indices: number[] = [],
      matrixValues: number[] = [],
      starts = [0];
    for (const row of rows) {
      for (const [index, value] of row.terms) {
        indices.push(index);
        matrixValues.push(value);
      }
      starts.push(indices.length);
    }
    model.passModel({
      numCols: proposals.length,
      numRows: rows.length,
      sense: highs.constants.objectiveSense.maximize,
      colCost: proposals.map(() => 0),
      colLower: proposals.map(() => 0),
      colUpper: proposals.map(() => 1),
      integrality: proposals.map(() => highs.constants.variableType.integer),
      rowLower: rows.map(() => -highs.infinity),
      rowUpper: rows.map((r) => r.bound),
      matrix: {
        format: "csr",
        numRows: rows.length,
        numCols: proposals.length,
        starts,
        indices,
        values: matrixValues,
      },
    });
    let previous: number[] = initial;
    for (let stage = 0; stage < 4; stage++) {
      // Last-date count is bounded by the number of users. An integer quality
      // unit dominates every possible change in that tie-break count.
      const coefficients =
        stage === 3
          ? objectives[3].map((c, i) => c * (users.size + 1) + objectives[4][i])
          : objectives[stage];
      if (coefficients.every((n) => n === 0)) {
        stages.push({
          name: names[stage],
          status: "Optimal",
          optimum: 0,
          proof: "constant",
        });
        if (stage === 3)
          stages.push({
            name: names[4],
            status: "Optimal",
            optimum: 0,
            proof: "constant",
          });
        continue;
      }
      const upperBound =
        stage === 0
          ? new Set(
              proposals.flatMap((p) =>
                p.members
                  .filter((m) => (m.deferredCount ?? 0) > 0)
                  .map((m) => m.userId),
              ),
            ).size
          : stage === 1
            ? users.size
            : stage === 2
              ? 0
              : undefined;
      const incumbent = coefficients.reduce(
        (sum, c, i) => sum + c * previous[i],
        0,
      );
      if (upperBound !== undefined && incumbent === upperBound) {
        const terms = coefficients.flatMap((c, i): [number, number][] =>
          c ? [[i, c]] : [],
        );
        stages.push({
          name: names[stage],
          status: "Optimal",
          optimum: incumbent,
          proof: "upper-bound",
        });
        rows.push({ terms, bound: incumbent, equal: true });
        model.addRow(incumbent, incumbent, {
          indices: terms.map(([i]) => i),
          values: terms.map(([, c]) => c),
        });
        selected = previous.flatMap((x, i) => (x ? [i] : []));
        continue;
      }
      const remaining = (deadline - performance.now()) / 1000;
      if (remaining <= 0)
        throw new MatchingIncomplete(
          "최적성 검증 시간이 초과되었습니다.",
          stages,
        );
      model.changeColsCost(
        { kind: "range", from: 0, to: proposals.length - 1 },
        coefficients,
      );
      model.setSolution({ colValue: previous });
      model.zeroAllClocks();
      model.options.set("time_limit", remaining);
      const result = model.run();
      const optimal =
        result.modelStatus === highs.constants.modelStatus.optimal;
      const status = optimal
        ? "Optimal"
        : (Object.entries(highs.constants.modelStatus).find(
            ([, code]) => code === result.modelStatus,
          )?.[0] ?? String(result.modelStatus));
      const record: Stage = {
        name: names[stage],
        status,
        ...(optimal ? { proof: "solver" as const } : {}),
      };
      stages.push(record);
      if (!optimal)
        throw new MatchingIncomplete(
          `최적성 미확인: ${names[stage]} (${status})`,
          stages,
        );
      const values = Array.from(model.getSolution().colValue, (value) => {
        if (
          !Number.isFinite(value) ||
          Math.abs(value - Math.round(value)) > 1e-6 ||
          value < -1e-6 ||
          value > 1 + 1e-6
        )
          throw new MatchingIncomplete("정수해 검증 실패", stages);
        return Math.round(value);
      });
      if (
        values.length !== proposals.length ||
        rows.some((r) => {
          const total = r.terms.reduce((sum, [i, c]) => sum + values[i] * c, 0);
          return r.equal ? total !== r.bound : total > r.bound;
        })
      )
        throw new MatchingIncomplete("최적해 제약 재검증 실패", stages);
      const optimum = coefficients.reduce(
        (sum, c, i) => sum + c * values[i],
        0,
      );
      if (Math.abs(optimum - model.getObjectiveValue()) > 1e-4)
        throw new MatchingIncomplete("목적값 검증 실패", stages);
      record.optimum =
        stage === 3
          ? objectives[3].reduce((sum, c, i) => sum + c * values[i], 0)
          : optimum;
      if (stage === 3)
        stages.push({
          name: names[4],
          status: "Optimal",
          optimum: objectives[4].reduce((sum, c, i) => sum + c * values[i], 0),
          proof: "integer-dominance",
        });
      const terms: [number, number][] = coefficients
        .map((c, i) => [i, c])
        .filter(([, c]) => c !== 0) as [number, number][];
      rows.push({ terms, bound: optimum, equal: true });
      model.addRow(optimum, optimum, {
        indices: terms.map(([i]) => i),
        values: terms.map(([, c]) => c),
      });
      previous = values;
      selected = values.flatMap((x, i) => (x ? [i] : []));
    }
  } finally {
    model.dispose();
  }
  const tables = selected.map((i) => proposals[i]);
  verifyTables(tables, pools, relations, context);
  return {
    tables,
    stages,
    context,
    visited,
    feasibleIds,
    proposalCount: proposals.length,
    optimal: true as const,
  };
}

/** Exact lexicographic set packing when all venue/capacity rows are redundant. */
function solveSubsets(
  proposals: Proposal[],
  userIds: string[],
  deadline: number,
) {
  const position = new Map(userIds.map((id, i) => [id, i]));
  type Group = { mask: number; proposal: Proposal; value: number[] };
  const unique = new Map<number, Group>();
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  for (const proposal of proposals) {
    const mask = proposal.members.reduce(
      (m, p) => m | (1 << position.get(p.userId)!),
      0,
    );
    const value = [
      proposal.members.filter((m) => (m.deferredCount ?? 0) > 0).length,
      proposal.members.length,
      -(proposal.evaluation.repeatPairs ?? 0),
      proposal.evaluation.scoreUnits!,
      proposal.members.filter((m) => !m.hasLaterDate).length,
    ];
    const previous = unique.get(mask);
    if (!previous || compare(value, previous.value) > 0)
      unique.set(mask, { mask, proposal, value });
  }
  const groups = [...unique.values()];
  const byPerson = userIds.map((_, bit) =>
    groups.flatMap((g, i) => (g.mask & (1 << bit) ? [i] : [])),
  );
  const size = 1 << userIds.length;
  const scores = new Float64Array(size * 5);
  const choices = new Int32Array(size);
  const seen = new Uint8Array(size);
  seen[0] = 1;
  let visits = 0;
  function solve(mask: number) {
    if (seen[mask]) return;
    if ((++visits & 1023) === 0 && performance.now() >= deadline)
      throw new MatchingIncomplete("정확 부분집합 계산 시간이 초과되었습니다.");
    const bit = mask & -mask;
    const rest = mask ^ bit;
    solve(rest);
    const offset = mask * 5;
    for (let i = 0; i < 5; i++) scores[offset + i] = scores[rest * 5 + i];
    for (const index of byPerson[31 - Math.clz32(bit)]) {
      if ((++visits & 4095) === 0 && performance.now() >= deadline)
        throw new MatchingIncomplete(
          "정확 부분집합 계산 시간이 초과되었습니다.",
        );
      const group = groups[index];
      if ((group.mask & mask) !== group.mask) continue;
      const remaining = mask ^ group.mask;
      solve(remaining);
      let better = false;
      for (let i = 0; i < 5; i++) {
        const value = scores[remaining * 5 + i] + group.value[i];
        if (value !== scores[offset + i]) {
          better = value > scores[offset + i];
          break;
        }
      }
      if (better) {
        for (let i = 0; i < 5; i++)
          scores[offset + i] = scores[remaining * 5 + i] + group.value[i];
        choices[mask] = index + 1;
      }
    }
    seen[mask] = 1;
  }
  const full = size - 1;
  solve(full);
  if (performance.now() >= deadline)
    throw new MatchingIncomplete("정확 부분집합 계산 시간이 초과되었습니다.");
  const tables: Proposal[] = [];
  for (let mask = full; mask;) {
    const index = choices[mask] - 1;
    if (index < 0) mask ^= mask & -mask;
    else {
      tables.push(groups[index].proposal);
      mask ^= groups[index].mask;
    }
  }
  return {
    tables,
    stages: names.map((name, i): Stage => ({
      name,
      status: "Optimal",
      optimum: scores[full * 5 + i],
      proof: "dynamic-programming",
    })),
  };
}

function verifyTables(
  tables: Proposal[],
  pools: MatchPool[],
  relations: Relation[],
  context: ScoringContext,
) {
  const used = new Set<string>();
  for (const p of tables) {
    const evaluation = evaluate(
      p.members,
      relations,
      MATCHING_VERSION,
      context,
    );
    if (
      !evaluation.valid ||
      evaluation.score < context.policy.minimum ||
      p.members.some((m) => used.has(m.userId))
    )
      throw new MatchingIncomplete("최종 테이블 재검증 실패");
    p.members.forEach((m) => used.add(m.userId));
  }
  for (const pool of pools) {
    const sizes = tables
      .filter((p) => p.eventId === pool.eventId)
      .map((p) => p.members.length)
      .sort((a, b) => b - a);
    const capacities = [...pool.tableCapacities].sort((a, b) => b - a);
    if (
      sizes.reduce((a, b) => a + b, 0) > pool.maxParticipants ||
      sizes.some((size, i) => size > (capacities[i] ?? 0))
    )
      throw new MatchingIncomplete("최종 수용량 재검증 실패");
  }
}
