/**
 * T05/T06 acceptance. Preparation is create-only; after preparation this harness
 * sends participant commands and reads views/evidence. It never invokes a match,
 * tick, /api/jobs/run, demoAdvance, or updates a persisted event/job time.
 *
 * Local: node --env-file=.env --import tsx scripts/verify-automated-lifecycle.mjs
 *   (DATABASE_URL must end in _test; starts an independent production worker).
 * Public without DB TCP access:
 *   LIFECYCLE_MODE=public-cron LIFECYCLE_MANIFEST=.codex/lifecycle.json \
 *   LIFECYCLE_SQL=.codex/lifecycle-prepare.sql DEMO_PASSWORD=... \
 *   SOURCE_SHA=... DEPLOYMENT_ID=... node scripts/verify-automated-lifecycle.mjs prepare-sql
 *   Execute the generated SQL with the Supabase SQL tool; save its evidence JSON
 *   as LIFECYCLE_BASELINE. Then run this script with `public-http`; execute
 *   `observe-sql` output via the SQL tool; save its evidence as LIFECYCLE_EVIDENCE;
 *   finally run `verify`. No public reset/seed and no scheduler HTTP calls.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";

const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const list = (values) => values.map(q).join(",");
const jsonFile = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};

export function lifecycleFixture({
  prefix = `qa-life-${randomUUID().slice(0, 8)}`,
  stepMs = 15000,
  headroomMs = stepMs,
  sourceSHA = "local-worktree",
  deploymentId = null,
} = {}) {
  assert.match(prefix, /^qa-life-[a-z0-9-]{6,48}$/);
  assert(
    stepMs >= 5000,
    "Allow the independent worker time to process real jobs",
  );
  const base = Date.now();
  assert(
    headroomMs >= stepMs,
    "Preparation headroom must cover at least one stage",
  );
  const at = (n) =>
    new Date(base + headroomMs + (n - 1) * stepMs).toISOString();
  const event = (name, phase, region) => ({
    id: `${prefix}-${name}`,
    title: `${prefix} ${name} 합성 검증`,
    region,
    matchAt: at(phase),
    closesAt: at(phase),
    startsAt: at(phase + 1),
    endsAt: at(phase + 2),
    cancelRefundCutoffAt: at(-1),
    capacity: 12,
  });
  const events = {
    first: event("first", 1, `${prefix}-A`),
    primary: event("primary", 1, `${prefix}-B`),
    relocated: event("relocated", 1.25, `${prefix}-C`),
    failure: event("failure", 1, `${prefix}-D`),
    second: event("second", 4, `${prefix}-A`),
    transfer: event("transfer", 4, `${prefix}-E`),
  };
  // Relocated participants share exactly the first event's meeting window.
  events.relocated.startsAt = events.first.startsAt;
  events.relocated.endsAt = events.first.endsAt;
  return {
    version: 2,
    singleAmount: 9900,
    prefix,
    sourceSHA,
    deploymentId,
    createdAt: new Date(base).toISOString(),
    stepMs,
    headroomMs,
    // This participant attends the relocated first round and buys no further
    // ticket, leaving a real, unexpired two-use lot for the F04 public UI check.
    ticketLotUserIndex: 8,
    events,
    userIds: Array.from({ length: 18 }, (_, i) => `${prefix}-u${i}`),
    emails: Array.from({ length: 18 }, (_, i) => `${prefix}-u${i}@siktak.demo`),
    applicationIds: Array.from({ length: 18 }, (_, i) => `${prefix}-a${i}`),
    secondApplicationIds: Array.from(
      { length: 4 },
      (_, i) => `${prefix}-b${i}`,
    ),
  };
}

export function observationSQL(f) {
  const ids = list(f.userIds);
  const eids = list(Object.values(f.events).map((e) => e.id));
  const apps = `SELECT id FROM "Application" WHERE "userId" IN (${ids})`;
  const tables = `SELECT id FROM "DiningTable" WHERE "eventId" IN (${eids})`;
  const rooms = `SELECT id FROM "ChatRoom" WHERE "tableId" IN (${tables})`;
  const payments = `SELECT id FROM "Payment" WHERE "applicationId" IN (${apps})`;
  const refunds = `SELECT id FROM "Refund" WHERE "paymentId" IN (${payments})`;
  const notifications = `SELECT id FROM "Notification" WHERE "userId" IN (${ids})`;
  const scopes = {
    events: ["EventSlot", `id IN (${eids})`],
    applications: ["Application", `"userId" IN (${ids})`],
    payments: ["Payment", `"applicationId" IN (${apps})`],
    refunds: ["Refund", `"paymentId" IN (${payments})`],
    ledger: ["TicketEntry", `"userId" IN (${ids})`],
    relationships: [
      "Relationship",
      `"fromId" IN (${ids}) OR "toId" IN (${ids})`,
    ],
    tables: ["DiningTable", `"eventId" IN (${eids})`],
    rooms: ["ChatRoom", `"tableId" IN (${tables})`],
    messages: ["Message", `"roomId" IN (${rooms})`],
    feedback: ["Feedback", `"applicationId" IN (${apps})`],
    notifications: ["Notification", `"userId" IN (${ids})`],
    runs: ["MatchRun", `"eventId" IN (${eids})`],
    jobs: [
      "Job",
      `payload->>'eventId' IN (${eids}) OR payload->>'tableId' IN (${tables}) OR payload->>'refundId' IN (${refunds}) OR payload->>'notificationId' IN (${notifications})`,
    ],
    audits: ["AuditLog", `"objectId" IN (${apps}) OR "actorId" IN (${ids})`],
    privilegedAudits: [
      "AuditLog",
      `"actorId" IN (SELECT id FROM "User" WHERE role IN ('ADMIN','OPERATIONS','SAFETY')) AND "createdAt">=${q(f.createdAt)}::timestamptz`,
    ],
    exceptions: [
      "ExceptionCase",
      `"objectId" IN (${eids}) OR "objectId" IN (${apps}) OR "objectId" IN (${tables}) OR "objectId" IN (SELECT id FROM "Job" WHERE payload->>'eventId' IN (${eids}) OR payload->>'tableId' IN (${tables}) OR payload->>'refundId' IN (${refunds}) OR payload->>'notificationId' IN (${notifications}))`,
    ],
  };
  const entries = Object.entries(scopes).map(
    ([key, [table, where]]) =>
      `${q(key)},(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM "${table}" t WHERE ${where})`,
  );
  const fingerprints = [
    "events",
    "applications",
    "payments",
    "refunds",
    "ledger",
    "relationships",
    "tables",
    "rooms",
    "messages",
    "feedback",
    "runs",
  ].map((key) => {
    const [table, where] = scopes[key];
    return `${q(table)},(SELECT jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),''))) FROM "${table}" t WHERE NOT (${where}))`;
  });
  for (const [table, key] of [
    ["User", "id"],
    ["Profile", "userId"],
  ])
    fingerprints.push(
      `${q(table)},(SELECT jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY t."${key}"),''))) FROM "${table}" t WHERE t."${key}" NOT IN (${ids}))`,
    );
  return `SELECT jsonb_build_object('observedAt',clock_timestamp(),${entries.join(",")},'unrelatedFingerprints',jsonb_build_object(${fingerprints.join(",")})) AS evidence;`;
}

// Supabase's SQL connection can SET the existing private schema owner without
// inheriting its table privileges. Keep role/search-path changes transaction-local,
// restore the caller, and return only the captured evidence from this atomic block.
export function publicLifecycleSQL(f, statements = []) {
  const observation = observationSQL(f).replace(/;\s*$/, "");
  return `DO $siktak_lifecycle$
DECLARE
  original_role name := current_user;
  owner_role name;
  captured jsonb;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(nspowner) INTO STRICT owner_role
    FROM pg_catalog.pg_namespace WHERE nspname = 'siktak';
  EXECUTE format('SET LOCAL ROLE %I', owner_role);
  PERFORM pg_catalog.set_config('search_path', 'siktak, public', true);
  ${statements.length ? statements.join(";\n  ") + ";" : ""}
  SELECT observed.evidence INTO captured FROM (${observation}) observed;
  PERFORM pg_catalog.set_config('siktak.lifecycle_evidence', captured::text, true);
  EXECUTE format('SET LOCAL ROLE %I', original_role);
END;
$siktak_lifecycle$;
SELECT current_setting('siktak.lifecycle_evidence')::jsonb AS evidence;\n`;
}

export async function preparationStatements(f, password) {
  const { hashPassword } = await import("better-auth/crypto");
  assert(
    password?.length >= 12,
    "Use a synthetic account password of at least 12 characters",
  );
  const hashed = await hashPassword(password);
  const sql = [];
  for (let i = 0; i < f.userIds.length; i++) {
    const id = f.userIds[i];
    sql.push(
      `INSERT INTO "User" (id,name,email,"emailVerified",role,"updatedAt") VALUES (${q(id)},${q(`합성 참가자 ${i}`)},${q(f.emails[i])},true,'PARTICIPANT',now())`,
    );
    sql.push(
      `INSERT INTO "Account" (id,"accountId","providerId","userId",password,"updatedAt") VALUES (${q(`${id}-credential`)},${q(id)},'credential',${q(id)},${q(hashed)},now())`,
    );
    sql.push(
      `INSERT INTO "Profile" ("userId",contact,"birthYear",gender,occupation,mbti,interests,traits,"desiredTraits",budgets,"foodRestrictions",allergies,"consentVersion","consentAt","updatedAt") VALUES (${q(id)},'010-0000-0000',1997,${q(i % 2 ? "남성" : "여성")},'합성 검증',ARRAY[${q(i % 2 ? "ENFP" : "INTJ")}],ARRAY['여행','음식'],ARRAY['편안한 대화'],ARRAY['편안한 대화'],ARRAY['2만~3만원'],'없음 (합성)','없음 (합성)','qa-lifecycle-v1',now(),now())`,
    );
  }
  for (const e of Object.values(f.events)) {
    sql.push(
      `INSERT INTO "EventSlot" (id,title,region,"startsAt","endsAt","closesAt","matchAt","cancelRefundCutoffAt",capacity) VALUES (${list([e.id, e.title, e.region, e.startsAt, e.endsAt, e.closesAt, e.matchAt, e.cancelRefundCutoffAt])},${e.capacity})`,
    );
    sql.push(
      `INSERT INTO "VenueSlot" (id,"eventId",name,address,"mapUrl","reservationName",price,capacity,"totalTables","dietaryNotes") VALUES (${q(`${e.id}-venue`)},${q(e.id)},'합성 검증 가상 식당','합성 주소','https://map.naver.com','합성 예약',25000,6,3,'합성 조건 확인')`,
    );
    sql.push(
      `INSERT INTO "Job" (id,key,kind,payload,"runAt") VALUES (${q(`${e.id}-match-job`)},${q(`match:${e.id}`)},'MATCH',${q(JSON.stringify({ eventId: e.id }))}::jsonb,${q(e.matchAt)})`,
    );
  }
  return sql;
}

export async function prepareLifecycle(db, f, password) {
  const statements = await preparationStatements(f, password);
  await db.$transaction(
    async (tx) => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    },
    { timeout: 60000 },
  );
  const [row] = await db.$queryRawUnsafe(observationSQL(f));
  return row.evidence;
}

export async function runParticipantLifecycle({
  fixture: f,
  send,
  view,
  pollMs = 500,
  onProgress = () => {},
}) {
  const progress = [];
  const record = (name) => {
    const entry = { name, at: new Date().toISOString() };
    progress.push(entry);
    onProgress(entry);
  };
  const deadline =
    Date.parse(f.events.second.endsAt) + Math.max(f.stepMs * 2, 30000);
  async function until(label, predicate) {
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await delay(pollMs);
    }
    throw new Error(
      `Timed out waiting for ${label}; fixed schedule was not modified`,
    );
  }
  const application = async (i, id = f.applicationIds[i]) =>
    (await view(i)).applications.find((a) => a.id === id);
  async function apply(i, eventIds, applicationId = f.applicationIds[i]) {
    await send(i, "apply", {
      requestId: applicationId,
      eventIds,
      ticketType: i === f.ticketLotUserIndex ? "TRIPLE" : "SINGLE",
      consent: true,
    });
    await send(i, "pay", { requestId: `${applicationId}-pay`, applicationId });
  }
  assert(
    Date.now() < Date.parse(f.events.first.closesAt),
    "Preparation consumed the fixed application window; prepare a new prefix rather than changing times",
  );
  for (let i = 0; i < 18; i++) {
    const options =
      i < 4
        ? [f.events.first.id]
        : i < 8
          ? [f.events.second.id]
          : i < 11
            ? [f.events.primary.id, f.events.relocated.id]
            : i === 11
              ? [f.events.relocated.id]
              : i < 15
                ? [f.events.failure.id]
                : [f.events.transfer.id];
    await apply(i, options);
  }
  record("18 participant applications and mock payments submitted");
  await until("first round, reallocation and no-match", async () => {
    // Runs commit atomically. Poll one representative per outcome to avoid
    // repeatedly loading eleven complete participant views on the free server;
    // all individual applications are checked below and in the final evidence.
    const apps = await Promise.all([0, 8, 12].map((i) => application(i)));
    return (
      apps.slice(0, 2).every((a) => a?.matchStatus === "CONFIRMED") &&
      apps
        .slice(2)
        .every((a) =>
          ["ALTERNATIVE_OFFERED", "NO_MATCH"].includes(a?.matchStatus),
        )
    );
  });
  for (const i of [8, 9, 10])
    assert.equal(
      (await application(i)).table.event.id,
      f.events.relocated.id,
      "Actual consented alternative allocation",
    );
  await send(12, "resolve", {
    applicationId: f.applicationIds[12],
    choice: "TRANSFER",
    eventId: f.events.transfer.id,
  });
  await send(13, "resolve", {
    applicationId: f.applicationIds[13],
    choice: "KEEP",
  });
  await send(14, "resolve", {
    applicationId: f.applicationIds[14],
    choice: "REFUND",
  });
  // Repeated safe participant requests must not create duplicate financial rows.
  await send(13, "resolve", {
    applicationId: f.applicationIds[13],
    choice: "KEEP",
  });
  await send(14, "resolve", {
    applicationId: f.applicationIds[14],
    choice: "REFUND",
  });
  record(
    "automatic match/reallocation; participant transfer, keep and refund choices",
  );
  const room = (await application(0)).table.room;
  const chat = {
    roomId: room.id,
    requestId: `${f.prefix}-chat`,
    body: "합성 검증: 만나서 반가워요.",
  };
  await send(0, "message", chat);
  await send(0, "message", chat);
  await until("scheduled first-round content and reminder", async () => {
    const apps = await Promise.all([0, 8].map((i) => application(i)));
    return apps.every(
      (a) =>
        a.table.room.messages.filter((m) => m.kind === "CONTENT").length ===
          3 &&
        a.table.room.messages.some((m) => m.key === `reminder:${a.table.id}`),
    );
  });
  for (const i of [0, 1, 2, 3, 8, 9, 10, 11])
    await send(i, "checkin", { applicationId: f.applicationIds[i] });
  record("scheduled reminder/start content, participant chat and check-ins");
  await until(
    "scheduled first-round end and feedback invitation",
    async () =>
      Date.now() >= Date.parse(f.events.first.endsAt) &&
      (await view(0)).notifications.some(
        (n) => n.key === `feedback:${f.applicationIds[0]}`,
      ),
  );
  const feedback = (id, avoided = []) => ({
    applicationId: id,
    atmosphere: 4,
    conversation: 4,
    venue: 4,
    returnIntent: true,
    recommend: 8,
    comment: "합성 검증 피드백",
    liked: [],
    avoided,
  });
  for (const i of [0, 1, 2, 3, 8, 9, 10, 11])
    await send(
      i,
      "feedback",
      feedback(f.applicationIds[i], i === 0 ? [f.userIds[1]] : []),
    );
  await send(2, "block", {
    applicationId: f.applicationIds[2],
    targetId: f.userIds[3],
    reason: "합성 검증: 다음 회차 기존 차단 제외 확인",
  });
  for (let i = 0; i < 4; i++)
    await apply(i, [f.events.second.id], f.secondApplicationIds[i]);
  record(
    "scheduled end, actual attendance history, feedback AVOID and participant BLOCK persisted",
  );
  const secondId = (i) =>
    i < 4 ? f.secondApplicationIds[i] : f.applicationIds[i];
  await until("next scheduled match and transferred match", async () => {
    const apps = await Promise.all(
      [0, 1, 12].map((i) =>
        application(i, i < 8 ? secondId(i) : f.applicationIds[i]),
      ),
    );
    return apps.every((a) => a?.matchStatus === "CONFIRMED");
  });
  const second = await Promise.all(
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) => application(i, secondId(i))),
  );
  assert.notEqual(
    second[0].table.id,
    second[1].table.id,
    "Persisted AVOID pair must not share next table",
  );
  assert.notEqual(
    second[2].table.id,
    second[3].table.id,
    "Persisted BLOCK pair must not share next table",
  );
  for (const a of second)
    assert(a.table.members.length >= 4 && a.table.members.length <= 6);
  await until("next scheduled start content", async () => {
    const apps = await Promise.all(
      [0, 1, 12].map((i) =>
        application(i, i < 8 ? secondId(i) : f.applicationIds[i]),
      ),
    );
    return apps.every(
      (a) =>
        a.table.room.messages.filter((m) => m.kind === "CONTENT").length === 3,
    );
  });
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 12, 15, 16, 17])
    await send(i, "checkin", {
      applicationId: i < 8 ? secondId(i) : f.applicationIds[i],
    });
  record(
    "second scheduled match consumes saved exclusions; all eligible participants confirmed/check-in",
  );
  await until("all next-round end jobs and mock refund", async () => {
    const views = await Promise.all([0, 1, 12, 14].map(view));
    return (
      Date.now() >= Date.parse(f.events.second.endsAt) &&
      views
        .slice(0, 3)
        .every((v, index) =>
          v.notifications.some(
            (n) =>
              n.key ===
              `feedback:${index < 2 ? secondId(index) : f.applicationIds[12]}`,
          ),
        ) &&
      views[3].applications.find((a) => a.id === f.applicationIds[14])
        ?.paymentStatus === "REFUNDED"
    );
  });
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 12, 15, 16, 17])
    await send(
      i,
      "feedback",
      feedback(i < 8 ? secondId(i) : f.applicationIds[i]),
    );
  record(
    "two scheduled rounds ended; feedback submitted; service-failure mock refund completed",
  );
  return {
    prefix: f.prefix,
    sourceSHA: f.sourceSHA,
    deploymentId: f.deploymentId,
    progress,
    participantFlowPassed: true,
    forbiddenActions: [
      "admin commands",
      "direct runMatch/tick",
      "manual /api/jobs/run",
      "persisted event/job schedule edits",
    ],
    forbiddenActionsIssued: 0,
    limitations: [
      "Short events exercise overdue D-1 reminders, not 24-hour real-time waiting",
      "No real-device external push or human usability validation",
      "Final DB evidence verification is separate from participant HTTP success",
    ],
  };
}

export function verifyLifecycleEvidence(f, evidence, baseline) {
  assert.equal(
    f.ticketLotUserIndex,
    8,
    "Manifest includes the retained TRIPLE-ticket fixture contract",
  );
  assert.deepEqual(
    evidence.privilegedAudits,
    [],
    "No privileged changes after preparation",
  );
  assert.deepEqual(evidence.exceptions, [], "No unexpected fixture exceptions");
  assert.deepEqual(
    evidence.unrelatedFingerprints,
    baseline.unrelatedFingerprints,
    "Pre-existing unrelated domain rows preserved",
  );
  for (const e of Object.values(f.events)) {
    const actual = evidence.events.find((x) => x.id === e.id);
    assert(actual, `Persisted event ${e.id}`);
    for (const key of [
      "matchAt",
      "startsAt",
      "endsAt",
      "closesAt",
      "cancelRefundCutoffAt",
    ])
      assert.equal(
        Date.parse(actual[key]),
        Date.parse(e[key]),
        `${key} unchanged after preparation`,
      );
    const job = evidence.jobs.find((j) => j.key === `match:${e.id}`);
    assert.equal(job.status, "DONE");
    assert.equal(job.attempts, 1);
    assert.equal(Date.parse(job.runAt), Date.parse(e.matchAt));
    assert.equal(
      evidence.runs.filter((r) => r.eventId === e.id && r.status === "DONE")
        .length,
      1,
      "Exactly one successful scheduled run per event",
    );
  }
  assert.equal(evidence.applications.length, 22);
  assert.equal(evidence.payments.length, 22);
  const lotApplicationId = f.applicationIds[f.ticketLotUserIndex];
  for (const payment of evidence.payments)
    assert.equal(
      payment.amount,
      payment.applicationId === lotApplicationId
        ? 15000
        : (f.singleAmount ?? 8000),
    );
  assert(
    evidence.payments.every((p) => ["PAID", "REFUNDED"].includes(p.status)),
  );
  assert.equal(
    evidence.tables.length,
    5,
    "first + relocated + two next tables + transferred table",
  );
  for (const table of evidence.tables) {
    const apps = evidence.applications.filter((a) => a.tableId === table.id);
    assert.equal(apps.length, 4);
    assert(
      apps.every(
        (a) =>
          a.matchStatus === "CONFIRMED" &&
          a.attendanceStatus === "ATTENDED" &&
          !a.attendanceReviewRequired,
      ),
    );
    assert(evidence.rooms.some((r) => r.tableId === table.id));
    for (const [kind, suffix, expectedAt] of [
      [
        "START",
        "start",
        f.events[
          Object.keys(f.events).find(
            (key) => f.events[key].id === table.eventId,
          )
        ].startsAt,
      ],
      [
        "END",
        "end",
        f.events[
          Object.keys(f.events).find(
            (key) => f.events[key].id === table.eventId,
          )
        ].endsAt,
      ],
    ]) {
      const job = evidence.jobs.find((j) => j.key === `${suffix}:${table.id}`);
      assert.equal(job.kind, kind);
      assert.equal(job.status, "DONE");
      assert.equal(job.attempts, 1);
      assert.equal(Date.parse(job.runAt), Date.parse(expectedAt));
    }
    assert.equal(
      evidence.jobs.find((j) => j.key === `reminder:${table.id}`)?.status,
      "DONE",
    );
    assert.equal(
      evidence.messages.filter((m) => m.key === `welcome:${table.id}`).length,
      1,
    );
    assert.equal(
      evidence.messages.filter((m) => m.key === `reminder:${table.id}`).length,
      1,
    );
    assert.equal(
      evidence.messages.filter((m) => m.key.startsWith(`content:${table.id}:`))
        .length,
      3,
    );
    const future = evidence.jobs.find(
      (j) => j.key === `feedback-reminder:${table.id}`,
    );
    const event = evidence.events.find((e) => e.id === table.eventId);
    assert.equal(Date.parse(future.runAt), Date.parse(event.endsAt) + 86400000);
    assert.equal(
      future.status,
      "PENDING",
      "Real next-day reminder deliberately remains future work",
    );
    assert.equal(
      evidence.relationships.filter(
        (r) => r.kind === "MET" && r.sourceId === table.id,
      ).length,
      12,
      "All directed attendance-history pairs, no duplicates",
    );
  }
  assert.equal(evidence.feedback.length, 20);
  const nextRun = evidence.runs.find((r) => r.eventId === f.events.second.id);
  for (const [kind, from, to] of [
    ["AVOID", 0, 1],
    ["BLOCK", 2, 3],
  ]) {
    assert(
      nextRun.input.relations.some(
        (r) =>
          r.kind === kind &&
          r.fromId === f.userIds[from] &&
          r.toId === f.userIds[to] &&
          r.active,
      ),
      `Next scheduled match actually read persisted ${kind}`,
    );
    const next = (i) =>
      evidence.applications.find((a) => a.id === f.secondApplicationIds[i]);
    assert.notEqual(next(from).tableId, next(to).tableId);
  }
  for (const i of [8, 9, 10])
    assert.equal(
      evidence.audits.filter(
        (a) => a.action === "REALLOCATED" && a.objectId === f.applicationIds[i],
      ).length,
      1,
    );
  assert.equal(
    evidence.audits.filter(
      (a) =>
        a.action === "MATCH_TRANSFERRED" && a.objectId === f.applicationIds[12],
    ).length,
    1,
  );
  assert.equal(evidence.refunds.length, 1);
  assert.equal(evidence.refunds[0].amount, f.singleAmount ?? 8000);
  assert.equal(evidence.refunds[0].status, "REFUNDED");
  assert.equal(
    evidence.applications.find((a) => a.id === f.applicationIds[13]).resolution,
    "KEEP",
  );
  for (const i of [13, 14]) {
    const units = evidence.ledger
      .filter((e) => e.userId === f.userIds[i])
      .reduce((n, e) => n + e.units, 0);
    assert.equal(
      units,
      i === 13 ? 1 : 0,
      "Kept right restored once; refunded right not spendable",
    );
  }
  const lotApplication = evidence.applications.find(
    (a) => a.id === lotApplicationId,
  );
  assert.equal(lotApplication.ticketType, "TRIPLE");
  assert.equal(lotApplication.attendanceStatus, "ATTENDED");
  assert(
    evidence.feedback.some(
      (feedback) => feedback.applicationId === lotApplicationId,
    ),
  );
  const lotPayment = evidence.payments.find(
    (payment) => payment.applicationId === lotApplicationId,
  );
  const retainedEntries = evidence.ledger.filter(
    (entry) => entry.userId === f.userIds[f.ticketLotUserIndex],
  );
  assert.equal(
    retainedEntries.filter((entry) => entry.kind === "PURCHASE").length,
    1,
  );
  assert.equal(
    retainedEntries.find((entry) => entry.kind === "PURCHASE").units,
    3,
  );
  assert.equal(
    retainedEntries.filter((entry) => entry.kind === "RESERVE").length,
    1,
  );
  assert.equal(
    retainedEntries.filter((entry) => entry.kind === "CONSUME").length,
    1,
  );
  assert(retainedEntries.every((entry) => entry.paymentId === lotPayment.id));
  const lotExpiry = retainedEntries.find(
    (entry) => entry.kind === "PURCHASE",
  ).expiresAt;
  assert(
    Date.parse(lotExpiry) > Date.parse(evidence.observedAt),
    "Retained lot is genuinely unexpired",
  );
  assert(retainedEntries.every((entry) => entry.expiresAt === lotExpiry));
  assert.equal(
    retainedEntries.reduce((units, entry) => units + entry.units, 0),
    2,
  );
  assert.equal(evidence.ledger.filter((e) => e.kind === "CONSUME").length, 20);
  assert.equal(
    evidence.messages.filter((m) => m.kind === "CHAT").length,
    1,
    "Repeated participant message remains idempotent",
  );
  assert.equal(
    new Set(evidence.ledger.map((e) => e.key)).size,
    evidence.ledger.length,
  );
  assert.equal(
    new Set(evidence.notifications.map((e) => e.key)).size,
    evidence.notifications.length,
  );
  const due = evidence.jobs.filter(
    (j) => Date.parse(j.runAt) <= Date.parse(evidence.observedAt),
  );
  assert(
    due.every((j) => j.status === "DONE" && j.attempts === 1 && !j.lastError),
    "All due fixture work completed once without retries/errors",
  );
  return {
    databaseEvidencePassed: true,
    eventSchedulesUnchanged: true,
    privilegedChanges: 0,
    unexpectedExceptions: 0,
    unrelatedDomainRowsUnchanged: true,
    unrelatedDomainTablesCompared: Object.keys(evidence.unrelatedFingerprints),
    dueJobsCompleted: due.length,
    tables: 5,
    applications: 22,
    feedback: 20,
    retainedTicketLot: {
      userIndex: f.ticketLotUserIndex,
      applicationId: lotApplicationId,
      paymentId: lotPayment.id,
      availableUnits: 2,
      expiresAt: lotExpiry,
    },
    nextMatchReadPersistedAvoidAndBlock: true,
    real24HourReminderWaitVerified: false,
  };
}

async function httpAdapter(f, baseURL, password) {
  const cookies = [];
  const request = async (path, options) =>
    fetch(new URL(path, baseURL), {
      ...options,
      signal: AbortSignal.timeout(60000),
    });
  for (let i = 0; i < f.userIds.length; i++) {
    // better-auth protects sign-in with a stricter 3 requests / 10 seconds
    // rule in production. Respect it without changing server security settings.
    if (i > 0 && i % 3 === 0) await delay(11000);
    const response = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({ email: f.emails[i], password }),
    });
    assert.equal(response.status, 200, `Synthetic account ${i} sign-in`);
    cookies.push(
      response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    );
    assert(cookies[i]);
  }
  const headers = (i) => ({
    Cookie: cookies[i],
    Origin: baseURL,
    "Content-Type": "application/json",
  });
  return {
    send: async (i, action, data) => {
      const response = await request("/api/command", {
        method: "POST",
        headers: headers(i),
        body: JSON.stringify({ action, data }),
      });
      const body = await response.json();
      assert.equal(
        response.status,
        200,
        `${action} account ${i}: ${body.error ?? "failed"}`,
      );
      return body;
    },
    view: async (i) => {
      const response = await request("/api/view", { headers: headers(i) });
      assert.equal(response.status, 200, `Participant ${i} view`);
      return response.json();
    },
    close: async () => {
      for (let i = 0; i < cookies.length; i++) {
        const response = await request("/api/auth/sign-out", {
          method: "POST",
          headers: headers(i),
          body: "{}",
        });
        assert.equal(response.status, 200, `Synthetic account ${i} sign-out`);
      }
    },
  };
}

async function main() {
  const mode = process.argv[2] ?? "local";
  const manifest =
    process.env.LIFECYCLE_MANIFEST ?? ".codex/lifecycle-manifest.json";
  const reportPath =
    process.env.ACCEPTANCE_REPORT ?? ".codex/lifecycle-report.json";
  if (mode === "prepare-sql") {
    assert.equal(process.env.LIFECYCLE_MODE, "public-cron");
    assert(
      process.env.SOURCE_SHA && process.env.DEPLOYMENT_ID,
      "Bind public evidence to verified source/deployment",
    );
    const f = lifecycleFixture({
      // Free-service Cron drains a bounded queue. The original 3-minute
      // stages expired reminders behind 54 signup/payment PUSH jobs.
      // Wider fixed windows preserve every assertion without editing live times.
      stepMs: Number(process.env.LIFECYCLE_STEP_MS ?? 360000),
      headroomMs: Number(process.env.LIFECYCLE_HEADROOM_MS ?? 720000),
      sourceSHA: process.env.SOURCE_SHA,
      deploymentId: process.env.DEPLOYMENT_ID,
    });
    assert.match(f.sourceSHA, /^[0-9a-f]{40}$/);
    assert(
      f.headroomMs >= 360000,
      "Reserve six minutes for SQL preparation, rate-limited logins and participant commands",
    );
    const deploymentOrigin = new URL(process.env.BASE_URL).origin;
    assert(deploymentOrigin.startsWith("https://"));
    f.baseURL = deploymentOrigin;
    assert(
      f.stepMs >= 180000,
      "Public Cron requires at least three minutes per stage",
    );
    const sqlPath = process.env.LIFECYCLE_SQL ?? ".codex/lifecycle-prepare.sql";
    assert(
      resolve(sqlPath).startsWith(resolve(".codex") + "/"),
      "Preparation SQL contains password hashes: keep it in ignored .codex",
    );
    const statements = await preparationStatements(
      f,
      process.env.DEMO_PASSWORD,
    );
    await jsonFile(manifest, f);
    await writeFile(sqlPath, publicLifecycleSQL(f, statements), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        preparedSQL: sqlPath,
        manifest,
        prefix: f.prefix,
        firstMatchAt: f.events.first.matchAt,
        finalEndAt: f.events.second.endsAt,
      }),
    );
    return;
  }
  if (["observe-sql", "verify", "public-http"].includes(mode)) {
    const f = JSON.parse(await readFile(manifest, "utf8"));
    if (mode === "observe-sql") {
      const sqlPath =
        process.env.LIFECYCLE_SQL ?? ".codex/lifecycle-observe.sql";
      await writeFile(sqlPath, publicLifecycleSQL(f), { mode: 0o600 });
      console.log(
        JSON.stringify({ observationSQL: sqlPath, prefix: f.prefix }),
      );
      return;
    }
    if (mode === "verify") {
      const evidence = JSON.parse(
        await readFile(process.env.LIFECYCLE_EVIDENCE, "utf8"),
      );
      const baseline = JSON.parse(
        await readFile(process.env.LIFECYCLE_BASELINE, "utf8"),
      );
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(report.prefix, f.prefix);
      Object.assign(report, verifyLifecycleEvidence(f, evidence, baseline), {
        evidenceObservedAt: evidence.observedAt,
      });
      await jsonFile(reportPath, report);
      console.log(JSON.stringify({ report: reportPath, ...report }));
      return;
    }
    assert.equal(process.env.LIFECYCLE_MODE, "public-cron");
    const baseURL = new URL(process.env.BASE_URL).origin;
    assert(baseURL.startsWith("https://"));
    assert.equal(
      baseURL,
      f.baseURL,
      "Prepared fixture belongs to this deployment origin",
    );
    assert.equal(
      process.env.SOURCE_SHA,
      f.sourceSHA,
      "Prepared fixture source binding",
    );
    assert.equal(
      process.env.DEPLOYMENT_ID,
      f.deploymentId,
      "Prepared fixture deployment binding",
    );
    let adapter;
    try {
      adapter = await httpAdapter(f, baseURL, process.env.DEMO_PASSWORD);
      const report = await runParticipantLifecycle({
        fixture: f,
        ...adapter,
        pollMs: 10000,
        onProgress: (entry) => console.log(JSON.stringify(entry)),
      });
      await jsonFile(reportPath, {
        ...report,
        scheduler: "external Supabase Cron; no manual trigger",
        baseURL,
      });
    } catch (error) {
      await jsonFile(reportPath, {
        prefix: f.prefix,
        sourceSHA: f.sourceSHA,
        deploymentId: f.deploymentId,
        participantFlowPassed: false,
        failedAt: new Date().toISOString(),
        error: error.message,
      });
      throw error;
    } finally {
      await adapter?.close();
    }
    return;
  }
  assert.equal(mode, "local");
  assert(
    new URL(process.env.DATABASE_URL).pathname.endsWith("_test"),
    "Local worker mode requires an isolated _test database",
  );
  const { db } = await import("../src/server/db.ts");
  const { command } = await import("../src/server/commands.ts");
  const { participantView } = await import("../src/server/views.ts");
  const sourceSHA = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const f = lifecycleFixture({
    sourceSHA,
    stepMs: Number(process.env.LIFECYCLE_STEP_MS ?? 15000),
  });
  const baseline = await prepareLifecycle(
    db,
    f,
    process.env.DEMO_PASSWORD ?? `synthetic-${randomUUID()}`,
  );
  await jsonFile(manifest, f);
  const worker = spawn(
    process.execPath,
    ["--import", "tsx", "src/worker/index.ts"],
    {
      env: { ...process.env, DEMO_MODE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  worker.stderr.on("data", (value) => {
    errors += value;
  });
  const actor = (i) => ({
    id: f.userIds[i],
    name: `합성 참가자 ${i}`,
    role: "PARTICIPANT",
  });
  try {
    const report = await runParticipantLifecycle({
      fixture: f,
      send: (i, action, data) => command(actor(i), action, data),
      view: (i) => participantView(actor(i)),
      onProgress: (entry) => console.log(JSON.stringify(entry)),
    });
    await delay(2000);
    const [row] = await db.$queryRawUnsafe(observationSQL(f));
    Object.assign(report, verifyLifecycleEvidence(f, row.evidence, baseline));
    assert.equal(errors, "", "Independent production worker stderr");
    await jsonFile(reportPath, {
      ...report,
      scheduler: "independent production worker process; real wall clock",
    });
    console.log(JSON.stringify({ report: reportPath, ...report }));
  } finally {
    worker.kill("SIGTERM");
    await Promise.race([
      once(worker, "exit"),
      delay(5000).then(() => worker.kill("SIGKILL")),
    ]);
    await db.$disconnect();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
