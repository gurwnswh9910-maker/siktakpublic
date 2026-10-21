import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { atomic, db } from "../src/server/db";
import { command } from "../src/server/commands";
import { enqueue } from "../src/server/jobs";
import { ensureDemoScenario } from "../src/server/demo-scenario";
async function main() {
  if (process.env.DEMO_MODE !== "true")
    throw new Error("Demo seed requires DEMO_MODE=true");
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 12)
    throw new Error("Set DEMO_PASSWORD (12+ characters)");
  const hashed = await hashPassword(password);
  const names = [
    "서연",
    "지우",
    "민준",
    "수빈",
    "도윤",
    "하린",
    "유진",
    "지호",
    "예린",
  ];
  for (let i = 0; i < 13; i++) {
    const role =
      i === 9
        ? "ADMIN"
        : i === 10
          ? "OPERATIONS"
          : i === 11
            ? "SAFETY"
            : "PARTICIPANT";
    const email =
      i === 12
        ? "new@siktak.demo"
        : i === 9
          ? "admin@siktak.demo"
          : i === 10
            ? "ops@siktak.demo"
            : i === 11
              ? "safety@siktak.demo"
              : i === 0
                ? "hello@siktak.demo"
                : `guest${i}@siktak.demo`;
    if (await db.user.findUnique({ where: { email } })) continue;
    const id = `demo-user-${i}`;
    await db.user.create({
      data: {
        id,
        name:
          names[i] ??
          (i === 12
            ? "새로운 참가자"
            : role === "SAFETY"
              ? "안전 담당"
              : "운영 매니저"),
        email,
        emailVerified: true,
        role,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: id,
            providerId: "credential",
            password: hashed,
          },
        },
        ...(i < 9
          ? {
              profile: {
                create: {
                  contact: "010-0000-" + String(i).padStart(4, "0"),
                  birthYear: 1996 + (i % 5),
                  gender: i % 2 ? "남성" : "여성",
                  occupation: ["디자이너", "개발자", "마케터"][i % 3],
                  mbti: [["ENFP", "INTJ", "ISFP", "ENTJ"][i % 4]],
                  interests: ["여행", "음식", i % 2 ? "문화" : "운동"],
                  traits: ["편안한 대화", "새로운 경험"],
                  desiredTraits: ["편안한 대화", "새로운 경험"],
                  budgets: ["2만~3만원"],
                  foodRestrictions: "없음 (합성 입력)",
                  allergies: "없음 (합성 입력)",
                  consentVersion: "2026-10-v1",
                  consentAt: new Date(),
                },
              },
            }
          : {}),
      },
    });
  }
  for (let i = 0; i < 3; i++) {
    const id = `demo-event-${i}`;
    const start = new Date(Date.now() + (i + 3) * 86400000);
    start.setUTCHours(10, 30, 0, 0);
    await atomic(async (tx) => {
      // Keep edited dates, venues and completed events. Creating the event and
      // its job together also closes the old crash window between these writes.
      const event = await tx.eventSlot.upsert({
        where: { id },
        update: {},
        create: {
          id,
          title:
            i === 0
              ? "처음 만나는, 따뜻한 저녁"
              : i === 1
                ? "퇴근 후 새로운 이야기"
                : "취향이 만나는 식탁",
          region: ["홍대·합정", "강남·신논현", "종로·을지로"][i],
          startsAt: start,
          endsAt: new Date(start.getTime() + 7200000),
          closesAt: new Date(start.getTime() - 86400000),
          matchAt: new Date(start.getTime() - 86400000),
          cancelRefundCutoffAt: new Date(start.getTime() - 172800000),
          capacity: 24,
          venues: {
            create: {
              name: ["느린 식탁", "저녁의 온도", "작은 정원"][i] + " (가상)",
              address:
                "서울 " + ["마포구", "강남구", "종로구"][i] + " · 시연용 주소",
              mapUrl:
                "https://map.naver.com/p/search/" +
                encodeURIComponent(["합정역", "강남역", "종로3가역"][i]),
              reservationName: "우연한 식탁 데모",
              price: 25000,
              capacity: 6,
              totalTables: 6,
              dietaryNotes:
                "시연용 메뉴. 식이 제한과 알레르기는 운영자가 별도 확인합니다.",
            },
          },
        },
      });
      // Repair missing jobs left by older seeds, without resetting a DONE or
      // FAILED job or scheduling another match for an already finished event.
      if (event.status === "OPEN")
        await enqueue(
          tx,
          `match:${id}`,
          "MATCH",
          { eventId: id },
          event.matchAt,
        );
    });
  }
  for (let i = 1; i < 9; i++) {
    const requestId = `seed-application-${i}`;
    const actor = { id: `demo-user-${i}`, name: names[i], role: "PARTICIPANT" };
    const existing = await db.application.findUnique({
      where: { id: requestId },
      include: { payments: true, options: true },
    });
    const seedEventIds = ["demo-event-0", "demo-event-1"];
    if (
      existing &&
      (existing.userId !== actor.id ||
        existing.source !== "demo_generated" ||
        existing.ticketType !== "SINGLE" ||
        existing.applicationStatus !== "SUBMITTED" ||
        existing.paymentStatus !== "PENDING" ||
        existing.payments.length > 0 ||
        existing.options.some(
          (option) => !seedEventIds.includes(option.eventId),
        ))
    )
      continue;
    const account = await db.user.findUnique({ where: { id: actor.id } });
    if (
      !account ||
      account.role !== "PARTICIPANT" ||
      !["NONE", "WARNING"].includes(account.restriction)
    )
      continue;
    const events = await db.eventSlot.findMany({
      where: {
        id: {
          in: existing
            ? existing.options.map((option) => option.eventId)
            : seedEventIds,
        },
        status: "OPEN",
        closesAt: { gt: new Date() },
      },
    });
    // A restart after the demo dates have passed must not reopen them or fail
    // startup by trying to submit/pay an expired application.
    if (!events.length) continue;
    if (!existing)
      await command(actor, "apply", {
        requestId,
        eventIds: events.map((event) => event.id),
        ticketType: "SINGLE",
        consent: true,
      });
    // If startup stopped after apply, resume only this seed's untouched unpaid
    // application. The stable payment key prevents an extra charge on retries.
    await command(actor, "pay", {
      applicationId: requestId,
      requestId: `seed-payment-${i}`,
    });
  }
  const admin = await db.user.findUnique({
    where: { email: "admin@siktak.demo" },
  });
  const scenario = await ensureDemoScenario(admin?.id ?? "seed");
  if (scenario)
    console.log(`Demo scenario ready: ${scenario.title} (${scenario.applicants} paid applicants)`);
  await db.setting.upsert({
    where: { key: "automation" },
    create: { key: "automation", value: { retrySeconds: 30, maxAttempts: 3 } },
    update: {},
  });
  console.log(
    "Demo seed ready: hello@siktak.demo / admin@siktak.demo / ops@siktak.demo / safety@siktak.demo. Password is DEMO_PASSWORD.",
  );
}
main().finally(() => db.$disconnect());
