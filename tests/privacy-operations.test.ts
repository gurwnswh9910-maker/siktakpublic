import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { atomic, db } from "@/server/db";
import { auth } from "@/server/auth";
import { command } from "@/server/commands";
import { processSyntheticPrivacyRequest as processRequest } from "@/server/privacy-operations";
import { privacyPolicy } from "@/domain/privacy-policy";
import PrivacyPage from "@/app/privacy/page";
import { GET as view } from "@/app/api/view/route";
import { POST as sendCommand } from "@/app/api/command/route";
import { GET as exportData } from "@/app/api/export/route";
import { notify } from "@/server/jobs";

const subjectId = "privacy-test-00000001";
const adminId = "privacy-admin";
const email = `${subjectId}@example.test`;
const password = "Privacy-synthetic-password-2026";
const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
const base = { actorId: adminId, userId: subjectId };
let passwordHash: string;
let syntheticClientNumber = 0;
const exec = promisify(execFile);
const signIn = (address = email) =>
  auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-For": `192.0.2.${syntheticClientNumber}`,
      },
      body: JSON.stringify({ email: address, password }),
    }),
  );
const close = (fingerprint: string) =>
  processRequest({
    ...base,
    execute: true,
    expectedFingerprint: fingerprint,
    confirmation: `DELETE_SYNTHETIC:${subjectId}`,
    identityConfirmed: true,
    caseReference: "QA_PRIVACY_001",
  });

beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
beforeEach(async () => {
  syntheticClientNumber++;
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Wrong database");
  await db.$executeRawUnsafe(
    'TRUNCATE "User", "EventSlot", "Application", "Payment", "Refund", "TicketEntry", "MatchRun", "DiningTable", "VenueSlot", "ChatRoom", "Message", "Feedback", "Relationship", "SafetyReport", "Notification", "PushSubscription", "Job", "ExceptionCase", "AuditLog", "Setting" CASCADE',
  );
  await db.user.createMany({
    data: [
      {
        id: adminId,
        name: "검증 관리자",
        email: "privacy-admin@example.test",
        role: "ADMIN",
      },
      {
        id: "privacy-operations",
        name: "운영",
        email: "privacy-operations@example.test",
        role: "OPERATIONS",
      },
      {
        id: "privacy-peer",
        name: "다른 참가자",
        email: "privacy-peer@example.test",
        role: "PARTICIPANT",
      },
    ],
  });
  await db.user.create({
    data: {
      id: subjectId,
      name: "합성 개인정보 참가자",
      email,
      profile: {
        create: {
          contact: "01000000000",
          birthYear: 1995,
          gender: "기타",
          occupation: "합성 직업",
          mbti: ["INTJ"],
          interests: ["독서"],
          traits: ["차분한"],
          desiredTraits: ["다양한"],
          budgets: ["2~3만원"],
          foodRestrictions: "합성 조건",
          allergies: "합성 알레르기",
          consentVersion: "2026-10-v1",
          consentAt: new Date("2026-10-01T00:00:00Z"),
        },
      },
      accounts: {
        create: {
          id: "privacy-credential",
          accountId: subjectId,
          providerId: "credential",
          password: passwordHash,
        },
      },
      sessions: {
        create: {
          id: "privacy-fixture-session",
          token: "privacy-synthetic-session-token",
          expiresAt: new Date(Date.now() + 86400000),
          ipAddress: "192.0.2.1",
          userAgent: "synthetic-browser",
        },
      },
    },
  });
  await db.pushSubscription.create({
    data: {
      userId: subjectId,
      endpoint: "https://push.example.test/privacy",
      p256dh: "synthetic-public",
      auth: "synthetic-auth",
    },
  });
  await db.notification.create({
    data: {
      id: "privacy-notification",
      userId: subjectId,
      title: "개인 안내",
      body: "합성 개인정보 참가자의 안내",
      href: "/app?tab=mine",
      key: "privacy-notification",
    },
  });
  await db.job.create({
    data: {
      id: "privacy-push",
      key: "push:privacy-notification",
      kind: "PUSH",
      payload: { notificationId: "privacy-notification" },
      runAt: new Date(Date.now() + 86400000),
    },
  });
});
afterAll(() => db.$disconnect());

async function history() {
  const past = new Date(Date.now() - 86400000);
  await db.eventSlot.create({
    data: {
      id: "privacy-event",
      title: "종료된 합성 모임",
      region: "합성 지역",
      startsAt: past,
      endsAt: past,
      closesAt: past,
      matchAt: past,
      cancelRefundCutoffAt: past,
      status: "ENDED",
    },
  });
  await db.diningTable.create({
    data: {
      id: "privacy-table",
      eventId: "privacy-event",
      runId: "privacy-run",
      score: 50,
      evaluation: {
        members: [
          { id: subjectId, name: "합성 개인정보 참가자", birthYear: 1995 },
        ],
      },
      explanation: "과거 배정 근거",
      room: { create: { id: "privacy-room" } },
    },
  });
  await db.application.create({
    data: {
      id: "privacy-app",
      userId: subjectId,
      ticketType: "SINGLE",
      applicationStatus: "SUBMITTED",
      paymentStatus: "REFUNDED",
      matchStatus: "CONFIRMED",
      attendanceStatus: "ATTENDED",
      tableId: "privacy-table",
      options: { create: { eventId: "privacy-event" } },
      payments: {
        create: {
          id: "privacy-payment",
          amount: 8000,
          status: "REFUNDED",
          key: "privacy-payment",
          refunds: {
            create: {
              id: "privacy-refund",
              amount: 8000,
              status: "REFUNDED",
              reason: "합성 종료 정산",
            },
          },
        },
      },
      feedback: {
        create: {
          atmosphere: 4,
          conversation: 4,
          venue: 4,
          returnIntent: true,
          recommend: 4,
          comment: "검토 보존 대상",
        },
      },
    },
  });
  await db.ticketEntry.createMany({
    data: [
      {
        id: "privacy-purchase",
        userId: subjectId,
        applicationId: "privacy-app",
        paymentId: "privacy-payment",
        kind: "PURCHASE",
        units: 1,
        key: "privacy-purchase",
      },
      {
        id: "privacy-refund-entry",
        userId: subjectId,
        applicationId: "privacy-app",
        paymentId: "privacy-payment",
        kind: "REFUND",
        units: -1,
        key: "privacy-refund-entry",
      },
    ],
  });
  await db.safetyReport.create({
    data: {
      id: "privacy-report",
      reporterId: "privacy-peer",
      targetId: subjectId,
      applicationId: "privacy-app",
      reason: "검토 중인 합성 신고",
      evidence: "보존할 합성 증거",
    },
  });
  await db.relationship.create({
    data: {
      fromId: "privacy-peer",
      toId: subjectId,
      sourceId: "privacy-report",
      kind: "BLOCK",
    },
  });
  await db.message.create({
    data: {
      roomId: "privacy-room",
      userId: subjectId,
      body: "검토 대상 합성 대화",
      key: "privacy-message",
    },
  });
  await db.auditLog.create({
    data: {
      id: "privacy-old-audit",
      actorId: subjectId,
      objectId: "privacy-app",
      action: "OLD_ACTION",
      after: { note: "과거 감사 근거" },
    },
  });
  await db.matchRun.create({
    data: {
      id: "privacy-run",
      eventId: "privacy-event",
      status: "DONE",
      version: "balanced-v1",
      input: { originalName: "합성 개인정보 참가자" },
    },
  });
}

async function retainedSnapshot() {
  return {
    applications: await db.application.findMany({
      where: { userId: subjectId },
    }),
    payments: await db.payment.findMany(),
    refunds: await db.refund.findMany(),
    ledger: await db.ticketEntry.findMany({ orderBy: { id: "asc" } }),
    reports: await db.safetyReport.findMany(),
    relationships: await db.relationship.findMany(),
    feedback: await db.feedback.findMany(),
    messages: await db.message.findMany(),
    tables: await db.diningTable.findMany(),
    runs: await db.matchRun.findMany(),
    priorAudit: await db.auditLog.findUnique({
      where: { id: "privacy-old-audit" },
    }),
  };
}

describe("synthetic privacy request procedure", () => {
  it("defaults to an unchanged dry run and exposes counts instead of personal data, including the CLI", async () => {
    const before = await db.user.findUnique({
      where: { id: subjectId },
      include: { profile: true, sessions: true, accounts: true },
    });
    const result = await processRequest(base);
    expect(result).toMatchObject({
      mode: "DRY_RUN",
      eligible: true,
      completed: false,
      removed: {
        profiles: 1,
        credentials: 1,
        sessions: 1,
        pushSubscriptions: 1,
      },
    });
    const { stdout } = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/privacy-account.ts",
        "--actor",
        adminId,
        "--user",
        subjectId,
      ],
      { env: process.env },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      mode: "DRY_RUN",
      fingerprint: result.fingerprint,
    });
    expect(stdout).not.toContain("01000000000");
    expect(stdout).not.toContain(passwordHash);
    expect(stdout).not.toContain(email);
    expect(
      await db.user.findUnique({
        where: { id: subjectId },
        include: { profile: true, sessions: true, accounts: true },
      }),
    ).toEqual(before);
    expect(await db.auditLog.count()).toBe(0);
  });

  it("revokes real login access and removes only declared data while retaining financial, safety and historical records", async () => {
    await history();
    const response = await signIn();
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeTruthy();
    const before = await retainedSnapshot();
    const preview = await processRequest(base);
    const result = await close(preview.fingerprint);
    expect(result.mode).toBe("EXECUTED");
    expect(await retainedSnapshot()).toEqual(before);
    expect(
      await db.user.findUnique({ where: { id: subjectId } }),
    ).toMatchObject({
      name: "탈퇴한 참가자",
      email: `${subjectId}@withdrawn.invalid`,
      restriction: "WITHDRAWN",
      image: null,
      emailVerified: false,
    });
    expect(await db.profile.count({ where: { userId: subjectId } })).toBe(0);
    expect(await db.account.count({ where: { userId: subjectId } })).toBe(0);
    expect(await db.session.count({ where: { userId: subjectId } })).toBe(0);
    expect(
      await db.pushSubscription.count({ where: { userId: subjectId } }),
    ).toBe(0);
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull();
    expect((await signIn()).ok).toBe(false);
    expect((await signIn(`${subjectId}@withdrawn.invalid`)).ok).toBe(false);
    expect(
      (await view(new Request(`${origin}/api/view`, { headers: { cookie } })))
        .status,
    ).toBe(401);
    await expect(
      command(
        { id: subjectId, name: "오래된 세션", role: "PARTICIPANT" },
        "profile",
        {},
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db.notification.findUnique({
        where: { id: "privacy-notification" },
      }),
    ).toMatchObject({ title: "", body: "", href: "", pushStatus: "EXPIRED" });
    expect(
      await db.job.findUnique({ where: { id: "privacy-push" } }),
    ).toMatchObject({ status: "CANCELED", claimToken: null });
    const record = await db.auditLog.findFirstOrThrow({
      where: { action: "PRIVACY_SYNTHETIC_ACCOUNT_CLOSED" },
    });
    expect(record.after).toMatchObject({
      policyVersion: privacyPolicy.version,
      consent: { version: "2026-10-v1" },
      retained: { safetyReports: 1, payments: 1 },
    });
    expect(JSON.stringify(record)).not.toContain("01000000000");
    expect(JSON.stringify(record)).not.toContain(email);
    expect((await close(preview.fingerprint)).mode).toBe("ALREADY_COMPLETED");
    expect(
      await db.auditLog.count({
        where: { action: "PRIVACY_SYNTHETIC_ACCOUNT_CLOSED" },
      }),
    ).toBe(1);
  });

  it("requires a stored administrator, synthetic identity and all explicit execution guards", async () => {
    await expect(
      processRequest({ ...base, actorId: "privacy-operations" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      processRequest({ ...base, actorId: subjectId }),
    ).rejects.toMatchObject({ status: 403 });
    const preview = await processRequest(base);
    for (const override of [
      { confirmation: undefined },
      { identityConfirmed: false },
      { caseReference: "a" },
    ]) {
      await expect(
        processRequest({
          ...base,
          execute: true,
          expectedFingerprint: preview.fingerprint,
          confirmation: `DELETE_SYNTHETIC:${subjectId}`,
          identityConfirmed: true,
          caseReference: "QA_PRIVACY_001",
          ...override,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    const previous = process.env.DEMO_MODE;
    process.env.DEMO_MODE = "false";
    try {
      await expect(processRequest(base)).rejects.toMatchObject({ status: 403 });
    } finally {
      process.env.DEMO_MODE = previous;
    }
    await db.user.update({
      where: { id: subjectId },
      data: { email: "real-user@example.com" },
    });
    await expect(processRequest(base)).rejects.toMatchObject({ status: 403 });
    expect(await db.profile.count({ where: { userId: subjectId } })).toBe(1);
    expect(await db.account.count({ where: { userId: subjectId } })).toBe(1);
  });

  it("rejects a late authentication session at every app boundary and suppresses new notices", async () => {
    const response = await signIn();
    expect(response.ok).toBe(true);
    const result = await response.json();
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const originalSession = await db.session.findUniqueOrThrow({
      where: { token: result.token },
    });
    await close((await processRequest(base)).fingerprint);
    // Simulate a login that read credentials before closure and completed its
    // session insert afterwards. Application authorization still uses storage.
    await db.session.create({ data: originalSession });
    expect(
      (await view(new Request(`${origin}/api/view`, { headers: { cookie } })))
        .status,
    ).toBe(403);
    expect(
      (
        await exportData(
          new Request(`${origin}/api/export`, { headers: { cookie } }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await sendCommand(
          new Request(`${origin}/api/command`, {
            method: "POST",
            headers: {
              cookie,
              Origin: origin,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "profile", data: {} }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      await atomic((tx) =>
        notify(tx, subjectId, "late-privacy-notice", "과거 작업", "추가 알림"),
      ),
    ).toBeNull();
    expect(
      await db.notification.count({ where: { key: "late-privacy-notice" } }),
    ).toBe(0);
    expect(
      await db.job.count({ where: { key: "push:late-privacy-notice" } }),
    ).toBe(0);
  });

  it("detects changes after preview before removing any information", async () => {
    const preview = await processRequest(base);
    await db.session.create({
      data: {
        id: "late-session",
        token: "late-synthetic-token",
        userId: subjectId,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await expect(close(preview.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    expect(await db.session.count({ where: { userId: subjectId } })).toBe(2);
    expect(await db.profile.count({ where: { userId: subjectId } })).toBe(1);
  });

  it("keeps withdrawal permanent when a retained safety report receives a later warning", async () => {
    await history();
    await close((await processRequest(base)).fingerprint);
    await command(
      { id: adminId, name: "검증 관리자", role: "ADMIN" },
      "reviewReport",
      {
        reportId: "privacy-report",
        action: "WARNING",
        note: "탈퇴 후 보존된 신고의 검토 결과",
      },
    );
    expect(
      await db.safetyReport.findUnique({ where: { id: "privacy-report" } }),
    ).toMatchObject({
      status: "REVIEWED",
      action: "WARNING",
      reviewedBy: adminId,
    });
    expect(
      await db.user.findUnique({ where: { id: subjectId } }),
    ).toMatchObject({ restriction: "WITHDRAWN" });
    await expect(
      command(
        { id: subjectId, name: "탈퇴한 참가자", role: "PARTICIPANT" },
        "profile",
        {},
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await atomic((tx) =>
        notify(
          tx,
          subjectId,
          "post-review-privacy-notice",
          "검토 후 안내",
          "추가 알림",
        ),
      ),
    ).toBeNull();
    expect(
      await db.notification.count({
        where: { key: "post-review-privacy-notice" },
      }),
    ).toBe(0);
    expect(
      await db.job.count({ where: { key: "push:post-review-privacy-notice" } }),
    ).toBe(0);
    expect(await db.account.count({ where: { userId: subjectId } })).toBe(0);
    expect(await db.profile.count({ where: { userId: subjectId } })).toBe(0);
  });

  it("keeps ongoing attendance, waitlist holds, unsettled refunds and remaining ticket rights visible as blockers", async () => {
    await history();
    await db.application.update({
      where: { id: "privacy-app" },
      data: {
        attendanceStatus: "SCHEDULED",
        paymentStatus: "REFUND_PROCESSING",
      },
    });
    await db.refund.update({
      where: { id: "privacy-refund" },
      data: { status: "PROCESSING" },
    });
    await db.diningTable.update({
      where: { id: "privacy-table" },
      data: { status: "WAITLIST_PENDING" },
    });
    await db.waitlistEntry.create({
      data: {
        applicationId: "privacy-app",
        eventId: "privacy-event",
        tableId: "privacy-table",
        status: "OFFERED",
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await db.ticketEntry.create({
      data: {
        userId: subjectId,
        kind: "GRANT",
        units: 1,
        key: "privacy-outstanding-ticket",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    const preview = await processRequest(base);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.map((b) => b.code).sort()).toEqual([
      "ACTIVE_APPLICATION",
      "ACTIVE_WAITLIST",
      "TABLE_HOLD",
      "TICKET_BALANCE",
      "UNSETTLED_REFUND",
    ]);
    await expect(close(preview.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    expect(await db.waitlistEntry.findFirst()).toMatchObject({
      status: "OFFERED",
    });
    expect(await db.refund.findFirst()).toMatchObject({ status: "PROCESSING" });
    expect(await db.session.count({ where: { userId: subjectId } })).toBe(1);
  });

  it("waits for already running pushes and cancels pending pushes only after a fresh preview", async () => {
    await db.job.update({
      where: { id: "privacy-push" },
      data: {
        status: "RUNNING",
        claimToken: "privacy-active-claim",
        lockedAt: new Date(),
      },
    });
    const preview = await processRequest(base);
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "PUSH_IN_FLIGHT" }),
    );
    await expect(close(preview.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    await db.job.update({
      where: { id: "privacy-push" },
      data: { status: "DONE", claimToken: null, lockedAt: null },
    });
    await close((await processRequest(base)).fingerprint);
    expect(
      await db.job.findUnique({ where: { id: "privacy-push" } }),
    ).toMatchObject({ status: "DONE" });
  });

  it("rolls back credential/profile removal when a later write fails", async () => {
    await db.user.create({
      data: {
        id: "privacy-collision",
        name: "합성 충돌",
        email: `${subjectId}@withdrawn.invalid`,
      },
    });
    const preview = await processRequest(base);
    await expect(close(preview.fingerprint)).rejects.toThrow();
    expect(await db.profile.count({ where: { userId: subjectId } })).toBe(1);
    expect(await db.account.count({ where: { userId: subjectId } })).toBe(1);
    expect(await db.session.count({ where: { userId: subjectId } })).toBe(1);
    expect(
      await db.pushSubscription.count({ where: { userId: subjectId } }),
    ).toBe(1);
    expect(
      await db.job.findUnique({ where: { id: "privacy-push" } }),
    ).toMatchObject({ status: "PENDING" });
    expect(
      await db.user.findUnique({ where: { id: subjectId } }),
    ).toMatchObject({ email, restriction: "NONE" });
    expect(await db.auditLog.count()).toBe(0);
  });

  it("applies concurrent repeated execution once and renders the same policy used by the preview", async () => {
    const preview = await processRequest(base);
    const results = await Promise.all([
      close(preview.fingerprint),
      close(preview.fingerprint),
    ]);
    expect(results.map((r) => r.mode).sort()).toEqual([
      "ALREADY_COMPLETED",
      "EXECUTED",
    ]);
    expect(
      await db.auditLog.count({
        where: { action: "PRIVACY_SYNTHETIC_ACCOUNT_CLOSED" },
      }),
    ).toBe(1);
    const html = renderToStaticMarkup(createElement(PrivacyPage));
    for (const section of privacyPolicy.sections)
      expect(html).toContain(section.title);
    for (const item of preview.retentionPolicy)
      expect(html).toContain(item.action);
    expect(html).toContain(privacyPolicy.version);
    expect(html).toContain("검토 책임 주체는 와썹하우스입니다");
    expect(html).toContain("아직 확정되지 않았으며");
    expect(html).toContain("접수·검토는 삭제 완료를 뜻하지 않습니다");
  });
});
