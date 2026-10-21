import { test, expect, type APIRequestContext } from "@playwright/test";

test("participant opts into and withdraws from waitlist while operator sets offer deadline", async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const suffix = `${Date.now()}`;
  const name = `대기 화면 참가자 ${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  async function command(
    request: APIRequestContext,
    action: string,
    data: unknown,
  ) {
    const response = await request.post("/api/command", {
      headers: { Origin: origin },
      data: { action, data },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const signup = await page.request.post("/api/auth/sign-up/email", {
    headers: { Origin: origin },
    data: {
      email: `browser-waitlist-${suffix}@example.test`,
      password: "Waitlist-browser-password-2026",
      name,
    },
  });
  expect(signup.ok()).toBe(true);
  await command(page.request, "profile", {
    name,
    contact: "01000008877",
    birthYear: 1997,
    gender: "기타",
    occupation: "디자이너",
    mbti: ["ENFP"],
    interests: ["여행"],
    traits: ["차분한"],
    desiredTraits: ["차분한"],
    budgets: ["2~3만원"],
    foodRestrictions: "없음",
    allergies: "없음",
    consent: true,
  });
  const operator = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  try {
    const admin = await operator.newPage();
    admin.on("pageerror", (error) => errors.push(error.message));
    const credentials = {
      email: "admin@siktak.demo",
      password: process.env.DEMO_PASSWORD!,
    };
    let signin = await operator.request.post("/api/auth/sign-in/email", {
      headers: { Origin: origin },
      data: credentials,
    });
    if (signin.status() === 429) {
      const retrySeconds = Number(
        signin.headers()["retry-after"] ??
          signin.headers()["x-retry-after"] ??
          1,
      );
      expect(retrySeconds).toBeLessThanOrEqual(30);
      await admin.waitForTimeout(Math.max(1, retrySeconds) * 1000);
      signin = await operator.request.post("/api/auth/sign-in/email", {
        headers: { Origin: origin },
        data: credentials,
      });
    }
    expect(signin.ok()).toBe(true);
    const future = (hours: number) =>
      new Date(Date.now() + hours * 3600000).toISOString();
    const event = await command(operator.request, "event", {
      title: `대기 UI 회차 ${suffix}`,
      region: "서울",
      startsAt: future(24),
      endsAt: future(26),
      closesAt: future(12),
      matchAt: future(18),
      cancelRefundCutoffAt: future(12),
      capacity: 24,
    });
    const applicationId = `browser-waitlist-application-${suffix}`;
    await command(page.request, "apply", {
      requestId: applicationId,
      eventIds: [event.id],
      ticketType: "SINGLE",
      consent: true,
    });
    await command(page.request, "pay", {
      applicationId,
      requestId: `browser-waitlist-payment-${suffix}`,
    });
    await page.goto(`/app?tab=detail&application=${applicationId}`);
    const panel = page.getByRole("region", { name: "취소 자리 대기" });
    await expect(panel).toContainText("자동 배정을 잠시 멈춰요");
    await panel.getByLabel("대기할 일정").selectOption(event.id);
    await panel.getByRole("button", { name: "취소 자리 대기 등록" }).click();
    await expect(panel).toContainText("자리 기다리는 중");
    await page.reload();
    await expect(panel).toContainText("자리 기다리는 중");
    const participantView = await (await page.request.get("/api/view")).json();
    const registered = participantView.applications.find(
      (application: { id: string }) => application.id === applicationId,
    );
    expect(registered.waitlist.status).toBe("WAITING");
    expect(registered.table).toBeNull();

    await admin.goto("/admin");
    await admin.getByRole("button", { name: "대기자", exact: true }).click();
    const entry = admin.getByRole("row").filter({ hasText: name });
    await expect(entry).toContainText("자리 기다리는 중");
    await expect(entry).toContainText("현재 대기 1번째");
    const settings = admin.locator("form").filter({ hasText: event.title });
    await expect(settings.getByLabel("새 제안의 응답 시간 (분)")).toHaveValue(
      "30",
    );
    await settings.getByLabel("새 제안의 응답 시간 (분)").fill("12");
    await settings.getByRole("button", { name: "응답 기한 저장" }).click();
    await expect(
      admin.getByText("변경 사항을 저장했어요.", { exact: true }),
    ).toBeVisible();
    await admin.reload();
    await admin.getByRole("button", { name: "대기자", exact: true }).click();
    await expect(settings.getByLabel("새 제안의 응답 시간 (분)")).toHaveValue(
      "12",
    );
    await expect(settings).toContainText("한국 시간");

    await panel.getByRole("button", { name: "대기 철회" }).click();
    await expect(panel.getByText("대기 철회", { exact: true })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "취소 자리 대기 등록" }),
    ).toBeVisible();
    await expect(entry).toContainText("대기 철회");
    const finalView = await (await page.request.get("/api/view")).json();
    const withdrawn = finalView.applications.find(
      (application: { id: string }) => application.id === applicationId,
    );
    expect(withdrawn.waitlist.status).toBe("WITHDRAWN");
    expect(withdrawn.applicationStatus).toBe("SUBMITTED");
    expect(withdrawn.paymentStatus).toBe("PAID");
    for (const screen of [page, admin]) {
      expect(
        await screen.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "test-results/waitlist-participant-mobile.png",
      fullPage: true,
    });
    await admin.screenshot({
      path: "test-results/waitlist-operator-mobile.png",
      fullPage: true,
    });
  } finally {
    await operator.close();
  }
});
