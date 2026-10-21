import {
  test,
  expect,
  request,
  type APIRequestContext,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

test("minute-scale real worker notifications and operator exception UI", async ({
  browser,
}) => {
  test.skip(
    process.env.SIKTAK_NOTIFICATION_MINUTE !== "true",
    "Explicit local minute rehearsal only",
  );
  test.setTimeout(360000);
  const db = new PrismaClient();
  const prefix = `ai-minute-${Date.now()}`;
  const output = `reports/ai-decisions/${prefix}`;
  mkdirSync(output, { recursive: true });
  const report: any = {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    startedAt: new Date().toISOString(),
    intervalSeconds: 60,
    scope:
      "Local real HTTP, browser, DB and independent worker; no external OS push or 24h observation",
    checks: [],
    status: "RUNNING",
  };
  const save = () =>
    writeFileSync(
      `${output}/result.json`,
      JSON.stringify(report, null, 2) + "\n",
    );
  const check = (name: string, passed: boolean, detail: unknown = {}) => {
    report.checks.push({ name, passed, detail });
    save();
    expect(passed, name).toBe(true);
  };
  const clients: APIRequestContext[] = [];
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const password = randomBytes(24).toString("base64url");
  const secret = await hashPassword(password);
  const call = async (
    client: APIRequestContext,
    action: string,
    data: unknown,
    expected = 200,
  ) => {
    const response = await client.post("/api/command", {
      data: { action, data },
    });
    const body = await response.json();
    expect(response.status(), `${action}: ${body.error ?? ""}`).toBe(expected);
    return body;
  };
  async function login(email: string, pass: string) {
    const client = await request.newContext({
      baseURL: "http://localhost:3100",
      extraHTTPHeaders: { origin: "http://localhost:3100" },
    });
    clients.push(client);
    for (let i = 0; i < 5; i++) {
      const response = await client.post("/api/auth/sign-in/email", {
        data: { email, password: pass },
      });
      if (response.status() === 429) {
        await new Promise((r) =>
          setTimeout(
            r,
            Math.max(
              1000,
              Number(
                response.headers()["retry-after"] ??
                  response.headers()["x-retry-after"] ??
                  10,
              ) * 1000,
            ),
          ),
        );
        continue;
      }
      expect(response.status()).toBe(200);
      return client;
    }
    throw Error("Login rate limit did not clear");
  }
  try {
    check(
      "minute clock explicitly enabled",
      process.env.SIKTAK_NOTIFICATION_MINUTE === "true",
    );
    for (let i = 0; i < 4; i++)
      await db.user.create({
        data: {
          id: `${prefix}-u${i}`,
          name: `분 검사 참가자 ${i}`,
          email: `${prefix}-${i}@example.test`,
          accounts: {
            create: {
              id: `${prefix}-auth${i}`,
              providerId: "credential",
              accountId: `${prefix}-u${i}`,
              password: secret,
            },
          },
          profile: {
            create: {
              contact: "01000000000",
              birthYear: 1995,
              gender: i % 2 ? "남성" : "여성",
              occupation: "합성 검사",
              mbti: [i % 2 ? "ENTJ" : "INTJ"],
              interests: ["여행"],
              traits: ["차분한 사람"],
              desiredTraits: ["차분한 사람"],
              budgets: ["2만원"],
              foodRestrictions: "없음",
              allergies: "없음",
              consentVersion: "test",
              consentAt: new Date(),
            },
          },
        },
      });
    for (let i = 0; i < 4; i++)
      await login(`${prefix}-${i}@example.test`, password);
    const admin = await login("admin@siktak.demo", process.env.DEMO_PASSWORD!);
    await call(admin, "setting", {
      key: "matchingPolicy",
      value: { minimum: 20, weights: [25, 13, 7, 3], loneGenderMultiplier: 0 },
    });
    const origin = Date.now(),
      start = new Date(origin + 180000),
      end = new Date(origin + 210000),
      matchAt = new Date(origin + 25000);
    await call(admin, "event", {
      id: `${prefix}-event`,
      title: prefix,
      region: "홍대",
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      closesAt: matchAt.toISOString(),
      matchAt: matchAt.toISOString(),
      cancelRefundCutoffAt: new Date(origin - 1000).toISOString(),
      capacity: 12,
    });
    // The event command generates an ID; resolve it by the unique title.
    const event = await db.eventSlot.findFirstOrThrow({
      where: { title: prefix },
    });
    await db.venueSlot.create({
      data: {
        id: `${prefix}-venue`,
        eventId: event.id,
        name: "알림 검사 식당",
        address: "합성 주소",
        mapUrl: "https://example.test",
        reservationName: "검사",
        price: 20000,
        capacity: 6,
        totalTables: 3,
        dietaryNotes: "없음",
      },
    });
    for (let i = 0; i < 4; i++) {
      await call(clients[i], "apply", {
        requestId: `${prefix}-a${i}`,
        eventIds: [event.id],
        ticketType: i === 0 ? "MEMBERSHIP_1" : "SINGLE",
        consent: true,
      });
      await call(clients[i], "pay", {
        applicationId: `${prefix}-a${i}`,
        requestId: `${prefix}-pay${i}`,
      });
    }
    await expect
      .poll(
        () =>
          db.application.count({
            where: { id: { startsWith: prefix }, matchStatus: "CONFIRMED" },
          }),
        { timeout: 65000, intervals: [1000] },
      )
      .toBe(4);
    check(
      "natural scheduled matching confirms without operator approval",
      true,
    );
    const initial = await db.diningTable.findFirstOrThrow({
      where: { eventId: event.id },
    });
    // Add the destination only after matching so this proves a real venue change.
    await db.venueSlot.create({
      data: {
        id: `${prefix}-replacement`,
        eventId: event.id,
        name: "운영자가 변경한 식당",
        address: "합성 변경 주소",
        mapUrl: "https://example.test",
        reservationName: "변경 예약",
        price: 20000,
        capacity: 6,
        totalTables: 3,
        dietaryNotes: "없음",
      },
    });
    const initialJobs = await db.job.findMany({
      where: { payload: { path: ["tableId"], equals: initial.id } },
    });
    check(
      "reminder and feedback scheduled exactly one minute from event anchors",
      initialJobs.some(
        (j) => j.kind === "REMINDER" && +j.runAt === +start - 60000,
      ) &&
        initialJobs.some(
          (j) => j.kind === "FEEDBACK_REMINDER" && +j.runAt === +end + 60000,
        ),
    );
    const context = await browser.newContext({
      storageState: await admin.storageState(),
      viewport: { width: 390, height: 844 },
    });
    contexts.push(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:3100/admin");
    await page
      .getByRole("button", { name: "매칭·테이블", exact: true })
      .click();
    const editor = page.getByRole("region", { name: "운영자 배정 수정" });
    await editor.getByRole("checkbox", { name: new RegExp(prefix) }).check();
    await editor
      .getByLabel("새 식탁 1 식당")
      .selectOption(`${prefix}-replacement`);
    await editor
      .getByLabel("변경 사유 (참가자에게 안내됩니다)")
      .fill("식당 예약 문제로 대체 식당을 확인했습니다.");
    await editor
      .getByRole("button", { name: "변경 미리보기", exact: true })
      .click();
    await expect(
      editor.getByText("각 원본 식탁의 실제 운영 예외를 먼저 등록해 주세요."),
    ).toBeVisible();
    check("unregistered normal table edit rejected through UI", true);
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
    await page.screenshot({
      path: `${output}/operator-preview.png`,
      fullPage: true,
    });
    await editor
      .getByRole("button", { name: "미리보기대로 배정 변경" })
      .click();
    await expect(editor.getByRole("status")).toContainText(
      "배정을 변경하고 새 안내를 예약했어요.",
    );
    check("registered exception confirmed through UI", true);
    await page.screenshot({
      path: `${output}/operator-confirmed.png`,
      fullPage: true,
    });
    const app = await db.application.findUniqueOrThrow({
      where: { id: `${prefix}-a0` },
      include: { table: true, payments: true },
    });
    const tableId = app.tableId!;
    report.operatorChange = {
      fromTableId: initial.id,
      toTableId: tableId,
      fromVenueId: initial.venueSlotId,
      toVenueId: app.table?.venueSlotId,
    };
    check(
      "membership paid once at recorded demo price",
      app.payments.length === 1 && app.payments[0].amount === 39600,
    );
    check(
      "operator edit changes venue and retires old table",
      initial.venueSlotId === `${prefix}-venue` &&
        app.table?.venueSlotId === `${prefix}-replacement` &&
        app.tableId !== initial.id &&
        (await db.diningTable.findUniqueOrThrow({ where: { id: initial.id } }))
          .status === "REPLACED",
    );
    check(
      "operator incident resolved with audit linkage",
      (await db.exceptionCase.count({
        where: { objectId: initial.id, kind: "ALLOCATION", status: "RESOLVED" },
      })) === 1,
    );
    const memberContext = await browser.newContext({
      storageState: await clients[0].storageState(),
      viewport: { width: 390, height: 844 },
    });
    contexts.push(memberContext);
    const memberPage = await memberContext.newPage();
    memberPage.on("pageerror", (e) => errors.push(e.message));
    await memberPage.goto(
      `http://localhost:3100/app?tab=detail&application=${prefix}-a0`,
    );
    await expect(
      memberPage.getByText("운영자가 변경한 식당", { exact: true }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("heading", {
        name: "내가 바란 만남, 이번 식탁은요",
      }),
    ).toBeVisible();
    await expect(
      memberPage.getByText("“차분한 사람”", { exact: true }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("region", { name: "희망 성향과 매칭 사유" }),
    ).toContainText(
      "원하신 ‘차분한 사람’과 같은 성향으로 분류되는 항목을 프로필에서 선택한 분이 3명 있어요.",
    );
    await memberPage.screenshot({
      path: `${output}/participant.png`,
      fullPage: true,
    });
    check("participant sees changed venue and own fulfillment snapshot", true);
    await call(clients[0], "cancel", { applicationId: `${prefix}-a0` }, 400);
    check(
      "same-day self cancellation rejected while room remains accessible",
      !!(await (await clients[0].get("/api/view")).json()).applications.find(
        (a: any) => a.id === `${prefix}-a0`,
      ).table.room,
    );
    for (let i = 0; i < 4; i++)
      await call(clients[i], "checkin", { applicationId: `${prefix}-a${i}` });
    const jobs = await db.job.findMany({
      where: { payload: { path: ["tableId"], equals: tableId } },
    });
    report.scheduledJobs = jobs
      .filter((j) =>
        ["REMINDER", "START", "END", "FEEDBACK_REMINDER"].includes(j.kind),
      )
      .map((j) => ({ id: j.id, kind: j.kind, runAt: j.runAt }));
    save();
    const reminder = jobs.find((j) => j.kind === "REMINDER")!;
    check(
      "reminder not sent before its original deadline",
      +reminder.runAt > Date.now() &&
        (await db.notification.count({
          where: { key: { startsWith: `reminder:${tableId}:` } },
        })) === 0,
    );
    await expect
      .poll(
        () =>
          db.notification.count({
            where: { key: { startsWith: `reminder:${tableId}:` } },
          }),
        { timeout: 150000, intervals: [1000] },
      )
      .toBe(4);
    check("real worker sends four minute-scale reminders", true);
    await expect
      .poll(
        () =>
          db.job.count({ where: { key: `end:${tableId}`, status: "DONE" } }),
        { timeout: 140000, intervals: [1000] },
      )
      .toBe(1);
    check(
      "real end job sends feedback requests",
      (await db.notification.count({
        where: {
          key: { in: [0, 1, 2, 3].map((i) => `feedback:${prefix}-a${i}`) },
        },
      })) === 4,
    );
    await call(clients[1], "feedback", {
      applicationId: `${prefix}-a1`,
      atmosphere: 4,
      conversation: 4,
      venue: 4,
      returnIntent: true,
      recommend: 8,
      comment: "합성 후기",
      liked: [],
      avoided: [],
    });
    await expect
      .poll(
        () =>
          db.job.count({
            where: { key: `feedback-reminder:${tableId}`, status: "DONE" },
          }),
        { timeout: 90000, intervals: [1000] },
      )
      .toBe(1);
    const feedbackNotices = await db.notification.findMany({
      where: {
        key: { in: [0, 1, 2, 3].map((i) => `feedback-once:${prefix}-a${i}`) },
      },
    });
    check(
      "one-minute post-end reminder targets attended nonresponders only",
      feedbackNotices.length === 3 &&
        !feedbackNotices.some((n) => n.userId === `${prefix}-u1`),
    );
    await db.job.create({
      data: {
        key: `${prefix}-duplicate`,
        kind: "FEEDBACK_REMINDER",
        payload: { tableId },
        runAt: new Date(),
      },
    });
    await expect
      .poll(
        () =>
          db.job.count({
            where: { key: `${prefix}-duplicate`, status: "DONE" },
          }),
        { timeout: 20000, intervals: [1000] },
      )
      .toBe(1);
    check(
      "duplicate delivery creates no second feedback notice",
      (await db.notification.count({
        where: {
          key: { in: [0, 1, 2, 3].map((i) => `feedback-once:${prefix}-a${i}`) },
        },
      })) === 3,
    );
    const finished = await db.job.findMany({
      where: { id: { in: report.scheduledJobs.map((j: any) => j.id) } },
    });
    check(
      "every scheduled job completes after original runAt exactly once",
      finished.every(
        (j) =>
          j.status === "DONE" &&
          j.attempts === 1 &&
          j.completedAt &&
          +j.completedAt >= +j.runAt,
      ),
    );
    report.completedJobs = finished.map((j) => ({
      kind: j.kind,
      runAt: j.runAt,
      completedAt: j.completedAt,
      attempts: j.attempts,
      status: j.status,
    }));
    report.notifications = await db.notification.findMany({
      where: { userId: { startsWith: prefix } },
      select: { key: true, createdAt: true, pushStatus: true },
    });
    check("no browser JavaScript errors", errors.length === 0, { errors });
    check(
      "fixed minimum remains 20",
      (
        (
          await db.setting.findUniqueOrThrow({
            where: { key: "matchingPolicy" },
          })
        ).value as any
      ).minimum === 20,
    );
    report.status = "PASSED";
  } catch (error) {
    report.status = "FAILED";
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    for (const client of clients) {
      await client.post("/api/auth/sign-out", { data: {} }).catch(() => {});
      await client.dispose();
    }
    await db.session.deleteMany({ where: { userId: { startsWith: prefix } } });
    report.remainingFixtureSessions = await db.session.count({
      where: { userId: { startsWith: prefix } },
    });
    report.finishedAt = new Date().toISOString();
    save();
    await db.$disconnect();
  }
});
