import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { maxDuration } from "@/app/api/jobs/run/route";
import { schedulerLimits } from "@/worker/scheduler";

// Execute the deployment SQL unchanged in a disposable database. Only pg_cron,
// Vault and pg_net are fixtures; eligibility, persistence and throttling use
// real PostgreSQL. Never reset the shared test or deployment database.
const url = new URL(process.env.DATABASE_URL!);
if (!url.pathname.endsWith("_test")) throw new Error("Wrong database");
const admin = new PrismaClient();
const database = `siktak_cron_${randomBytes(6).toString("hex")}_test`;
const dispatcherRole = `${database}_dispatcher`;
const appOwner = `${database}_app`;
url.pathname = `/${database}`;
url.searchParams.set("schema", "public");
const fixture = new PrismaClient({ datasourceUrl: url.toString() });
url.username = dispatcherRole;
url.password = randomBytes(24).toString("hex");
const dispatcher = new PrismaClient({ datasourceUrl: url.toString() });
let created = false;
let rolesCreated = false;
const source = readFileSync("deploy/supabase-cron.sql", "utf8");
const install = () =>
  dispatcher.$executeRawUnsafe(
    `DO $fixture$ BEGIN EXECUTE $source$${source}$source$; END $fixture$;`,
  );
const tick = () =>
  dispatcher.$executeRawUnsafe(`DO $fixture$ DECLARE command text; BEGIN
    SELECT sql INTO command FROM cron.jobs WHERE name = 'siktak-jobs';
    EXECUTE command;
  END $fixture$;`);
async function heartbeat() {
  const [row] = await fixture.$queryRawUnsafe<
    { value: Record<string, unknown> }[]
  >(
    `SELECT value FROM siktak."Setting" WHERE key = 'schedulerDispatchHeartbeat'`,
  );
  return row.value;
}
async function calls() {
  const [row] = await fixture.$queryRawUnsafe<{ count: number }[]>(
    `SELECT count(*)::integer AS count FROM net.calls`,
  );
  return row.count;
}

beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  created = true;
  await admin.$executeRawUnsafe(`DO $fixture$ BEGIN
    CREATE ROLE "${dispatcherRole}" LOGIN NOINHERIT PASSWORD '${url.password}';
    CREATE ROLE "${appOwner}" NOLOGIN;
    GRANT "${appOwner}" TO "${dispatcherRole}" WITH INHERIT FALSE, SET TRUE;
  END $fixture$;`);
  rolesCreated = true;
  await fixture.$executeRawUnsafe(`DO $fixture$ BEGIN
    CREATE SCHEMA siktak;
    CREATE SCHEMA cron;
    CREATE SCHEMA vault;
    CREATE SCHEMA net;
    CREATE TABLE siktak."Job" (id text PRIMARY KEY, status text,
      "runAt" timestamp, "lockedAt" timestamp);
    CREATE TABLE siktak."Setting" (key text PRIMARY KEY, value jsonb);
    CREATE TABLE cron.jobs (name text PRIMARY KEY, schedule text, sql text);
    CREATE TABLE vault.decrypted_secrets (name text PRIMARY KEY, decrypted_secret text);
    INSERT INTO vault.decrypted_secrets VALUES
      ('siktak_web_url', 'https://fixture.invalid'),
      ('siktak_scheduler_secret', 'synthetic-fixture-secret-at-least-32-characters');
    CREATE TABLE net.calls (id bigserial PRIMARY KEY, url text, headers jsonb,
      body jsonb, timeout integer, actor text DEFAULT current_user);
    CREATE FUNCTION cron.schedule(name text, schedule text, command text)
      RETURNS bigint LANGUAGE sql AS $function$
      INSERT INTO cron.jobs VALUES ($1, $2, $3)
      ON CONFLICT (name) DO UPDATE SET schedule = EXCLUDED.schedule, sql = EXCLUDED.sql
      RETURNING 1::bigint;
    $function$;
    CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
      RETURNS bigint LANGUAGE sql AS $function$
      INSERT INTO net.calls (url, headers, body, timeout) VALUES ($1, $2, $3, $4)
      RETURNING id;
    $function$;
    ALTER SCHEMA siktak OWNER TO "${appOwner}";
    ALTER TABLE siktak."Job" OWNER TO "${appOwner}";
    ALTER TABLE siktak."Setting" OWNER TO "${appOwner}";
    ALTER TABLE siktak."Job" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE siktak."Setting" ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON SCHEMA siktak FROM PUBLIC;
    GRANT USAGE ON SCHEMA cron, vault, net TO "${dispatcherRole}";
    GRANT SELECT ON vault.decrypted_secrets TO "${dispatcherRole}";
    GRANT ALL ON cron.jobs, net.calls TO "${dispatcherRole}";
    GRANT USAGE ON SEQUENCE net.calls_id_seq TO "${dispatcherRole}";
  END $fixture$;`);
  await install();
}, 30000);
beforeEach(async () => {
  await fixture.$executeRawUnsafe(
    `TRUNCATE siktak."Job", siktak."Setting", net.calls`,
  );
});
afterAll(async () => {
  await dispatcher.$disconnect();
  await fixture.$disconnect();
  if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
  if (rolesCreated) {
    await admin.$executeRawUnsafe(
      `DROP ROLE "${dispatcherRole}", "${appOwner}"`,
    );
  }
  await admin.$disconnect();
}, 30000);

describe("Supabase conditional cron SQL", () => {
  it("uses SET-only membership for the RLS-protected app schema and restores the cron role for HTTP", async () => {
    await expect(
      dispatcher.$queryRawUnsafe(`SELECT * FROM siktak."Job"`),
    ).rejects.toThrow(/permission denied/);
    await fixture.$executeRawUnsafe(`INSERT INTO siktak."Job" VALUES
      ('due', 'PENDING', now(), null)`);
    await tick();
    expect((await heartbeat()).hasDueJobs).toBe(true);
    const [request] = await fixture.$queryRawUnsafe<{ actor: string }[]>(
      `SELECT actor FROM net.calls`,
    );
    expect(request.actor).toBe(dispatcherRole);
    await expect(
      dispatcher.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${appOwner}"`);
        return tx.$queryRawUnsafe(`SELECT * FROM vault.decrypted_secrets`);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("updates one named schedule and does not contact the web while idle", async () => {
    await install();
    const rows = await fixture.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM cron.jobs`,
    );
    expect(rows).toEqual([{ name: "siktak-jobs" }]);
    await tick();
    expect(await calls()).toBe(0);
    expect(await heartbeat()).toMatchObject({
      hasDueJobs: false,
      oldestDueAt: null,
    });
  });

  it("keeps future jobs and live or terminal claims asleep, then dispatches a due job", async () => {
    await fixture.$executeRawUnsafe(`INSERT INTO siktak."Job" VALUES
      ('future', 'PENDING', now() + interval '1 hour', null),
      ('active', 'RUNNING', now() - interval '1 hour', now()),
      ('done', 'DONE', now() - interval '1 hour', null),
      ('failed', 'FAILED', now() - interval '1 hour', null),
      ('no-claim', 'RUNNING', now() - interval '1 hour', null)`);
    await tick();
    expect(await calls()).toBe(0);
    await fixture.$executeRawUnsafe(
      `UPDATE siktak."Job" SET "runAt" = now() - interval '1 minute' WHERE id = 'future'`,
    );
    await tick();
    expect(await calls()).toBe(1);
    expect(await heartbeat()).toMatchObject({ hasDueJobs: true });
    const [request] = await fixture.$queryRawUnsafe<
      {
        url: string;
        headers: Record<string, string>;
        timeout: number;
      }[]
    >(`SELECT url, headers, timeout FROM net.calls`);
    expect(request).toMatchObject({
      url: "https://fixture.invalid/api/jobs/run",
      headers: {
        Authorization: "Bearer synthetic-fixture-secret-at-least-32-characters",
      },
      timeout: 240000,
    });
    // The real dispatch SQL must outlive the HTTP handler and its child process.
    expect(request.timeout).toBeGreaterThan(maxDuration * 1000);
    expect(maxDuration * 1000).toBeGreaterThan(schedulerLimits.httpBudgetMs);
    expect(schedulerLimits.httpBudgetMs).toBeGreaterThan(
      schedulerLimits.hardTimeoutMs,
    );
  });

  it("recovers an expired claim and uses its recovery time to measure dispatch delay", async () => {
    await fixture.$executeRawUnsafe(`INSERT INTO siktak."Job" VALUES
      ('stale', 'RUNNING', now() - interval '1 day', now() - interval '6 minutes')`);
    await tick();
    expect(await calls()).toBe(1);
    const value = await heartbeat();
    const dueAge = Date.now() - Date.parse(String(value.oldestDueAt));
    expect(dueAge).toBeGreaterThanOrEqual(59000);
    expect(dueAge).toBeLessThan(90000);
  });

  it("throttles idle writes, refreshes after five minutes and records queue transitions immediately", async () => {
    await tick();
    const first = await heartbeat();
    await tick();
    expect(await heartbeat()).toEqual(first);
    await fixture.$executeRawUnsafe(`UPDATE siktak."Setting"
      SET value = jsonb_set(value, '{at}', to_jsonb(now() - interval '6 minutes'))`);
    await tick();
    expect(
      Date.now() - Date.parse(String((await heartbeat()).at)),
    ).toBeLessThan(10000);
    await fixture.$executeRawUnsafe(`INSERT INTO siktak."Job" VALUES
      ('due', 'PENDING', now(), null)`);
    await tick();
    expect((await heartbeat()).hasDueJobs).toBe(true);
    await fixture.$executeRawUnsafe(`UPDATE siktak."Job" SET status = 'DONE'`);
    await tick();
    expect(await heartbeat()).toMatchObject({
      hasDueJobs: false,
      oldestDueAt: null,
    });
    expect(await calls()).toBe(1);
  });

  it("never replaces the application's actual execution outcome", async () => {
    const original = {
      at: "2026-10-15T12:00:00Z",
      status: "FAILED",
      failed: 2,
    };
    await fixture.$executeRawUnsafe(
      `INSERT INTO siktak."Setting" VALUES ('schedulerHeartbeat', $1::jsonb)`,
      JSON.stringify(original),
    );
    await tick();
    const [row] = await fixture.$queryRawUnsafe<{ value: unknown }[]>(
      `SELECT value FROM siktak."Setting" WHERE key = 'schedulerHeartbeat'`,
    );
    expect(row.value).toEqual(original);
  });

  it.each(["invalid timestamp", null, "2999-01-01T00:00:00Z"])(
    "repairs a malformed or future dispatch timestamp without stopping subsequent ticks: %s",
    async (at) => {
      await fixture.$executeRawUnsafe(
        `INSERT INTO siktak."Setting" VALUES ('schedulerDispatchHeartbeat', $1::jsonb)`,
        JSON.stringify({ at, hasDueJobs: false, oldestDueAt: null }),
      );
      await tick();
      expect(
        Date.now() - Date.parse(String((await heartbeat()).at)),
      ).toBeLessThan(10000);
      expect(await calls()).toBe(0);
    },
  );

  it("does not refresh a healthy dispatch record when HTTP could not be queued", async () => {
    await tick();
    const before = await heartbeat();
    await fixture.$executeRawUnsafe(`INSERT INTO siktak."Job" VALUES
      ('due', 'PENDING', now(), null)`);
    await fixture.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION net.http_post(
      url text, headers jsonb, body jsonb, timeout_milliseconds integer)
      RETURNS bigint LANGUAGE plpgsql AS $function$ BEGIN
        RAISE EXCEPTION 'fixture dispatch unavailable';
      END $function$;`);
    try {
      await expect(tick()).rejects.toThrow(/fixture dispatch unavailable/);
      expect(await heartbeat()).toEqual(before);
      expect(await calls()).toBe(0);
    } finally {
      await fixture.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION net.http_post(
        url text, headers jsonb, body jsonb, timeout_milliseconds integer)
        RETURNS bigint LANGUAGE sql AS $function$
        INSERT INTO net.calls (url, headers, body, timeout) VALUES ($1, $2, $3, $4)
        RETURNING id;
      $function$;`);
    }
  });
});
