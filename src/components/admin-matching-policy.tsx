"use client";
import { defaultPolicy } from "@/domain/matching-policy";
import { Field } from "./shared";

export function AdminMatchingPolicy() {
  const labels = ["성비", "MBTI", "관심사", "희망 성향"];
  return (
    <section className="panel">
      <h2>매칭 기준</h2>
      <p className="muted">
        현재 매칭 기준은 고정되어 있어요. 연기자 배정 수, 전체 배정 수, 새로운
        만남을 차례로 우선한 뒤 합산 점수를 최대화하고, 마지막 일정인 참가자
        수로 동점을 구분해요.
      </p>
      <div className="stack">
        <Field label="최소 매칭 점수 (0~100)">
          <input type="number" value={defaultPolicy.minimum} readOnly />
        </Field>
        {labels.map((label, i) => (
          <Field key={label} label={`${label} 가중치`}>
            <input
              type="number"
              value={defaultPolicy.weights[i] * 48}
              readOnly
            />
          </Field>
        ))}
        <p className="muted">
          가중치 비율은 25:13:7:3으로 적용해요. 한 성별이 혼자인 경우 성비
          점수는 0점이에요. 이 화면에서는 기준을 변경할 수 없어요.
        </p>
      </div>
    </section>
  );
}
