import { test, expect } from "@playwright/test";
import { loginDemo } from "./demo-login";

test("privacy request UI keeps duplicate scope and rejects a different pending intent", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemo(page, "hello@siktak.demo", /\/app$/);
  await page.goto("/app?tab=mine");
  const section = page.getByRole("region", {
    name: "개인정보 요청",
    exact: true,
  });
  await expect(section).toContainText("와썹하우스 담당자가 요청을 확인하고");
  const submit = async (name: string) => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/command") &&
        r.request().postDataJSON()?.action === "privacyRequest",
    );
    await section.getByRole("button", { name, exact: true }).click();
    return response;
  };
  expect((await submit("개인정보 삭제 검토 요청")).status()).toBe(200);
  await expect(section).toContainText("개인정보 삭제 요청 · 접수");
  const original = (await (await page.request.get("/api/view")).json())
    .privacyRequests[0];
  expect((await submit("탈퇴 검토 요청")).status()).toBe(409);
  await expect(
    page.getByRole("alert").filter({ hasText: "다른 종류" }),
  ).toBeVisible();
  await expect(
    page.getByText("변경 사항을 저장했어요.", { exact: true }),
  ).toHaveCount(0);
  expect((await submit("개인정보 삭제 검토 요청")).status()).toBe(200);
  const requests = (await (await page.request.get("/api/view")).json())
    .privacyRequests;
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    id: original.id,
    status: "OPEN",
    reason: "개인정보 삭제 요청",
  });
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/privacy-request-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});
