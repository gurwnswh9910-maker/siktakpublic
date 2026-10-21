import { runScheduledBatch, schedulerAuthorization } from "@/worker/scheduler";

export const runtime = "nodejs";
export const maxDuration = 212;
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  return Response.json(
    { error: "POST 요청이 필요합니다." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}
export async function POST(request: Request) {
  const authorization = schedulerAuthorization(
    request.headers.get("authorization"),
  );
  if (authorization === "unconfigured")
    return Response.json(
      { error: "예약 작업 인증이 설정되지 않았습니다." },
      { status: 503, headers },
    );
  if (authorization !== "authorized")
    return Response.json(
      { error: "인증이 필요합니다." },
      { status: 401, headers },
    );
  try {
    const result = await runScheduledBatch(request.signal);
    return Response.json(result, {
      status: result.busy
        ? 409
        : result.status === "FAILED" || result.status === "INTERRUPTED"
          ? 503
          : 200,
      headers,
    });
  } catch {
    return Response.json(
      { error: "예약 작업 실행에 실패했습니다." },
      { status: 503, headers },
    );
  }
}
