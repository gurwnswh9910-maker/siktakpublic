import { expect, type Page } from "@playwright/test";

// Browser suites share one IP. Honor real 429s without relaxing auth limits.
export async function loginDemo(
  page: Page,
  email: string,
  destination: RegExp,
) {
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.DEMO_PASSWORD!);
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/sign-in/email") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "좋은 저녁 시작하기", exact: true })
      .click();
    const response = await pending;
    if (response.status() !== 429) {
      expect(response.status()).toBe(200);
      await expect(page).toHaveURL(destination);
      return;
    }
    const seconds = Number(
      response.headers()["retry-after"] ??
        response.headers()["x-retry-after"] ??
        10,
    );
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThanOrEqual(30);
    await page.waitForTimeout(Math.max(1, seconds) * 1000);
  }
  throw new Error("Login rate limit did not clear within the bounded retries");
}
