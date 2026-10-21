import { expect, test } from "@playwright/test";

test("operator authors, previews, publishes and stops content on mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill("admin@siktak.demo");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.DEMO_PASSWORD!);
  await page.getByRole("button", { name: "좋은 저녁 시작하기" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("button", { name: "콘텐츠", exact: true }).click();
  const title = `모바일 콘텐츠 ${Date.now()}`;
  const body =
    "여행에서 기억나는 한 순간을 나눠요. 답변은 건너뛰어도 괜찮아요.";
  await page
    .getByRole("textbox", { name: "콘텐츠 제목", exact: true })
    .fill(title);
  await page
    .getByRole("textbox", { name: "콘텐츠 본문", exact: true })
    .fill(body);
  await page
    .getByRole("combobox", { name: "콘텐츠 유형", exact: true })
    .selectOption("ACTIVITY");
  await page
    .getByRole("combobox", { name: "테이블 태그", exact: true })
    .selectOption("여행");
  await page
    .getByRole("button", { name: "입력 내용 미리보기", exact: true })
    .click();
  await expect(
    page.getByLabel("콘텐츠 미리보기", { exact: true }),
  ).toContainText(body);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  const item = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(item).toContainText("초안 · 수정 버전 1");
  await item
    .getByRole("button", { name: "저장한 초안 게시", exact: true })
    .click();
  await expect(item).toContainText("게시 중 · 게시 버전 2");
  await item.getByRole("button", { name: "편집", exact: true }).click();
  await page
    .getByRole("textbox", { name: "콘텐츠 본문", exact: true })
    .fill("아직 게시하지 않은 새 초안입니다.");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(item).toContainText("수정 버전 3");
  await item
    .getByRole("button", { name: "게시본 미리보기", exact: true })
    .click();
  await expect(
    page.getByLabel("콘텐츠 미리보기", { exact: true }),
  ).toContainText(body);
  await item.getByRole("button", { name: "게시 중지", exact: true }).click();
  await expect(item).toContainText("게시 중지 · 수정 버전 4");
  await expect(
    item.getByRole("button", { name: "게시 중지", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/content-catalog-mobile.png",
    fullPage: true,
  });
  // The development-only Next badge overlaps the fixed mobile sidebar footer.
  // Exercise the actual logout control through its accessible keyboard path.
  const logout = page.getByRole("button", { name: "로그아웃", exact: true });
  await expect(logout).toBeVisible();
  await logout.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
});
