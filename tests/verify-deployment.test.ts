import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

function idle(overrides: Record<string, unknown> = {}) {
  return {
    mode: "scheduler",
    online: true,
    state: "IDLE",
    status: "COMPLETED",
    lastFinishedAt: new Date(Date.now() - 3600000).toISOString(),
    lastDispatchCheckAt: new Date(Date.now() - 1000).toISOString(),
    hasDueJobs: false,
    failed: 0,
    interrupted: 0,
    ...overrides,
  };
}

// Exercise the real CLI, including sessions and sign-out, against a local HTTP
// fixture. No application DB, deployment credentials or network service is used.
async function verify(automation: ReturnType<typeof idle>, strict = false) {
  const sessions = new Map<string, string>();
  const requests: string[] = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture.local");
    requests.push(`${request.method} ${url.pathname}`);
    const role = sessions.get(request.headers.cookie ?? "");
    const send = (status: number, body: unknown = {}) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/auth/sign-in/email") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { email, password } = JSON.parse(body);
      if (password !== "acceptance-fixture-password") return send(401);
      const session = `fixture-session=${++sequence}`;
      sessions.set(
        session,
        email === "admin@siktak.demo" ? "ADMIN" : "PARTICIPANT",
      );
      response.setHeader("Set-Cookie", `${session}; Path=/; HttpOnly`);
      return send(200);
    }
    if (url.pathname === "/api/auth/sign-out") {
      sessions.delete(request.headers.cookie ?? "");
      return send(200);
    }
    if (url.pathname === "/api/view") {
      if (!role) return send(401);
      if (url.searchParams.has("admin")) {
        return role === "ADMIN" ? send(200, { automation }) : send(403);
      }
      return send(200, { user: { role }, pushPublicKey: "fixture-public-key" });
    }
    if (url.pathname === "/api/export") return send(role ? 403 : 401);
    if (url.pathname === "/api/command") return send(403);
    if (url.pathname === "/manifest.webmanifest") {
      return send(200, {
        display: "standalone",
        icons: [{ src: "/icon.png" }],
      });
    }
    if (["/api/health", "/sw.js", "/icon.png"].includes(url.pathname))
      return send(200);
    return send(404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  try {
    const child = spawn(process.execPath, ["scripts/verify-deployment.mjs"], {
      env: {
        ...process.env,
        BASE_URL: `http://127.0.0.1:${address.port}`,
        DEMO_PASSWORD: "acceptance-fixture-password",
        REQUIRE_RECENT_SCHEDULER_BATCH: strict ? "true" : "false",
        ACCEPTANCE_REPORT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, "close");
    return {
      code,
      stderr,
      report: code === 0 ? JSON.parse(stdout) : null,
      requests,
      openSessions: sessions.size,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("deployment verification scheduler proof", () => {
  it.each([{}, { status: null, lastFinishedAt: null }])(
    "accepts fresh idle dispatch without claiming a recent completed application batch: %j",
    async (history) => {
      const result = await verify(idle(history));
      expect(result.code, result.stderr).toBe(0);
      expect(result.report.schedulerProof).toBe("idle-dispatch-only");
      expect(result.report.checks.schedulerIdleDispatch).toBe(true);
      expect(result.report.checks).not.toHaveProperty("schedulerHeartbeat");
      expect(result.report.checks.signOutRevokesSessions).toBe(true);
      expect(result.openSessions).toBe(0);
      expect(result.requests).not.toContain("POST /api/jobs/run");
    },
  );

  it("rejects a stale completed batch in strict mode even while idle", async () => {
    const result = await verify(idle(), true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("completed within three minutes");
    expect(result.openSessions).toBe(0);
  });

  it("records actual recent completion in strict mode even while idle", async () => {
    const result = await verify(
      idle({
        lastFinishedAt: new Date(Date.now() - 1000).toISOString(),
      }),
      true,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.report.schedulerProof).toBe("recent-completed-batch");
    expect(result.report.checks.schedulerHeartbeat).toBe(true);
    expect(result.report.checks).not.toHaveProperty("schedulerIdleDispatch");
  });

  it("rejects offline dispatch", async () => {
    const result = await verify(idle({ online: false, state: "OFFLINE" }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Automation is online");
  });

  it("rejects stale dispatch despite an inconsistent online flag", async () => {
    const result = await verify(
      idle({
        lastDispatchCheckAt: new Date(Date.now() - 8 * 60000).toISOString(),
      }),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("fresh DB dispatch check");
  });

  it.each(["failed", "interrupted"])(
    "preserves the %s job guard in idle mode",
    async (field) => {
      const result = await verify(idle({ [field]: 1 }));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`No ${field} jobs in last batch`);
    },
  );

  it("still requires actual recent completion for a non-idle scheduler", async () => {
    const result = await verify(idle({ state: "READY" }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("completed within three minutes");
  });
});
