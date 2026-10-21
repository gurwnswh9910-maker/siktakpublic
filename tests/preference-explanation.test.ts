import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Candidate } from "@/domain/matching";
import { preferenceFulfillment } from "@/domain/matching-policy";
import { PreferenceExplanation } from "@/components/preference-explanation";

const person = (
  userId: string,
  traits: string[],
  desiredTraits: string[] = [],
): Candidate => ({
  id: userId,
  userId,
  age: 30,
  gender: "여성",
  mbti: [],
  interests: [],
  traits,
  desiredTraits,
});
const reasonFor = (me: Candidate, peers: Candidate[]) =>
  preferenceFulfillment(me, [me, ...peers])[0];
const htmlFor = (items: Parameters<typeof PreferenceExplanation>[0]["items"]) =>
  renderToStaticMarkup(createElement(PreferenceExplanation, { items }));

describe("preference reasons derived from fixed matching predicates", () => {
  it("explains normalized traits, counts peers once, and excludes self and private wishes", () => {
    const me = person("me", ["차분"], ["차분한 사람", "차분한 사람"]);
    const peer = person(
      "other",
      ["잔잔하고 조용한 편", "차분"],
      ["비공개 바람"],
    );
    const items = preferenceFulfillment(me, [me, peer, peer]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      satisfied: true,
      reason: { kind: "TRAIT", matchedCount: 1, comparedCount: 1 },
    });
    expect(items[0].reason.message).toContain("선택한 분이 1명");
    expect(JSON.stringify(items)).not.toContain("비공개 바람");
    expect(JSON.stringify(items)).not.toContain("other");
    const html = htmlFor(items);
    expect(html).toContain("이유:");
    expect(html).toContain(items[0].reason.message);
  });

  it("distinguishes no matching trait from missing comparison data", () => {
    const me = person("me", [], ["차분한 사람"]);
    const miss = reasonFor(me, [
      person("energetic", ["활기찬 편"]),
      person("missing", []),
    ]);
    expect(miss).toMatchObject({
      satisfied: false,
      reason: { kind: "TRAIT", comparedCount: 1, matchedCount: 0 },
    });
    expect(miss.reason.message).toContain("1명의 프로필 중에는");
    const missing = reasonFor(me, [person("missing", [])]);
    expect(missing.reason.kind).toBe("INSUFFICIENT_DATA");
    expect(htmlFor([missing])).toContain("확인할 정보가 부족해요");
    expect(htmlFor([missing])).not.toContain("프로필을 찾지 못했어요");
    expect(reasonFor(me, []).satisfied).toBe(false);
  });

  it.each([
    {
      wish: "나와 비슷한 사람",
      kind: "SIMILAR",
      expected: true,
      threshold: "절반 이상",
    },
    {
      wish: "다른 자극을 주는 사람",
      kind: "DIFFERENT",
      expected: false,
      threshold: "절반 미만",
    },
  ])(
    "uses union-based similarity at exactly one half for $kind",
    ({ wish, kind, expected, threshold }) => {
      const me = person("me", ["차분", "차분"], [wish]);
      const item = reasonFor(me, [person("peer", ["잔잔한 편", "활기찬 편"])]);
      expect(item.satisfied).toBe(expected);
      expect(item.reason).toMatchObject({
        kind,
        comparedCount: 1,
        matchedCount: Number(expected),
      });
      expect(item.reason.message).toContain(threshold);
      expect(item.reason.message).toMatch(/중복(을 뺀| 없이)/);
      expect(htmlFor([item])).toContain(item.reason.message);
    },
  );

  it("explains different traits only below half and missing own traits as unknown", () => {
    const me = person("me", ["차분"], ["다른 자극을 주는 사람"]);
    const peer = person("peer", ["활기찬 편"]);
    expect(reasonFor(me, [peer])).toMatchObject({
      satisfied: true,
      reason: { kind: "DIFFERENT", matchedCount: 1 },
    });
    me.desiredTraits = ["나와 비슷한 사람"];
    expect(reasonFor(me, [peer])).toMatchObject({
      satisfied: false,
      reason: { kind: "SIMILAR", matchedCount: 0 },
    });
    me.traits = [];
    expect(reasonFor(me, [peer]).reason.kind).toBe("INSUFFICIENT_DATA");
  });

  it("renders historical absence honestly and escapes free text", () => {
    expect(htmlFor([{ desire: "차분한 사람", satisfied: true }])).toContain(
      "당시의 구체적인 판단 이유는 확인하기 어려워요",
    );
    expect(htmlFor(null)).toContain("확정 당시의 기록이 없어");
    expect(htmlFor([])).toContain("선택한 희망 성향은 없어요");
    const me = person("me", [], ["<script>fake()</script>"]);
    const item = reasonFor(me, [person("peer", ["차분"])]);
    expect(htmlFor([item])).not.toContain("<script>");
    expect(htmlFor([item])).toContain("&lt;script&gt;");
  });
});
