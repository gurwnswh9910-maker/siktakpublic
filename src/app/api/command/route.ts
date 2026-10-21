import { auth } from "@/server/auth";
import { command } from "@/server/commands";
import { runDemoScenario } from "@/server/demo-scenario";
import { AppError } from "@/server/db";
import { z } from "zod";
export async function POST(request: Request) {
  if (
    request.headers.get("origin") !==
    new URL(
      process.env.BETTER_AUTH_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        request.url,
    ).origin
  )
    return Response.json({ error: "잘못된 요청 출처입니다." }, { status: 403 });
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session)
      return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const body = z
      .object({ action: z.string().max(50), data: z.unknown() })
      .parse(await request.json());
    if (body.action === "demoScenario")
      return Response.json(await runDemoScenario(session.user.id));
    return Response.json(
      await command(
        {
          id: session.user.id,
          name: session.user.name,
          role: session.user.role,
        },
        body.action,
        body.data,
      ),
    );
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        {
          error: "입력 내용을 확인해 주세요.",
          details: e.issues.map((x) => `${x.path.join(".")}: ${x.message}`),
        },
        { status: 400 },
      );
    if (e instanceof AppError)
      return Response.json({ error: e.message }, { status: e.status });
    console.error("Command failed", e instanceof Error ? e.message : "unknown");
    return Response.json(
      { error: "처리 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요." },
      { status: 500 },
    );
  }
}
