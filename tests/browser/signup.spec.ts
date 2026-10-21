import { test, expect } from "@playwright/test";

test("new account signs up, supplies consent, pays and logs in again on mobile", async ({
  page,
}) => {
  const email = `browser-signup-${Date.now()}@example.test`;
  const password = "Browser-signup-password-2026";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByRole("link", { name: "처음 오셨나요? 회원가입" }).click();
  await page.getByLabel("이름", { exact: true }).fill("가입 검증 참가자");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page
    .getByLabel("비밀번호 확인", { exact: true })
    .fill("Different-password");
  await page.getByRole("button", { name: "가입하고 프로필 작성하기" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "일치하지",
  );
  await page.getByLabel("비밀번호 확인", { exact: true }).fill(password);
  await page.getByRole("button", { name: "가입하고 프로필 작성하기" }).click();
  await expect(page).toHaveURL(/\/app\?tab=profile$/);
  expect((await page.request.get("/api/view?admin=1")).status()).toBe(403);
  const view = await (await page.request.get("/api/view")).json();
  const event = view.events.find(
    (e: { status: string; closesAt: string }) =>
      e.status === "OPEN" && new Date(e.closesAt) > new Date(),
  );
  expect(event).toBeTruthy();
  const withoutProfile = await page.request.post("/api/command", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      action: "apply",
      data: {
        requestId: `incomplete-${Date.now()}`,
        eventIds: [event.id],
        ticketType: "SINGLE",
        consent: true,
      },
    },
  });
  expect(withoutProfile.ok()).toBe(false);
  await page.getByLabel("연락처", { exact: true }).fill("01000008888");
  await page.getByLabel("출생연도", { exact: true }).fill("1997");
  await page.getByLabel("직업", { exact: true }).fill("디자이너");
  for (const name of [
    "mbti",
    "interests",
    "traits",
    "desiredTraits",
    "budgets",
  ])
    await page.locator(`input[name="${name}"]`).first().check();
  await page
    .getByLabel("못 먹는 음식·기호 (없으면 없음)", { exact: true })
    .fill("없음");
  await page.getByLabel("알레르기 (없으면 없음)", { exact: true }).fill("없음");
  await page.locator('input[name="consent"]').check();
  await page.getByRole("button", { name: "프로필 저장" }).click();
  await page.goto("/app");
  await page.getByRole("button", { name: "이번 식탁 둘러보기" }).click();
  if (!(await page.locator('input[name="eventIds"]').count()))
    await page.locator(".event-card").first().click();
  await page.locator('input[name="eventIds"]').first().check();
  await page.locator('input[name="consent"]').check();
  await page.getByRole("button", { name: "신청하고 결제하기" }).click();
  await page.getByRole("button", { name: "모의 결제 완료하기" }).click();
  await expect(page.getByText("결제 완료", { exact: true })).toBeVisible();
  await page.goto("/app?tab=mine");
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/view")).status()).toBe(401);
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "좋은 저녁 시작하기" }).click();
  await expect(page).toHaveURL(/\/app$/);
  const persisted = await (await page.request.get("/api/view")).json();
  expect(persisted.user.profile).toBeTruthy();
  expect(
    persisted.applications.some(
      (a: { paymentStatus: string }) => a.paymentStatus === "PAID",
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/signup-mobile.png",
    fullPage: true,
  });
});
