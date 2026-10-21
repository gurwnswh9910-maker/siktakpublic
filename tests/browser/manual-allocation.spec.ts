import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

test("operator previews and moves a table through the mobile UI", async ({
  page,
}) => {
  test.setTimeout(120000);
  const db = new PrismaClient();
  const prefix = `manual-ui-${Date.now()}`;
  const start = new Date(Date.now() + 5 * 86400000);
  try {
    for (let i = 0; i < 2; i++)
      await db.eventSlot.create({
        data: {
          id: `${prefix}-event${i}`,
          title: `${prefix} 회차 ${i}`,
          region: "홍대",
          startsAt: new Date(+start + i * 86400000),
          endsAt: new Date(+start + i * 86400000 + 7200000),
          closesAt: new Date(+start - 86400000),
          matchAt: new Date(+start - 86400000),
          cancelRefundCutoffAt: new Date(+start - 172800000),
          capacity: 12,
          venues: {
            create: {
              id: `${prefix}-venue${i}`,
              name: `${prefix} 식당 ${i}`,
              address: "합성 검사",
              mapUrl: "https://map.naver.com",
              reservationName: "합성 검사",
              price: 25000,
              capacity: 6,
              totalTables: 3,
              dietaryNotes: "없음",
            },
          },
        },
      });
    await db.diningTable.create({
      data: {
        id: `${prefix}-table`,
        eventId: `${prefix}-event0`,
        venueSlotId: `${prefix}-venue0`,
        runId: prefix,
        score: 0,
        evaluation: {},
        explanation: "모바일 배정 검사",
        room: { create: {} },
      },
    });
    for (let i = 0; i < 4; i++)
      await db.user.create({
        data: {
          id: `${prefix}-user${i}`,
          name: `${prefix} 참가자 ${i}`,
          email: `${prefix}-${i}@example.test`,
          profile: {
            create: {
              contact: "01000000000",
              birthYear: 1997,
              gender: "기타",
              occupation: "합성 검사",
              mbti: ["INTJ"],
              interests: ["여행"],
              traits: ["차분한"],
              desiredTraits: ["차분한"],
              budgets: ["2만원"],
              foodRestrictions: "없음",
              allergies: "없음",
              consentVersion: "test",
              consentAt: new Date(),
            },
          },
          applications: {
            create: {
              id: `${prefix}-app${i}`,
              ticketType: "SINGLE",
              applicationStatus: "SUBMITTED",
              paymentStatus: "PAID",
              matchStatus: "CONFIRMED",
              tableId: `${prefix}-table`,
              options: {
                create: [
                  { eventId: `${prefix}-event0` },
                  { eventId: `${prefix}-event1` },
                ],
              },
            },
          },
        },
      });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await page.getByLabel("이메일", { exact: true }).fill("admin@siktak.demo");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill(process.env.DEMO_PASSWORD!);
    await page.getByRole("button", { name: "좋은 저녁 시작하기" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page
      .getByRole("button", { name: "매칭·테이블", exact: true })
      .click();
    const editor = page.getByRole("region", { name: "운영자 배정 수정" });
    await editor.getByRole("checkbox", { name: new RegExp(prefix) }).check();
    await editor.getByLabel("새 식탁 1 회차").selectOption(`${prefix}-event1`);
    await editor
      .getByLabel("변경 사유 (참가자에게 안내됩니다)")
      .fill("모바일 검사: 예약 식당을 변경합니다.");
    await editor
      .getByRole("button", { name: "변경 미리보기", exact: true })
      .click();
    await expect(
      editor.getByText("각 원본 식탁의 실제 운영 예외를 먼저 등록해 주세요."),
    ).toBeVisible();
    await editor
      .getByRole("button", { name: "실제 운영 예외 등록", exact: true })
      .click();
    await expect(editor.getByRole("status")).toContainText(
      "운영 예외를 등록했습니다.",
    );
    await editor
      .getByRole("button", { name: "변경 미리보기", exact: true })
      .click();
    await expect(editor.getByText("적용 가능한 변경입니다")).toBeVisible();
    await expect(editor.getByLabel("배정 변경 미리보기")).toContainText(
      `${prefix} 식당 1`,
    );
    await expect(editor.getByLabel("배정 변경 미리보기")).toContainText(
      "배정 해제: 없음",
    );
    await editor
      .getByRole("button", { name: "미리보기대로 배정 변경" })
      .click();
    await expect(editor.getByRole("status")).toContainText(
      "배정을 변경하고 새 안내를 예약했어요.",
    );
    const assigned = await db.application.findUniqueOrThrow({
      where: { id: `${prefix}-app0` },
      include: { table: true },
    });
    expect(assigned.table?.eventId).toBe(`${prefix}-event1`);
    expect(
      (
        await db.diningTable.findUniqueOrThrow({
          where: { id: `${prefix}-table` },
        })
      ).status,
    ).toBe("REPLACED");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "test-results/manual-allocation-mobile.png",
      fullPage: true,
    });
  } finally {
    await db.$disconnect();
  }
});
