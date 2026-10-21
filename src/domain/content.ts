export const contentCards = [
  {
    tag: "여행",
    title: "다시 가고 싶은 하루",
    body: "여행에서 다시 살아보고 싶은 하루가 있나요? 한 사람씩 장소와 이유를 1분씩 나눠요. 듣기만 해도 괜찮아요.",
  },
  {
    tag: "음식",
    title: "나만 아는 한 끼",
    body: "친구에게 꼭 소개하고 싶은 음식이나 식당을 골라주세요. 가장 궁금한 메뉴에 모두 한 표씩! 답하고 싶지 않으면 패스해요.",
  },
  {
    tag: "운동",
    title: "새로운 취미 한 가지",
    body: "시간과 실력에 상관없이 시작해보고 싶은 활동은? 돌아가며 하나씩 나누고 같이 해보고 싶은 사람은 손을 들어요.",
  },
  {
    tag: "문화",
    title: "요즘 나의 플레이리스트",
    body: "최근 마음에 남은 책, 영화, 음악 하나를 소개해요. 왜 좋았는지만 짧게 이야기해도 충분해요.",
  },
  {
    tag: "일상",
    title: "작은 행복 수집",
    body: "이번 주에 웃었던 순간 하나를 나눠요. 떠오르지 않으면 지금 기대하는 일도 좋아요. 참여는 자유예요.",
  },
  {
    tag: "일상",
    title: "우리의 밸런스 게임",
    body: "계획 없이 걷기 vs 목적지 정하고 걷기? 각자 고른 이유를 나누고 다음 질문을 함께 만들어봐요. 정답은 없어요.",
  },
];
export function pickContent(interests: string[], traits: string[] = []) {
  const likesDepth = traits.some((t) => t.includes("깊은"));
  const cards = [...contentCards];
  if (likesDepth)
    cards.push({
      tag: "깊은 대화",
      title: "요즘 달라진 생각",
      body: "최근 마음이 바뀌었던 작은 경험이 있나요? 한 사람이 이야기한 뒤 다음 사람이 먼저 인상 깊었던 부분을 짚어줘요. 민감한 이야기는 하지 않아도 되고 패스해도 괜찮아요.",
    });
  return cards
    .sort(
      (a, b) =>
        interests.filter((x) => x.includes(b.tag)).length +
        (b.tag === "깊은 대화" ? 2 : 0) -
        (interests.filter((x) => x.includes(a.tag)).length +
          (a.tag === "깊은 대화" ? 2 : 0)),
    )
    .slice(0, 3);
}
