import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Use a fresh server session for each role; no application, payment, or event mutations.
const baseURL = new URL(
  process.env.BASE_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3000",
).origin;
assert(
  baseURL.startsWith("https://") ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseURL),
  "Use HTTPS for a remote deployment",
);
assert(process.env.DEMO_PASSWORD, "Set DEMO_PASSWORD through the environment");
const report = {
  checkedAt: new Date().toISOString(),
  baseURL,
  checks: {},
  limitations: [
    "No external push delivery or human usability acceptance in this check",
  ],
};
const request = (path, options = {}) =>
  fetch(new URL(path, baseURL), {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
const health = await request("/api/health");
assert.equal(health.status, 200, "Database health");
report.checks.databaseHealth = true;
assert.equal(
  (await request("/api/view")).status,
  401,
  "Unauthenticated API view",
);
assert.equal((await request("/api/export")).status, 401, "Unauthenticated CSV");
report.checks.unauthenticatedAccessRejected = true;
const manifestResponse = await request("/manifest.webmanifest");
assert.equal(manifestResponse.status, 200, "PWA manifest");
const manifest = await manifestResponse.json();
assert.equal(manifest.display, "standalone");
for (const icon of manifest.icons) {
  const iconURL = new URL(icon.src, baseURL);
  assert.equal(
    iconURL.origin,
    baseURL,
    "PWA icons must stay on the app origin",
  );
  assert.equal((await request(iconURL.pathname)).status, 200, "PWA icon");
}
assert.equal((await request("/sw.js")).status, 200, "Service worker");
report.checks.pwaAssets = true;

for (const [email, role] of [
  ["hello@siktak.demo", "PARTICIPANT"],
  ["admin@siktak.demo", "ADMIN"],
]) {
  const login = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseURL },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(login.status, 200, `${role} sign-in`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(cookie, `${role} session cookie`);
  const headers = { Cookie: cookie, Origin: baseURL };
  try {
    const view = await request(
      role === "ADMIN" ? "/api/view?admin=1" : "/api/view",
      { headers },
    );
    assert.equal(view.status, 200, `${role} persisted session`);
    const data = await view.json();
    if (role === "ADMIN") {
      assert.equal(data.automation.online, true, "Automation is online");
      if (data.automation.mode === "scheduler") {
        assert.equal(data.automation.failed, 0, "No failed jobs in last batch");
        assert.equal(
          data.automation.interrupted,
          0,
          "No interrupted jobs in last batch",
        );
        if (
          data.automation.state === "IDLE" &&
          process.env.REQUIRE_RECENT_SCHEDULER_BATCH !== "true"
        ) {
          assert.equal(
            data.automation.hasDueJobs,
            false,
            "Idle queue has no due jobs",
          );
          assert(
            data.automation.status === null ||
              data.automation.status === "COMPLETED",
            "Idle scheduler has no unresolved batch failure",
          );
          const dispatchAge =
            Date.now() - Date.parse(data.automation.lastDispatchCheckAt ?? "");
          assert(
            dispatchAge >= 0 && dispatchAge < 7 * 60000,
            "Idle scheduler requires a fresh DB dispatch check",
          );
          report.checks.schedulerIdleDispatch = true;
          report.schedulerProof = "idle-dispatch-only";
        } else {
          assert.equal(
            data.automation.status,
            "COMPLETED",
            "Completed scheduled batch",
          );
          const completedAge =
            Date.now() - Date.parse(data.automation.lastFinishedAt ?? "");
          assert(
            completedAge >= 0 && completedAge < 180000,
            "A real scheduled batch must have completed within three minutes; an idle DB dispatch check is insufficient",
          );
          report.checks.schedulerHeartbeat = true;
          report.schedulerProof = "recent-completed-batch";
        }
      } else {
        assert.equal(data.workerOnline, true, "Worker heartbeat");
        report.checks.workerHeartbeat = true;
      }
      report.automation = data.automation;
    } else {
      assert.equal(data.user.role, role, "Participant role");
      assert.equal(
        (await request("/api/view?admin=1", { headers })).status,
        403,
      );
      assert.equal((await request("/api/export", { headers })).status, 403);
      report.checks.participantAdminAccessRejected = true;
      report.checks.pushPublicKeyConfigured = !!data.pushPublicKey;
      const wrongOrigin = await request("/api/command", {
        method: "POST",
        headers: {
          ...headers,
          Origin: "https://untrusted.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "readNotifications", data: {} }),
      });
      assert.equal(wrongOrigin.status, 403);
      report.checks.wrongOriginRejected = true;
    }
    report.checks[`${role.toLowerCase()}Session`] = true;
  } finally {
    const signOut = await request("/api/auth/sign-out", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(signOut.status, 200, `${role} sign-out`);
    assert.equal(
      (await request("/api/view", { headers })).status,
      401,
      `${role} session revoked`,
    );
  }
}
report.checks.signOutRevokesSessions = true;
const output = JSON.stringify(report, null, 2) + "\n";
if (process.env.ACCEPTANCE_REPORT)
  await writeFile(process.env.ACCEPTANCE_REPORT, output);
console.log(output);
