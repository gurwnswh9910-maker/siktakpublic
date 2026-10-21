import { describe, it, expect } from "vitest";
import { compose, evaluate, validateGroup, Candidate } from "@/domain/matching";
const candidates = (n: number) =>
  Array.from({ length: n }, (_, i): Candidate => ({
    id: String(i),
    userId: String(i),
    age: 27 + (i % 4),
    gender: i % 2 ? "남성" : "여성",
    mbti: [i % 2 ? "ENFP" : "INTJ"],
    interests: ["여행", "음식"],
    traits: ["편안한 대화"],
    desiredTraits: ["편안한 대화"],
  }));
describe("matching constraints and quality", () => {
  it.each([3, 4, 6, 7, 8, 9, 12])(
    "creates only valid tables from %i candidates",
    (n) => {
      const r = compose(candidates(n), []);
      for (const t of r.tables)
        expect(validateGroup(t.members, [])).toEqual([]);
      const ids = r.tables.flatMap((t) => t.members.map((m) => m.userId));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length + r.unmatched.length).toBe(n);
      if (n === 3) expect(ids.length).toBe(0);
      if (n === 8) expect(ids.length).toBe(8);
    },
  );
  it("accepts age gap 8 and rejects 9", () => {
    const g = candidates(4);
    g[0].age = 20;
    g[1].age = 28;
    g[2].age = 24;
    g[3].age = 25;
    expect(validateGroup(g, [])).toEqual([]);
    g[1].age = 29;
    expect(validateGroup(g, [])).toContain("나이 차이 8 초과");
  });
  it.each(["BLOCK", "REPORT", "AVOID"])(
    "separates %s in either direction",
    (kind) => {
      const g = candidates(8),
        relations = [{ fromId: "0", toId: "1", kind, active: true }];
      const r = compose(g, relations);
      expect(
        r.tables.every((t) => validateGroup(t.members, relations).length === 0),
      ).toBe(true);
    },
  );
  it("does not interpret demo full scores as ignoring hard constraints", () => {
    const g = candidates(3);
    expect(evaluate(g, [], "demo-full-score-v1")).toMatchObject({
      score: 100,
      valid: false,
    });
  });
  it("prefers new relationships and handles uncertain MBTI neutrally", () => {
    const g = candidates(4);
    g[0].mbti = ["ENTJ", "INTJ"];
    const fresh = evaluate(g, []);
    const met = evaluate(g, [
      { fromId: "0", toId: "1", kind: "MET", active: true },
    ]);
    expect(fresh.score).toBeGreaterThan(met.score);
    const liked = evaluate(g, [
      { fromId: "0", toId: "1", kind: "MET", active: true },
      { fromId: "0", toId: "1", kind: "LIKE", active: true },
    ]);
    expect(liked.score).toBeGreaterThan(met.score);
    expect(fresh.score).toBeGreaterThan(liked.score);
    expect(Number.isFinite(fresh.score)).toBe(true);
  });
  it("is deterministic and has bounded work", () => {
    const g = candidates(40);
    const a = compose(g, []),
      b = compose(g, []);
    expect(a).toEqual(b);
    expect(a.visited).toBeLessThanOrEqual(24001);
  });
  it("gives later age clusters a chance even when the first cluster exhausts its budget", () => {
    const g = candidates(294).map((c, i) => ({ ...c, age: i < 150 ? 20 : 40 }));
    const result = compose(g, [], "demo-full-score-v1");
    expect(
      result.tables.flatMap((t) => t.members).filter((m) => m.age === 40)
        .length,
    ).toBeGreaterThan(130);
    expect(result.unmatched.length).toBeLessThan(8);
    expect(result.visited).toBeLessThanOrEqual(24000);
  });
});
