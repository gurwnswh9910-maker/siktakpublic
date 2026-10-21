import type { PreferenceFulfillment } from "@/domain/matching-policy";

export function PreferenceExplanation({
  items,
}: {
  items: PreferenceFulfillment[] | null;
}) {
  return (
    <section className="card stack" aria-label="희망 성향과 매칭 사유">
      <h3>내가 바란 만남, 이번 식탁은요</h3>
      <p className="small muted">
        모임이 확정될 때의 프로필과 내가 선택한 희망 성향을 살펴봤어요. 실제
        성향이나 대화 경험과는 다를 수 있어요.
      </p>
      {items === null ? (
        <p>
          이 모임은 확정 당시의 기록이 없어 희망 성향별 안내를 보여드리기
          어려워요.
        </p>
      ) : items.length === 0 ? (
        <p>따로 선택한 희망 성향은 없어요.</p>
      ) : (
        items.map((p) => (
          <div key={p.desire}>
            <strong>“{p.desire}”</strong>
            <p>
              {p.reason?.kind === "INSUFFICIENT_DATA"
                ? "이 바람과 맞는지 확인할 정보가 부족해요."
                : p.satisfied
                  ? "프로필을 기준으로, 원하신 성향에 맞는 분이 함께해요."
                  : "이번 식탁에서는 이 바람에 맞는 프로필을 찾지 못했어요."}
            </p>
            <p className="small muted">
              <strong>이유: </strong>
              {p.reason?.message ??
                "이 모임에는 일치 여부만 저장되어 있어, 당시의 구체적인 판단 이유는 확인하기 어려워요."}
            </p>
          </div>
        ))
      )}
    </section>
  );
}
