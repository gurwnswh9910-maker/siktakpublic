import { test, expect } from "@playwright/test";

for (const signup of [false, true]) {
  test(`${signup ? "signup" : "login"} waits for hydration before accepting credentials`, async ({
    page,
  }) => {
    let releaseScripts!: () => void;
    const scriptsReady = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    await page.route("**/_next/**", async (route) => {
      if (route.request().resourceType() === "script") await scriptsReady;
      await route.continue();
    });
    try {
      await page.goto(signup ? "/signup" : "/login", { waitUntil: "commit" });
      const email = page.getByLabel("이메일", { exact: true });
      await expect(email).toBeVisible();
      await expect(email).toBeDisabled({ timeout: 3000 });
      await expect(page.getByLabel("비밀번호", { exact: true })).toBeDisabled();
      await expect(
        page.getByRole("button", {
          name: signup ? "가입하고 프로필 작성하기" : "좋은 저녁 시작하기",
          exact: true,
        }),
      ).toBeDisabled();
      if (signup) {
        await expect(page.getByLabel("이름", { exact: true })).toBeDisabled();
        await expect(
          page.getByLabel("비밀번호 확인", { exact: true }),
        ).toBeDisabled();
      } else {
        await expect(
          page.getByRole("button", { name: "참가자", exact: true }),
        ).toBeDisabled();
        await expect(
          page.getByRole("button", { name: "운영자", exact: true }),
        ).toBeDisabled();
      }
      releaseScripts();
      await expect(email).toBeEnabled();
      await expect(
        page.getByRole("button", {
          name: signup ? "가입하고 프로필 작성하기" : "좋은 저녁 시작하기",
          exact: true,
        }),
      ).toBeEnabled();
      await email.fill("hydrated-entry@example.test");
      await page
        .getByLabel("비밀번호", { exact: true })
        .fill("Hydrated-test-password");
      await expect(email).toHaveValue("hydrated-entry@example.test");
    } finally {
      releaseScripts();
    }
  });
}

test("login submits the visible autofilled email without relying on change events", async ({
  page,
}) => {
  await page.goto("/login");
  const email = page.getByLabel("이메일", { exact: true });
  // Exercise both real demo controls to establish that hydration is complete.
  await page.getByRole("button", { name: "운영자", exact: true }).click();
  await expect(email).toHaveValue("admin@siktak.demo");
  await page.getByRole("button", { name: "참가자", exact: true }).click();
  await expect(email).toHaveValue("hello@siktak.demo");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.DEMO_PASSWORD!);
  // A browser/password manager can change the native field without a React
  // change event. The actual form values must remain the submitted credentials.
  await email.evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "admin@siktak.demo");
  });
  await expect(email).toHaveValue("admin@siktak.demo");
  const pending = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/auth/sign-in/email" &&
      request.method() === "POST",
  );
  await page
    .getByRole("button", { name: "좋은 저녁 시작하기", exact: true })
    .click();
  const sent = await pending;
  expect(sent.postDataJSON().email).toBe("admin@siktak.demo");
  await expect(page).toHaveURL(/\/admin$/);
  const view = await page.request.get("/api/view?admin=1");
  expect(view.status()).toBe(200);
  expect((await view.json()).user.role).toBe("ADMIN");
  const logout = page.getByRole("button", { name: "로그아웃", exact: true });
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    const lastMenu = page
      .getByRole("navigation", { name: "운영 메뉴", exact: true })
      .getByRole("button", { name: "안전 관리", exact: true });
    await lastMenu.click();
    await expect(lastMenu).toBeInViewport();
    await expect(logout).toBeInViewport();
    const bounds = await logout.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await logout.click();
  await expect(page).toHaveURL(/\/login$/);
});
