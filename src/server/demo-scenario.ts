import { randomUUID } from "node:crypto";
import { db, atomic, audit, ensure } from "./db";
import { command } from "./commands";
import { enqueue } from "./jobs";

// 심사·시연용 회차. 실제 신청·모의 결제 명령을 그대로 거치므로
// 매칭·안내·피드백 흐름은 운영 경로와 같다. DEMO_MODE에서만 동작한다.
export const DEMO_SCENARIO_PREFIX = "심사용 시연";
const SCENARIO_EMAIL = "@scenario.siktak.demo";

const places = [
  { region: "홍대·합정", venue: "느린 식탁", district: "마포구", station: "합정역" },
  { region: "잠실", venue: "호수 옆 저녁", district: "송파구", station: "잠실역" },
  { region: "강남·신논현", venue: "저녁의 온도", district: "강남구", station: "강남역" },
  { region: "종로·을지로", venue: "작은 정원", district: "중구", station: "을지로3가역" },
];

// 나이 차 8살 이내, 성비·MBTI·관심사가 섞이도록 고정한 합성 참가자.
const people = [
  { name: "도현", gender: "남성", birthYear: 1995, mbti: "INTJ", interests: ["여행", "음식", "운동"] },
  { name: "가은", gender: "여성", birthYear: 1997, mbti: "ESFJ", interests: ["음식", "문화", "여행"] },
  { name: "준호", gender: "남성", birthYear: 1996, mbti: "ENTP", interests: ["운동", "음식", "게임"] },
  { name: "소율", gender: "여성", birthYear: 1998, mbti: "INFP", interests: ["문화", "여행", "책"] },
  { name: "태윤", gender: "남성", birthYear: 1994, mbti: "ISTJ", interests: ["음식", "운동", "여행"] },
  { name: "나연", gender: "여성", birthYear: 1996, mbti: "ENFJ", interests: ["여행", "음식", "음악"] },
  { name: "시우", gender: "남성", birthYear: 1997, mbti: "ISFP", interests: ["음악", "문화", "음식"] },
  { name: "하은", gender: "여성", birthYear: 1995, mbti: "ESTP", interests: ["운동", "여행", "음식"] },
  { name: "민재", gender: "남성", birthYear: 1998, mbti: "ENFP", interests: ["여행", "게임", "음식"] },
  { name: "채원", gender: "여성", birthYear: 1994, mbti: "INTP", interests: ["책", "문화", "음식"] },
  { name: "건우", gender: "남성", birthYear: 1996, mbti: "ESFP", interests: ["음식", "운동", "음악"] },
];

const day = 86400000;

export async function createDemoScenario(actorId: string) {
  ensure(process.env.DEMO_MODE === "true", "시연 환경에서만 가능합니다.");
  const key = randomUUID().slice(0, 8);
  const existing = await db.eventSlot.count({
    where: { title: { startsWith: DEMO_SCENARIO_PREFIX } },
  });
  const place = places[existing % places.length];
  // 3일 뒤 19:30(한국 시간) 모임, 하루 전 마감·매칭.
  const startsAt = new Date(Date.now() + 3 * day);
  startsAt.setUTCHours(10, 30, 0, 0);
  const event = await atomic(async (tx) => {
    const e = await tx.eventSlot.create({
      data: {
        title: `${DEMO_SCENARIO_PREFIX} · ${place.region} 저녁`,
        region: place.region,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * 3600000),
        closesAt: new Date(startsAt.getTime() - day),
        matchAt: new Date(startsAt.getTime() - day),
        cancelRefundCutoffAt: new Date(startsAt.getTime() - 2 * day),
        capacity: 24,
        venues: {
          create: {
            name: `${place.venue} (가상)`,
            address: `서울 ${place.district} · 시연용 주소`,
            mapUrl:
              "https://map.naver.com/p/search/" +
              encodeURIComponent(place.station),
            reservationName: "우연한 식탁 시연",
            price: 25000,
            capacity: 6,
            totalTables: 4,
            dietaryNotes:
              "시연용 가상 식당입니다. 식이 제한과 알레르기는 운영자가 별도 확인합니다.",
            demo: true,
          },
        },
      },
    });
    await enqueue(tx, `match:${e.id}`, "MATCH", { eventId: e.id }, e.matchAt);
    await audit(tx, actorId, "DEMO_SCENARIO_CREATED", e.id);
    return e;
  });
  // 앞선 시연 회차가 끝난 합성 참가자는 다시 신청한다. 그래서 심사자가 남긴
  // 비선호·차단·만남 이력이 다음 매칭에 실제로 반영되는 모습을 볼 수 있다.
  const returning = await db.user.findMany({
    where: {
      email: { endsWith: SCENARIO_EMAIL },
      role: "PARTICIPANT",
      restriction: { in: ["NONE", "WARNING"] },
      profile: { isNot: null },
      applications: {
        none: {
          applicationStatus: { in: ["DRAFT", "SUBMITTED"] },
          options: { some: { event: { endsAt: { gt: new Date() } } } },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: people.length,
  });
  for (const [k, person] of people.entries()) {
    const back = returning[k];
    if (back) {
      await joinScenario(event.id, k, { id: back.id, name: back.name });
      continue;
    }
    const id = `demo-${key}-${k}`;
    await db.user.create({
      data: {
        id,
        name: person.name,
        email: `${key}-${k}${SCENARIO_EMAIL}`,
        emailVerified: true,
        role: "PARTICIPANT",
        profile: {
          create: {
            contact: "010-0000-" + String(k).padStart(4, "0"),
            birthYear: person.birthYear,
            gender: person.gender,
            occupation: ["디자이너", "개발자", "마케터", "연구원"][k % 4],
            mbti: [person.mbti],
            interests: person.interests,
            traits: ["편안한 대화", "새로운 경험"],
            desiredTraits: ["편안한 대화", "새로운 경험"],
            budgets: ["2만~3만원"],
            foodRestrictions: "없음 (합성 입력)",
            allergies: "없음 (합성 입력)",
            consentVersion: "2026-10-v1",
            consentAt: new Date(),
          },
        },
      },
    });
    await joinScenario(event.id, k, { id, name: person.name });
  }
  return {
    eventId: event.id,
    title: event.title,
    applicants: people.length,
    returning: returning.length,
  };
}

async function joinScenario(
  eventId: string,
  k: number,
  user: { id: string; name: string },
) {
  const actor = { ...user, role: "PARTICIPANT" };
  const requestId = `${eventId}-a${k}`;
  await command(actor, "apply", {
    requestId,
    eventIds: [eventId],
    ticketType: "SINGLE",
    consent: true,
  });
  await command(actor, "pay", {
    applicationId: requestId,
    requestId: `${eventId}-p${k}`,
  });
}

// 운영자 화면의 '심사용 시연 회차 만들기' 버튼.
export async function runDemoScenario(userId: string) {
  ensure(process.env.DEMO_MODE === "true", "시연 환경에서만 가능합니다.");
  const user = await db.user.findUnique({ where: { id: userId } });
  ensure(user, "로그인이 필요합니다.", 401);
  ensure(
    ["ADMIN", "OPERATIONS"].includes(user.role),
    "접근 권한이 없습니다.",
    403,
  );
  const open = await db.eventSlot.count({
    where: {
      title: { startsWith: DEMO_SCENARIO_PREFIX },
      status: "OPEN",
      closesAt: { gt: new Date() },
    },
  });
  ensure(open < 20, "열려 있는 시연 회차가 많습니다. 기존 회차를 먼저 사용해 주세요.");
  return createDemoScenario(user.id);
}

// 서버 시작 시 seed에서 호출한다. 신청 가능한 시연 회차가 없으면 하나 만든다.
export async function ensureDemoScenario(actorId: string) {
  const open = await db.eventSlot.count({
    where: {
      title: { startsWith: DEMO_SCENARIO_PREFIX },
      status: "OPEN",
      closesAt: { gt: new Date(Date.now() + 6 * 3600000) },
    },
  });
  if (open > 0) return null;
  return createDemoScenario(actorId);
}
