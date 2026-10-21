import { afterAll, describe, expect, it } from "vitest";
import { auth } from "@/server/auth";
import { db } from "@/server/db";

const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
const email = `signup-${Date.now()}@signup.test`;
const password = "Signup-test-password-2026";
const post = (path: string, data: object, requestOrigin = origin) =>
  auth.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: requestOrigin },
      body: JSON.stringify(data),
    }),
  );
afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: "@signup.test" } } });
  await db.$disconnect();
});
describe("public email signup", () => {
  it("creates only an unverified participant with a hashed credential and usable session", async () => {
    const response = await post("sign-up/email", {
      email,
      password,
      name: "  새 참가자  ",
      emailVerified: true,
      restriction: "NONE",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.user).toMatchObject({
      email,
      name: "새 참가자",
      role: "PARTICIPANT",
      emailVerified: false,
    });
    expect(response.headers.get("set-cookie")).toContain("session_token");
    const stored = await db.user.findUniqueOrThrow({
      where: { email },
      include: { accounts: true },
    });
    expect(stored.accounts[0].password).toBeTruthy();
    expect(stored.accounts[0].password).not.toBe(password);
    expect((await post("sign-in/email", { email, password })).status).toBe(200);
  });
  it("does not duplicate or change an existing account", async () => {
    const response = await post("sign-up/email", {
      email,
      password: "changed-password",
      name: "replacement",
    });
    expect(response.ok).toBe(false);
    expect(await db.user.count({ where: { email } })).toBe(1);
    expect((await post("sign-in/email", { email, password })).status).toBe(200);
  });
  it("rejects role injection, invalid names, weak passwords and foreign origins", async () => {
    for (const data of [
      { name: "관리자", password, role: "ADMIN" },
      { name: "   ", password },
      { name: "x".repeat(81), password },
      { name: "짧은 비밀번호", password: "short" },
    ]) {
      expect(
        (
          await post("sign-up/email", {
            email: `invalid-${crypto.randomUUID()}@signup.test`,
            ...data,
          })
        ).ok,
        `invalid signup: ${data.name.slice(0, 12)}`,
      ).toBe(false);
    }
    expect(
      (
        await post(
          "sign-up/email",
          { email: "foreign@signup.test", name: "외부", password },
          "https://foreign.example",
        )
      ).ok,
    ).toBe(false);
    expect(
      await db.user.count({
        where: { email: { endsWith: "@signup.test" }, role: "ADMIN" },
      }),
    ).toBe(0);
  });
  it("limits signup requests without creating accounts for rejected requests", async () => {
    let limited: Response | undefined;
    for (let i = 0; i < 10; i++) {
      const response = await post("sign-up/email", {
        email: "invalid",
        name: "실패",
        password,
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited?.status).toBe(429);
    expect(
      await db.user.count({ where: { email: { endsWith: "@signup.test" } } }),
    ).toBe(1);
  });
});
