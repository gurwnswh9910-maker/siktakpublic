import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { db } from "./db";
import { APIError, createAuthMiddleware } from "better-auth/api";
export const auth = betterAuth({
  database: prismaAdapter(db, { provider: "postgresql" }),
  baseURL: process.env.BETTER_AUTH_URL || process.env.RENDER_EXTERNAL_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      if (ctx.headers?.get("origin") !== new URL(ctx.context.baseURL).origin)
        throw new APIError("FORBIDDEN", { message: "잘못된 요청 출처입니다." });
      if (ctx.body && "role" in ctx.body)
        throw new APIError("BAD_REQUEST", {
          message: "가입할 때 권한을 지정할 수 없습니다.",
        });
      const name =
        typeof ctx.body?.name === "string" ? ctx.body.name.trim() : "";
      if (!name || name.length > 40)
        throw new APIError("BAD_REQUEST", {
          message: "이름은 1~40자로 입력해 주세요.",
        });
      return { context: { body: { ...ctx.body, name } } };
    }),
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const user = await db.user.findUnique({
            where: { id: session.userId },
          });
          if (!user || user.restriction === "WITHDRAWN") return false;
          return { data: session };
        },
      },
    },
  },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "PARTICIPANT", input: false },
    },
  },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    storage: "memory",
    customRules: { "/sign-up/email": { window: 60, max: 8 } },
  },
});
