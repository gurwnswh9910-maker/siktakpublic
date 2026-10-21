import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
const rehearsalPool = "data/matching-rehearsal/failing-pool-20.json";
import {
  composeExact,
  MatchingIncomplete,
  type MatchPool,
} from "@/domain/matching-exact";
import {
  evaluate,
  validateGroup,
  type Candidate,
  type Relation,
} from "@/domain/matching";
import {
  defaultPolicy,
  MATCHING_VERSION,
  scoringContext,
} from "@/domain/matching-policy";
const people = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    userId: `u${i}`,
    age: 27 + (i % 4),
    gender: i % 2 ? "남성" : "여성",
    mbti: [i % 2 ? "ENFP" : "INTJ"],
    interests: ["여행", `관심${i % 3}`],
    traits: [i % 2 ? "활기찬 사람" : "잔잔하고 조용한 편"],
    desiredTraits: ["열정 있는 사람"],
  }));
const pool = (
  candidates: Candidate[],
  eventId = "event",
  maxParticipants = 100,
  tableCapacities = [6, 6, 6],
): MatchPool => ({ eventId, candidates, maxParticipants, tableCapacities });
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

// Independent exhaustive partition oracle: choose a table containing the first
// unprocessed person, or leave that person out. No MILP or proposal generator.
function oracle(
  candidates: Candidate[],
  relations: Relation[],
  maxParticipants: number,
) {
  const context = scoringContext(candidates);
  let best = [0, 0, 0, 0, 0];
  function walk(remaining: Candidate[], value: number[]) {
    if (!remaining.length) {
      if (cmp(value, best) > 0) best = value;
      return;
    }
    const [first, ...rest] = remaining;
    walk(rest, value);
    for (let mask = 0; mask < 2 ** rest.length; mask++) {
      const group = [first, ...rest.filter((_, i) => mask & (1 << i))];
      if (
        group.length < 4 ||
        group.length > 6 ||
        group.length + value[1] > maxParticipants
      )
        continue;
      const e = evaluate(group, relations, MATCHING_VERSION, context);
      if (!e.valid || e.score < defaultPolicy.minimum) continue;
      const v = [
        group.filter((p) => p.deferredCount).length,
        group.length,
        -e.repeatPairs!,
        e.scoreUnits!,
        group.filter((p) => !p.hasLaterDate).length,
      ];
      walk(
        rest.filter((_, i) => !(mask & (1 << i))),
        value.map((x, i) => x + v[i]),
      );
    }
  }
  walk(candidates, [0, 0, 0, 0, 0]);
  return best;
}

describe("decisions-v1 scoring", () => {
  it("uses exact ROC weights, no age or novelty contribution and a normalized threshold scale", () => {
    const g = people(4).map((p, i) => ({
      ...p,
      age: 20 + i,
      mbti: [i % 2 ? "ENTJ" : "INTJ"],
      interests: ["여행"],
      traits: ["활기찬 사람"],
    }));
    const ctx = scoringContext(g);
    const e = evaluate(g, [], MATCHING_VERSION, ctx);
    expect(e.score).toBeCloseTo(100);
    expect(e.scoreSum).toBeCloseTo(400);
    const met = evaluate(
      g,
      [{ fromId: "u0", toId: "u1", kind: "MET", active: true }],
      MATCHING_VERSION,
      ctx,
    );
    expect(met.score).toBe(e.score);
    expect(met.repeatPairs).toBe(1);
    g[0].age = 15;
    expect(evaluate(g, [], MATCHING_VERSION, ctx).score).toBe(e.score);
    expect(defaultPolicy.weights.reduce((a, b) => a + b)).toBeCloseTo(1);
    expect(defaultPolicy.minimum).toBe(20);
  });
  it("uses union coverage, neutral missing data, all three remaining MBTI letters", () => {
    const g = people(4);
    g.forEach((p) => {
      p.mbti = [];
      p.interests = [];
      p.desiredTraits = [];
    });
    const e = evaluate(g, [], MATCHING_VERSION);
    expect(e.mbti).toBe(0.5);
    expect(e.interests).toBe(0.5);
    expect(e.traits).toBe(0.5);
    g.forEach((p, i) => {
      p.interests = i ? [i % 2 ? "여행" : "영화"] : ["여행", "영화", "여행"];
    });
    expect(evaluate(g, [], MATCHING_VERSION).interests).toBe(1);
  });
  it("allows 1:5 and same-gender tables but gives them zero gender score", () => {
    const g = people(6);
    g.forEach((p) => (p.gender = "여성"));
    g[0].gender = "남성";
    expect(evaluate(g, [], MATCHING_VERSION)).toMatchObject({
      valid: true,
      balance: 0,
    });
    g[0].gender = "여성";
    expect(evaluate(g, [], MATCHING_VERSION)).toMatchObject({
      valid: true,
      balance: 0,
    });
  });
  it("deduplicates directional repeats and does not exempt LIKE", () => {
    const relations = [
      { fromId: "u0", toId: "u1", kind: "MET", active: true },
      { fromId: "u1", toId: "u0", kind: "MET", active: true },
      { fromId: "u1", toId: "u0", kind: "LIKE", active: true },
    ];
    expect(evaluate(people(4), relations, MATCHING_VERSION).repeatPairs).toBe(
      1,
    );
    expect(Number.isFinite(evaluate([], [], MATCHING_VERSION).score)).toBe(
      true,
    );
  });
});

describe("exact lexicographic allocation", () => {
  it.skipIf(!existsSync(rehearsalPool))("proves the optimum of the 20-person pool that timed out in the real rehearsal", async () => {
    const input = JSON.parse(
      readFileSync(rehearsalPool, "utf8"),
    );
    const result = await composeExact(
      input.pools,
      input.relations,
      input.policy,
    );
    expect(result.stages.map((s) => s.optimum)).toEqual([
      0, 20, 0, 13820834, 20,
    ]);
    expect(result.stages.every((s) => s.proof === "dynamic-programming")).toBe(
      true,
    );
    expect(
      new Set(result.tables.flatMap((t) => t.members.map((m) => m.userId)))
        .size,
    ).toBe(20);
    expect(
      result.tables.every(
        (t) => t.evaluation.valid && t.evaluation.score >= 20,
      ),
    ).toBe(true);
  });
  it.each([3, 4, 6, 7, 8, 9, 12])(
    "partitions %i people without loss or duplicate assignments",
    async (n) => {
      const p = people(n),
        r = await composeExact([pool(p)], [], defaultPolicy);
      const selected = r.tables.flatMap((t) => t.members);
      expect(new Set(selected.map((m) => m.userId)).size).toBe(selected.length);
      expect(selected.length).toBe(n < 4 ? 0 : n === 7 ? 6 : n);
      r.tables.forEach((t) => expect(validateGroup(t.members, [])).toEqual([]));
      expect(r.optimal).toBe(true);
    },
  );
  it("maximizes deferred people before the total number of people", async () => {
    const p = people(10).map((p, i) => ({
      ...p,
      age: i === 0 ? 18 : i < 4 ? 26 : 34,
    }));
    p[0].deferredCount = 1;
    const r = await composeExact([pool(p, "e", 8, [6, 6])], [], defaultPolicy);
    expect(r.tables.flatMap((t) => t.members).some((m) => m.id === "a0")).toBe(
      true,
    );
    expect(r.stages[0].optimum).toBe(1);
  });
  it("records a real conflict when two deferred people cannot both fit", async () => {
    const p = people(5);
    p[0].deferredCount = 1;
    p[1].deferredCount = 1;
    const r = await composeExact(
      [pool(p)],
      [{ fromId: "u0", toId: "u1", kind: "BLOCK", active: true }],
      defaultPolicy,
    );
    expect(r.stages[0].optimum).toBe(1);
    expect(r.feasibleIds.has("a0") && r.feasibleIds.has("a1")).toBe(true);
    expect(r.tables.flatMap((t) => t.members)).toHaveLength(4);
  });
  it("solves regions jointly, including asymmetric venue capacities", async () => {
    const p = people(8);
    const r = await composeExact(
      [pool(p.slice(0, 6), "a", 6, [6]), pool(p.slice(4), "b", 4, [4])],
      [],
      defaultPolicy,
    );
    expect(r.tables.map((t) => t.members.length)).toEqual([4, 4]);
    expect(r.tables.flatMap((t) => t.members)).toHaveLength(8);
  });
  it("uses one identity across duplicate applications and excludes inactive blocks", async () => {
    const p = people(8);
    p[7].userId = p[0].userId;
    const r = await composeExact(
      [pool(p)],
      [{ fromId: "u0", toId: "u1", kind: "BLOCK", active: false }],
      defaultPolicy,
    );
    const ids = r.tables.flatMap((t) => t.members.map((m) => m.userId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(6);
  });
  it("is deterministic regardless of input order", async () => {
    const p = people(9);
    const a = await composeExact([pool(p)], [], defaultPolicy);
    const b = await composeExact([pool([...p].reverse())], [], defaultPolicy);
    expect(a.tables).toEqual(b.tables);
    expect(a.stages).toEqual(b.stages);
  });
  it("uses the same-date pool ratio, not the proposed table ratio", async () => {
    const p = people(8);
    p.forEach((p, i) => (p.gender = i < 2 ? "남성" : "여성"));
    const r = await composeExact([pool(p)], [], defaultPolicy);
    expect(r.context.femaleTarget).toBe(2 / 3);
  });
  it("stops with no partial solution when enumeration or time budgets expire", async () => {
    await expect(
      composeExact([pool(people(10))], [], defaultPolicy, { maxProposals: 2 }),
    ).rejects.toBeInstanceOf(MatchingIncomplete);
    await expect(
      composeExact([pool(people(4))], [], defaultPolicy, { timeLimitMs: 0 }),
    ).rejects.toBeInstanceOf(MatchingIncomplete);
  });
  it("filters by configured minimum and respects zero available tables", async () => {
    expect(
      (await composeExact([pool(people(8), "e", 8, [])], [], defaultPolicy))
        .tables,
    ).toHaveLength(0);
    const p = people(4).map((p) => ({ ...p, gender: "여성" }));
    expect(
      (await composeExact([pool(p)], [], { ...defaultPolicy, minimum: 100 }))
        .tables,
    ).toHaveLength(0);
  });
  it("matches an exhaustive oracle on varied small pools", async () => {
    for (let seed = 1; seed <= 16; seed++) {
      const p = people(8 + (seed % 2)).map((p, i) => ({
        ...p,
        age: 20 + ((i * seed) % 12),
        deferredCount: (i + seed) % 4 === 0 ? 1 : 0,
        hasLaterDate: (i + seed) % 3 === 0,
      }));
      const rel: Relation[] = [
        { fromId: `u${seed % 4}`, toId: "u5", kind: "BLOCK", active: true },
        { fromId: "u1", toId: "u7", kind: "MET", active: true },
      ];
      const capacity = seed % 3 === 0 ? 6 : 9;
      const r = await composeExact(
        [pool(p, "e", capacity)],
        rel,
        defaultPolicy,
      );
      const actual = r.stages.slice(0, 5).map((s) => s.optimum!);
      expect(actual.length ? actual : [0, 0, 0, 0, 0], `seed=${seed}`).toEqual(
        oracle(p, rel, capacity),
      );
    }
  });
});
