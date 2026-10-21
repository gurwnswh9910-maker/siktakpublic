import { auth } from "@/server/auth";
import { db, AppError } from "@/server/db";
import { participantView, adminView } from "@/server/views";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const user = await db.user.findUniqueOrThrow({
    where: { id: session.user.id },
  });
  const actor = { id: user.id, name: user.name, role: user.role };
  const url = new URL(request.url);
  if (user.restriction === "WITHDRAWN")
    return Response.json({ error: "탈퇴 처리된 계정입니다." }, { status: 403 });
  try {
    return Response.json(
      url.searchParams.get("admin") === "1"
        ? await adminView(actor, url.searchParams.get("event") ?? undefined)
        : await participantView(actor),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AppError)
      return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
