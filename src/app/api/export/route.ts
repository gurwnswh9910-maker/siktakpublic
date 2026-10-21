import { auth } from "@/server/auth";
import { db, admin, AppError } from "@/server/db";
import { csvCell as csv } from "@/domain/csv";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const user = await db.user.findUniqueOrThrow({
    where: { id: session.user.id },
  });
  if (user.restriction === "WITHDRAWN")
    return Response.json({ error: "탈퇴 처리된 계정입니다." }, { status: 403 });
  try {
    admin(user);
    const table = new URL(request.url).searchParams.get("type") === "tables";
    let rows: unknown[][];
    if (table) {
      const data = await db.diningTable.findMany({
        include: {
          event: true,
          applications: {
            where: { applicationStatus: "SUBMITTED", matchStatus: "CONFIRMED" },
          },
        },
      });
      rows = [
        ["테이블 ID", "일정", "지역", "인원", "상태"],
        ...data.map((t) => [
          t.id,
          t.event.startsAt.toISOString(),
          t.event.region,
          t.applications.length,
          t.status,
        ]),
      ];
    } else {
      const data = await db.application.findMany({
        include: { user: { select: { name: true } } },
      });
      rows = [
        ["신청 ID", "이름", "신청", "결제", "매칭", "참석"],
        ...data.map((a) => [
          a.id,
          a.user.name,
          a.applicationStatus,
          a.paymentStatus,
          a.matchStatus,
          a.attendanceStatus,
        ]),
      ];
    }
    await db.auditLog.create({
      data: {
        actorId: user.id,
        action: "CSV_EXPORTED",
        objectId: table ? "tables" : "applications",
      },
    });
    return new Response(
      "\uFEFF" + rows.map((r) => r.map(csv).join(",")).join("\r\n"),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="siktak-${table ? "tables" : "applications"}.csv"`,
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    if (e instanceof AppError)
      return new Response(e.message, { status: e.status });
    throw e;
  }
}
