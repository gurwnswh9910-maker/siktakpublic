import {
  test,
  expect,
  chromium,
  type Page,
  type Worker,
} from "@playwright/test";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.DEMO_PASSWORD!);
  const submit = async () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/sign-in/email") &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "좋은 저녁 시작하기" }).click();
    return response;
  };
  let response = await submit();
  if (response.status() === 429) {
    // Several UI journeys share one local IP; honor the real authentication limit.
    const retrySeconds = Number(
      response.headers()["retry-after"] ??
        response.headers()["x-retry-after"] ??
        1,
    );
    expect(retrySeconds).toBeLessThanOrEqual(30);
    await page.waitForTimeout(Math.max(1, retrySeconds) * 1000);
    response = await submit();
  }
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(
    /^(hello|new|guest)/.test(email) ? /\/app$/ : /\/admin$/,
  );
}
test("participant and operator complete one dining cycle through the actual UI", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "hello@siktak.demo");
  await page
    .getByRole("button", { name: "이번 식탁 둘러보기" })
    .first()
    .click();
  // Event cards and the home CTA lead to the same server-backed draft flow.
  if (!(await page.locator('input[name="eventIds"]').count())) {
    await page
      .getByRole("button", { name: /처음 만나는, 따뜻한 저녁/ })
      .click();
  }
  await page.locator('input[value="demo-event-0"]').check();
  await page.locator('input[name="consent"]').check();
  await page.getByRole("button", { name: "신청하고 결제하기" }).click();
  await page.getByRole("button", { name: "모의 결제 완료하기" }).click();
  await expect(page.getByText("결제 완료", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "다음 안내 일정" }),
  ).toContainText("매칭 결과 안내");
  await expect(
    page.getByRole("region", { name: "다음 안내 일정" }),
  ).toContainText("한국 시간");
  const pendingView = await (await page.request.get("/api/view")).json();
  const pendingEvent = pendingView.events.find(
    (event: { id: string }) => event.id === "demo-event-0",
  );
  expect(new Date(pendingEvent.matchAt).getTime()).toBeGreaterThan(Date.now());
  const scheduledMatchAt = new Date(pendingEvent.matchAt);
  const expectedMatchTime =
    scheduledMatchAt.toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "long",
      day: "numeric",
      weekday: "short",
    }) +
    " " +
    scheduledMatchAt.toLocaleTimeString("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) +
    " (한국 시간)";
  await page.reload();
  await expect(page.getByLabel("신청·결제·매칭 상태")).toContainText(
    "신청 완료",
  );
  await expect(page.getByLabel("신청·결제·매칭 상태")).toContainText(
    "결제 완료",
  );
  await expect(page.getByLabel("신청·결제·매칭 상태")).toContainText(
    "매칭 대기",
  );
  const nextNotice = page.getByRole("region", { name: "다음 안내 일정" });
  await expect(nextNotice).toContainText("매칭 결과 안내 · 예정");
  await expect(nextNotice).toContainText(expectedMatchTime);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "진행 상황 확인하기" })
    .first()
    .click();
  await expect(nextNotice).toContainText("매칭 결과 안내 · 예정");
  await expect(nextNotice).toContainText(expectedMatchTime);

  const operator = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const admin = await operator.newPage();
  await login(admin, "admin@siktak.demo");
  await expect(
    admin.getByRole("region", { name: "유형별 운영 현황" }),
  ).toContainText("행사 당일 취소");
  await admin.getByRole("button", { name: "회차·식당" }).click();
  const row = admin
    .getByRole("row")
    .filter({ hasText: "처음 만나는, 따뜻한 저녁" })
    .first();
  await row.getByRole("button", { name: "매칭 시각", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "우리 단체방으로" }),
  ).toBeVisible();
  await admin.getByRole("button", { name: "매칭·테이블", exact: true }).click();
  await admin
    .getByText("확정 당시 조건·재배치 이력", { exact: true })
    .first()
    .click();
  await expect(admin.getByText(/확정 당시 [4-6]명/).first()).toBeVisible();
  await expect(
    admin.getByText("동의한 조합 충족", { exact: true }).first(),
  ).toBeVisible();
  await admin
    .getByText("단체방·안내 처리 현황", { exact: true })
    .first()
    .click();
  const tableNotices = admin
    .getByRole("region", { name: "테이블 단체방·안내 처리 현황" })
    .first();
  await expect(tableNotices).toContainText("단체방 최근 메시지");
  await expect(tableNotices).toContainText("가상 식당·모의 예약");
  await expect(tableNotices).toContainText("함께할 식탁이 정해졌어요");
  expect(
    await admin.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const factsTable = admin.locator("article.table-detail .data-table").first();
  expect(
    await factsTable.evaluate((element) => ({
      fitsViewport: element.getBoundingClientRect().right <= innerWidth,
      retainsScrollableColumns: element.scrollWidth > element.clientWidth,
    })),
  ).toEqual({ fitsViewport: true, retainsScrollableColumns: true });
  await admin.getByRole("button", { name: "회차·식당", exact: true }).click();
  await page.getByRole("button", { name: "우리 단체방으로" }).click();
  await page
    .locator('input[name="body"]')
    .fill("안녕하세요. 오늘의 만남이 기대돼요!");
  await page.getByRole("button", { name: "메시지 보내기" }).click();
  await expect(
    page.getByText("안녕하세요. 오늘의 만남이 기대돼요!", { exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "시작 시각", exact: true }).click();
  await expect(page.locator(".message.system")).toHaveCount(4);
  await page.goto("/app?tab=detail");
  await page.getByRole("button", { name: "체크인하기" }).click();
  await expect(page.getByRole("button", { name: "참석 완료" })).toBeVisible();
  await row.getByRole("button", { name: "종료 시각", exact: true }).click();
  await page.getByRole("button", { name: "피드백 남기기" }).click();
  await page.getByLabel("남기고 싶은 이야기").fill("좋은 이야기를 나눴어요.");
  await page.getByRole("button", { name: "비공개 피드백 저장" }).click();
  await expect(page.getByRole("button", { name: /피드백 완료/ })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/participant-mobile.png",
    fullPage: true,
  });
  await admin.getByRole("button", { name: "운영 개요", exact: true }).click();
  await expect(
    admin.locator(".check-row").filter({ hasText: "노쇼 검토 후보" }),
  ).toContainText("8");
  await admin.screenshot({
    path: "test-results/operator-desktop.png",
    fullPage: true,
  });
  await operator.close();
});

test("new participant completes profile and application on a 390px screen", async ({
  page,
}) => {
  const started = Date.now();
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "new@siktak.demo");
  await page.getByRole("button", { name: "이번 식탁 둘러보기" }).click();
  await page.locator(".event-card").first().click();
  await page.getByLabel("연락처", { exact: true }).fill("01000009999");
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
  await page.locator('input[name="eventIds"]').first().check();
  await page.locator('input[name="ticketType"][value="MEMBERSHIP_1"]').check();
  await page.getByText("참가·취소·안전 안내", { exact: true }).click();
  await expect(page.locator("details.policy")).toContainText(
    "(한국 시간)부터 변심 환불이 제한됩니다.",
  );
  await page.locator('input[name="consent"]').check();
  await page.getByRole("button", { name: "신청하고 결제하기" }).click();
  await page.getByRole("button", { name: "모의 결제 완료하기" }).click();
  await expect(page.getByText("결제 완료", { exact: true })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(300000);
  await page.getByRole("button", { name: "마이", exact: true }).click();
  const tickets = page.getByRole("region", { name: "보유 이용권 유효기간" });
  await expect(tickets).toContainText("멤버십 · 기간 내 무제한");
  await expect(tickets).toContainText("(한국 시간) 만료");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("service worker receives a synthetic push event and shows one deduplicated notification", async ({}, testInfo) => {
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath("push-profile"),
    {
      channel: "chromium",
      headless: true,
      permissions: ["notifications"],
      baseURL: "http://localhost:3100",
    },
  );
  const page = await context.newPage();
  let worker: Worker | undefined;
  const diagnostics: Record<string, unknown> = {
    browserVersion: context.browser()?.version(),
  };
  const workerEvents: unknown[] = [];
  try {
    await page.goto("/login");
    const scopeURL = await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      return (await navigator.serviceWorker.ready).scope;
    });
    // ready can resolve while the active worker is still activating.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return registration.active?.state;
        }),
      )
      .toBe("activated");
    await expect
      .poll(() =>
        context.serviceWorkers().find((item) => item.url().endsWith("/sw.js")),
      )
      .toBeDefined();
    worker = context
      .serviceWorkers()
      .find((item) => item.url().endsWith("/sw.js"))!;
    // Observe the real handler and its native waitUntil promises without replacing
    // push dispatch, showNotification, or notification storage with test doubles.
    await worker.evaluate(`(() => {
      const diagnostics = self.__pushDiagnostics = {
        permission: Notification.permission,
        userAgent: navigator.userAgent,
        events: [], waits: [], errors: []
      };
      self.addEventListener('push', event => diagnostics.events.push({
        trusted: event.isTrusted, data: event.data?.text()
      }));
      self.addEventListener('error', event => diagnostics.errors.push(event.message));
      self.addEventListener('unhandledrejection', event => diagnostics.errors.push(String(event.reason)));
      const nativeWaitUntil = ExtendableEvent.prototype.waitUntil;
      ExtendableEvent.prototype.waitUntil = function(promise) {
        const result = nativeWaitUntil.call(this, promise);
        if (this.type === 'push') Promise.resolve(promise).then(
          () => diagnostics.waits.push({ status: 'fulfilled' }),
          error => diagnostics.waits.push({ status: 'rejected', error: String(error), stack: error?.stack })
        );
        return result;
      };
    })()`);
    const cdp = await context.newCDPSession(page);
    cdp.on("BackgroundService.backgroundServiceEventReceived", (event) =>
      workerEvents.push(event),
    );
    await cdp.send("BackgroundService.startObserving", {
      service: "pushMessaging",
    });
    await cdp.send("BackgroundService.setRecording", {
      service: "pushMessaging",
      shouldRecord: true,
    });
    cdp.on("ServiceWorker.workerErrorReported", (event) =>
      workerEvents.push(event),
    );
    cdp.on("ServiceWorker.workerVersionUpdated", (event) =>
      workerEvents.push(event),
    );
    const registrations = new Map<
      string,
      { registrationId: string; scopeURL: string; isDeleted: boolean }
    >();
    cdp.on(
      "ServiceWorker.workerRegistrationUpdated",
      ({ registrations: items }) => {
        for (const registration of items)
          registrations.set(registration.registrationId, registration);
      },
    );
    await cdp.send("ServiceWorker.enable");
    const findRegistration = () =>
      [...registrations.values()].find(
        (registration) =>
          registration.scopeURL === scopeURL && !registration.isDeleted,
      );
    await expect.poll(findRegistration).toBeDefined();
    const registration = findRegistration()!;
    for (const [index, body] of [
      "서비스 워커 수신 검증",
      "같은 알림의 재전달 검증",
    ].entries()) {
      await cdp.send("ServiceWorker.deliverPushMessage", {
        origin: new URL(page.url()).origin,
        registrationId: registration.registrationId,
        data: JSON.stringify({
          id: "synthetic-notice",
          title: "함께할 식탁이 정해졌어요",
          body,
          url: "/app?tab=detail",
        }),
      });
      // CDP delivery does not wait for the push event's showNotification promise.
      // Querying before display finishes can make Chromium discard the record
      // while reconciling it with the platform's displayed notifications.
      await expect
        .poll(() =>
          worker!.evaluate(`({
          pushCount: self.__pushDiagnostics.events.length,
          waits: self.__pushDiagnostics.waits
        })`),
        )
        .toEqual({
          pushCount: index + 1,
          waits: Array.from({ length: index + 1 }, () => ({
            status: "fulfilled",
          })),
        });
      // A distinct body proves the second push completed and replaced the first.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            const notifications = await registration.getNotifications();
            return notifications.map((notification) => ({
              title: notification.title,
              tag: notification.tag,
              body: notification.body,
              url: notification.data?.url,
            }));
          }),
        )
        .toEqual([
          {
            title: "함께할 식탁이 정해졌어요",
            tag: "synthetic-notice",
            body,
            url: "/app?tab=detail",
          },
        ]);
    }
  } catch (error) {
    diagnostics.workerEvents = workerEvents;
    diagnostics.page = await page
      .evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return {
          secureContext: isSecureContext,
          permission: Notification.permission,
          permissionQuery: (
            await navigator.permissions.query({ name: "notifications" })
          ).state,
          scope: registration?.scope,
          activeState: registration?.active?.state,
          controller: navigator.serviceWorker.controller?.scriptURL,
        };
      })
      .catch(String);
    diagnostics.worker = await worker
      ?.evaluate("self.__pushDiagnostics")
      .catch(String);
    // A separate native probe distinguishes absent CDP dispatch from a platform
    // notification failure. It runs only after the actual assertion has failed.
    diagnostics.nativeProbe = await worker
      ?.evaluate(
        `(async () => {
      try {
        await self.registration.showNotification('Synthetic native diagnostic', {
          body: 'Failure diagnostics only', tag: 'synthetic-native-diagnostic'
        });
        return { status: 'fulfilled', notifications: (await self.registration.getNotifications()).map(n => ({ title: n.title, tag: n.tag })) };
      } catch (error) {
        return { status: 'rejected', error: String(error), stack: error?.stack };
      }
    })()`,
      )
      .catch(String);
    const report = JSON.stringify(diagnostics, null, 2);
    console.error(`Synthetic push diagnostics:\n${report}`);
    await testInfo.attach("synthetic-push-diagnostics", {
      body: report,
      contentType: "application/json",
    });
    throw error;
  } finally {
    await context.close();
  }
});

test("sessions and role boundaries survive fresh browser access", async ({
  page,
  browser,
}) => {
  expect((await page.request.get("/api/view")).status()).toBe(401);
  expect((await page.request.get("/api/export")).status()).toBe(401);
  await login(page, "hello@siktak.demo");
  expect((await page.request.get("/api/view?admin=1")).status()).toBe(403);
  expect((await page.request.get("/api/export")).status()).toBe(403);
  const unsafe = await page.request.post("/api/command", {
    headers: { Origin: "https://untrusted.example" },
    data: { action: "draft", input: { requestId: "forged" } },
  });
  expect(unsafe.status()).toBe(403);
  const safety = await browser.newContext();
  const staff = await safety.newPage();
  await login(staff, "safety@siktak.demo");
  await expect(staff.getByRole("button", { name: "안전 관리" })).toBeVisible();
  await expect(staff.getByRole("button", { name: "신청·결제" })).toHaveCount(0);
  await safety.close();
});

test("logout detaches this browser's push device before revoking its session", async ({
  page,
}) => {
  await login(page, "hello@siktak.demo");
  const endpoint = "https://fcm.googleapis.com/synthetic-sign-out-device";
  const subscribed = await page.request.post("/api/command", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      action: "subscribe",
      data: {
        endpoint,
        keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
      },
    },
  });
  expect(subscribed.status()).toBe(200);
  await page.goto("/app?tab=mine");
  // The browser subscription is a fixture; detachment and sign-out use the real server.
  await page.evaluate((endpoint) => {
    Object.defineProperty(navigator.serviceWorker, "getRegistration", {
      value: async () => ({
        pushManager: {
          getSubscription: async () => ({
            endpoint,
            unsubscribe: async () => true,
          }),
        },
        getNotifications: async () => [],
      }),
    });
  }, endpoint);
  const detached = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/command") &&
      response.request().postDataJSON()?.action === "unsubscribe",
  );
  await page.getByRole("button", { name: "로그아웃" }).click();
  expect((await detached).status()).toBe(200);
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/view")).status()).toBe(401);
});

test("operator saves all three automatic notification templates in the UI", async ({
  page,
}) => {
  await login(page, "admin@siktak.demo");
  await page.getByRole("button", { name: "운영 설정", exact: true }).click();
  const values = [
    ["확정·큐레이션 안내", "브라우저 검증: 함께할 식탁을 소개합니다."],
    ["행사 1일 전 안내", "브라우저 검증: 내일의 식탁을 준비해 주세요."],
    ["대체 일정 안내", "브라우저 검증: 가능한 다음 일정을 살펴보세요."],
  ];
  for (const [label, value] of values)
    await page.getByRole("textbox", { name: label, exact: true }).fill(value);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/command") &&
      response.request().postDataJSON()?.action === "setting",
  );
  await page.getByRole("button", { name: "템플릿 저장", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "운영 설정", exact: true }).click();
  for (const [label, value] of values)
    await expect(
      page.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue(value);
});

test("participant sees a partial package refund while another booking stays paid", async ({
  page,
  browser,
}) => {
  const operator = await browser.newContext();
  const admin = await operator.newPage();
  const post = async (actor: Page, action: string, data: unknown) => {
    const response = await actor.request.post("/api/command", {
      headers: { Origin: new URL(actor.url()).origin },
      data: { action, data },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  try {
    await login(admin, "admin@siktak.demo");
    const events: string[] = [];
    for (let i = 0; i < 2; i++) {
      const start = Date.now() + (8 + i) * 86400000;
      const event = await post(admin, "event", {
        title: `부분 환불 검증 ${i + 1}`,
        region: "홍대·합정",
        capacity: 12,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 7200000).toISOString(),
        closesAt: new Date(start - 86400000).toISOString(),
        matchAt: new Date(start - 86400000).toISOString(),
        cancelRefundCutoffAt: new Date(start - 172800000).toISOString(),
      });
      events.push(event.id);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "hello@siktak.demo");
    const applications: string[] = [];
    for (let i = 0; i < 2; i++) {
      const requestId = `browser-partial-${i}`;
      await post(page, "apply", {
        requestId,
        eventIds: [events[i]],
        ticketType: i ? "EXISTING" : "TRIPLE",
        consent: true,
      });
      await post(page, "pay", {
        applicationId: requestId,
        requestId: `pay-${requestId}`,
      });
      applications.push(requestId);
    }
    await page.goto(`/app?tab=detail&application=${applications[0]}`);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "신청 취소 기록하기", exact: true })
      .click();
    const refund = page
      .locator("section.card")
      .filter({ has: page.getByRole("heading", { name: "모의 환불 내역" }) });
    await expect(refund).toContainText("10,000원");
    await expect(refund).toContainText("2회 × 5,000원 (모의 산식)");
    await expect(refund.getByText("환불 완료", { exact: true })).toBeVisible();
    const view = await (await page.request.get("/api/view")).json();
    expect(
      view.applications.find((a: { id: string }) => a.id === applications[1])
        .paymentStatus,
    ).toBe("PAID");
    await page.reload();
    await expect(
      page.getByText("2회 × 5,000원 (모의 산식)", { exact: false }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/partial-refund-mobile.png",
      fullPage: true,
    });
  } finally {
    await operator.close();
  }
});
