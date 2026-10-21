import { beforeEach, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({ run: vi.fn(), dispose: vi.fn() }));
vi.mock("highs", () => ({
  default: async () => ({
    infinity: Infinity,
    constants: {
      objectiveSense: { maximize: -1 },
      variableType: { integer: 1 },
      modelStatus: { optimal: 7, timeLimit: 13 },
    },
    createModel: () => {
      let current: { modelStatus: number; objective: number; values: number[] };
      return {
        options: { set: vi.fn() },
        passModel: vi.fn(),
        changeColsCost: vi.fn(),
        setSolution: vi.fn(),
        zeroAllClocks: vi.fn(),
        addRow: vi.fn(),
        run: () => {
          current = mock.run();
          return current;
        },
        getSolution: () => ({ colValue: current.values }),
        getObjectiveValue: () => current.objective,
        dispose: mock.dispose,
      };
    },
  }),
}));
import { composeExact, MatchingIncomplete } from "@/domain/matching-exact";
import { defaultPolicy } from "@/domain/matching-policy";
const pool = {
  eventId: "e",
  maxParticipants: 4,
  tableCapacities: [4],
  candidates: Array.from({ length: 4 }, (_, i) => ({
    id: `${i}`,
    userId: `${i}`,
    age: 25,
    gender: i % 2 ? "여성" : "남성",
    mbti: [],
    interests: [],
    traits: [],
    desiredTraits: [],
  })),
};
beforeEach(() => {
  mock.run.mockReset();
  mock.dispose.mockReset();
});
it("rejects time-limited incumbents and never runs subsequent objectives", async () => {
  mock.run.mockReturnValue({ modelStatus: 13, objective: 4, values: [1] });
  await expect(composeExact([pool], [], defaultPolicy)).rejects.toBeInstanceOf(
    MatchingIncomplete,
  );
  expect(mock.run).toHaveBeenCalledTimes(1);
  expect(mock.dispose).toHaveBeenCalledTimes(1);
});
it("rejects an alleged optimal result with a fractional solution", async () => {
  mock.run.mockReturnValue({ modelStatus: 7, objective: 2, values: [0.5] });
  await expect(composeExact([pool], [], defaultPolicy)).rejects.toThrow(
    "정수해",
  );
  expect(mock.dispose).toHaveBeenCalledTimes(1);
});
it("does not accept an optimal later solution that violates a frozen earlier optimum", async () => {
  const crowded = {
    ...pool,
    candidates: Array.from({ length: 7 }, (_, i) => ({
      ...pool.candidates[0],
      id: String(i),
      userId: String(i),
    })),
  };
  const selected = Array.from({ length: 35 }, (_, i) => Number(i === 0));
  mock.run.mockReturnValueOnce({
    modelStatus: 7,
    objective: 4,
    values: selected,
  });
  mock.run.mockReturnValueOnce({
    modelStatus: 7,
    objective: 0,
    values: selected.map(() => 0),
  });
  await expect(composeExact([crowded], [], defaultPolicy)).rejects.toThrow(
    "제약 재검증",
  );
  expect(mock.run).toHaveBeenCalledTimes(2);
});
