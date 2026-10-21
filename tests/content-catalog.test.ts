import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { atomic, db, type Actor } from "@/server/db";
import { enqueue } from "@/server/jobs";
import { execute } from "@/worker/runner";
import { adminView } from "@/server/views";
import {
  contentCatalog,
  contentCommand,
  freezeTableContent,
  selectContentSnapshot,
  sendTableContent,
} from "@/server/content-catalog";
import type { ContentDraft, ContentSnapshot } from "@/domain/content-catalog";

const operator: Actor = {
  id: "content-test-admin",
  name: "콘텐츠 운영자",
  role: "OPERATIONS",
};
const base: ContentDraft = {
  title: "함께 고르는 여행",
  body: "다시 가고 싶은 곳을 하나씩 소개해요. 패스해도 괜찮아요.",
  kind: "QUESTION",
  timing: "START",
  tag: "여행",
  priority: 50,
  validFrom: null,
  validUntil: null,
};
const change = (action: string, input: unknown, actor = operator) =>
  atomic((tx) => contentCommand(tx, actor, action, input));
async function publish(id = "content-test-a", draft = base) {
  await change("contentSave", { id, expectedVersion: 0, draft });
  await change("contentPublish", { id, expectedVersion: 1 });
}
async function fixture(id = "content-test-table") {
  const start = new Date(Date.now() + 2 * 86400000);
  await db.eventSlot.create({
    data: {
      id,
      title: "콘텐츠 시험",
      region: "홍대",
      startsAt: start,
      endsAt: new Date(+start + 7200000),
      closesAt: new Date(+start - 86400000),
      matchAt: new Date(+start - 86400000),
      cancelRefundCutoffAt: new Date(+start - 172800000),
    },
  });
  await db.diningTable.create({
    data: {
      id,
      eventId: id,
      runId: id,
      score: 1,
      evaluation: {},
      explanation: "테스트",
      room: { create: {} },
    },
  });
  for (let i = 0; i < 4; i++) {
    const userId = `${id}-user-${i}`;
    await db.user.create({
      data: {
        id: userId,
        name: "참가자",
        email: `${userId}@example.test`,
        profile: {
          create: {
            contact: "01000000000",
            birthYear: 1997,
            gender: "기타",
            occupation: "테스트",
            mbti: ["INTJ"],
            interests: ["여행"],
            traits: ["깊은 대화"],
            desiredTraits: ["편안한 대화"],
            budgets: ["2만~3만원"],
            foodRestrictions: "없음",
            allergies: "없음",
            consentVersion: "test",
            consentAt: new Date(),
          },
        },
      },
    });
    await db.application.create({
      data: {
        id: userId,
        userId,
        tableId: id,
        applicationStatus: "SUBMITTED",
        paymentStatus: "PAID",
        matchStatus: "CONFIRMED",
        ticketType: "SINGLE",
      },
    });
  }
  await atomic(async (tx) => {
    await enqueue(tx, `start:${id}`, "START", { tableId: id }, start);
    await enqueue(
      tx,
      `reminder:${id}`,
      "REMINDER",
      { tableId: id },
      new Date(+start - 86400000),
    );
    await enqueue(
      tx,
      `end:${id}`,
      "END",
      { tableId: id },
      new Date(+start + 7200000),
    );
    await freezeTableContent(tx, id);
  });
  return await db.job.findUniqueOrThrow({ where: { key: `start:${id}` } });
}
async function clean() {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await db.message.deleteMany({
    where: { room: { tableId: { startsWith: "content-test-" } } },
  });
  await db.chatRoom.deleteMany({
    where: { tableId: { startsWith: "content-test-" } },
  });
  await db.application.deleteMany({
    where: { id: { startsWith: "content-test-" } },
  });
  await db.diningTable.deleteMany({
    where: { id: { startsWith: "content-test-" } },
  });
  await db.eventSlot.deleteMany({
    where: { id: { startsWith: "content-test-" } },
  });
  await db.user.deleteMany({ where: { id: { startsWith: "content-test-" } } });
  await db.job.deleteMany({ where: { key: { contains: "content-test-" } } });
  await db.setting.deleteMany({
    where: {
      OR: [
        { key: { startsWith: "content:item:content-test-" } },
        { key: { startsWith: "content:revision:content-test-" } },
      ],
    },
  });
  await db.auditLog.deleteMany({
    where: { OR: [{ actorId: operator.id }, { action: "CONTENT_SCHEDULED" }] },
  });
}
beforeEach(clean);
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await clean();
  await db.$disconnect();
});

describe("operator content catalog and immutable scheduled delivery", () => {
  it("exposes content through the operations view without leaking raw drafts or revisions to safety roles", async () => {
    const secretDraft = "미게시 운영 초안 전용 표식";
    await publish("content-test-a", { ...base, body: "게시본 운영 전용 표식" });
    await change("contentSave", {
      id: "content-test-a",
      expectedVersion: 2,
      draft: { ...base, body: secretDraft },
    });
    const operations = await adminView(operator);
    expect(
      operations.contentCatalog.find((item) => item.id === "content-test-a")
        ?.draft.body,
    ).toBe(secretDraft);
    expect(
      operations.settings.some((setting) => setting.key.startsWith("content:")),
    ).toBe(false);
    const safety = await adminView({ ...operator, role: "SAFETY" });
    expect(safety.contentCatalog).toEqual([]);
    expect(safety.settings).toEqual([]);
    expect(JSON.stringify(safety)).not.toContain(secretDraft);
    expect(JSON.stringify(safety)).not.toContain("게시본 운영 전용 표식");
    await expect(
      adminView({ ...operator, role: "PARTICIPANT" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("saves a draft without publishing, publishes an immutable revision and records audit", async () => {
    await change("contentSave", {
      id: "content-test-a",
      expectedVersion: 0,
      draft: base,
    });
    expect(
      (await contentCatalog(db)).find((x) => x.id === "content-test-a")
        ?.published,
    ).toBeNull();
    await change("contentPublish", {
      id: "content-test-a",
      expectedVersion: 1,
    });
    await change("contentSave", {
      id: "content-test-a",
      expectedVersion: 2,
      draft: { ...base, body: "아직 게시하지 않은 수정" },
    });
    const item = (await contentCatalog(db)).find(
      (x) => x.id === "content-test-a",
    )!;
    expect(item.published?.body).toBe(base.body);
    expect(item.draft.body).toBe("아직 게시하지 않은 수정");
    expect(await db.auditLog.count({ where: { actorId: operator.id } })).toBe(
      3,
    );
  });

  it("rejects unauthorized roles, markup, invalid windows, stale updates and expired publications", async () => {
    for (const role of ["PARTICIPANT", "SAFETY"])
      await expect(
        change(
          "contentSave",
          { id: "content-test-a", expectedVersion: 0, draft: base },
          { ...operator, role },
        ),
      ).rejects.toMatchObject({ status: 403 });
    for (const body of [
      "<script>alert(1)</script>",
      "javascript:alert(1)",
      "<img src=x onerror=alert(1)>",
      "\u0000hidden",
    ])
      await expect(
        change("contentSave", {
          id: "content-test-a",
          expectedVersion: 0,
          draft: { ...base, body },
        }),
      ).rejects.toThrow();
    await expect(
      change("contentSave", {
        id: "content-test-a",
        expectedVersion: 0,
        draft: {
          ...base,
          validFrom: "2030-02-01T00:00:00.000Z",
          validUntil: "2030-01-01T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow();
    await publish();
    await expect(
      change("contentSave", {
        id: "content-test-a",
        expectedVersion: 1,
        draft: base,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await change("contentSave", {
      id: "content-test-old",
      expectedVersion: 0,
      draft: { ...base, validUntil: "2020-01-01T00:00:00.000Z" },
    });
    await expect(
      change("contentPublish", { id: "content-test-old", expectedVersion: 1 }),
    ).rejects.toThrow("유효기간");
  });

  it("resolves competing rules by priority and ID using factual tags and the scheduled validity window", async () => {
    await publish("content-test-b", {
      ...base,
      title: "두 번째 여행 주제",
      priority: 60,
    });
    await publish("content-test-a", { ...base, priority: 60 });
    await publish("content-test-c", {
      ...base,
      title: "깊은 대화 주제",
      tag: "깊은 대화",
      priority: 80,
    });
    await publish("content-test-other", {
      ...base,
      tag: "운동",
      priority: 100,
    });
    await publish("content-test-not-start", {
      ...base,
      timing: "END",
      priority: 100,
    });
    await publish("content-test-expiring", {
      ...base,
      validUntil: new Date(Date.now() + 3600000).toISOString(),
      priority: 100,
    });
    const snapshot = selectContentSnapshot(
      await contentCatalog(db),
      "START",
      new Date(Date.now() + 86400000),
      ["여행"],
      ["깊은 대화"],
    );
    expect(snapshot.cards.map((x) => x.id)).toEqual([
      "content-test-c",
      "content-test-a",
      "content-test-b",
    ]);
    expect(snapshot.fallback).toHaveLength(3);
  });

  it("deduplicates identical publications before filling three distinct start topics", async () => {
    await publish();
    await publish("content-test-duplicate", { ...base, priority: 90 });
    const job = await fixture();
    const snapshot = (
      job.payload as unknown as { contentSnapshot: ContentSnapshot }
    ).contentSnapshot;
    expect(snapshot.cards.map((card) => card.id)).toEqual([
      "content-test-duplicate",
    ]);
    await atomic((tx) => sendTableContent(tx, job));
    const messages = await db.message.findMany({
      where: { room: { tableId: "content-test-table" }, kind: "CONTENT" },
    });
    expect(messages).toHaveLength(3);
    expect(new Set(messages.map((message) => message.body)).size).toBe(3);
  });

  it("serializes competing publications and rolls back a failed content mutation", async () => {
    await change("contentSave", {
      id: "content-test-a",
      expectedVersion: 0,
      draft: base,
    });
    const results = await Promise.allSettled([
      change("contentPublish", { id: "content-test-a", expectedVersion: 1 }),
      change("contentPublish", { id: "content-test-a", expectedVersion: 1 }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await db.setting.count({
        where: { key: { startsWith: "content:revision:content-test-a:" } },
      }),
    ).toBe(1);
    await expect(
      atomic(async (tx) => {
        await contentCommand(tx, operator, "contentStop", {
          id: "content-test-a",
          expectedVersion: 2,
        });
        throw new Error("injected rollback");
      }),
    ).rejects.toThrow("injected rollback");
    const item = (await contentCatalog(db)).find(
      (entry) => entry.id === "content-test-a",
    )!;
    expect(item.activeRevision).toBe(2);
    expect(item.stoppedThrough).toBe(0);
    expect(
      await db.auditLog.count({
        where: { actorId: operator.id, action: "CONTENT_STOPPED" },
      }),
    ).toBe(0);
  });

  it("freezes publications and defaults at reservation, preserves sent messages after edits and rejects duplicate delivery", async () => {
    await publish();
    const job = await fixture();
    const originalPayload = job.payload;
    await change("contentSave", {
      id: "content-test-a",
      expectedVersion: 2,
      draft: { ...base, body: "예약 뒤 바뀐 게시본" },
    });
    await change("contentPublish", {
      id: "content-test-a",
      expectedVersion: 3,
    });
    await atomic((tx) => freezeTableContent(tx, "content-test-table"));
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: job.id } })).payload,
    ).toEqual(originalPayload);
    const persistedJob = await db.job.findUniqueOrThrow({
      where: { id: job.id },
    });
    await Promise.all([execute(persistedJob), execute(persistedJob)]);
    const messages = await db.message.findMany({
      where: { kind: "CONTENT" },
      orderBy: { key: "asc" },
    });
    expect(
      messages.filter((m) => m.key?.includes("content-test-table")),
    ).toHaveLength(3);
    expect(messages.some((m) => m.body === `${base.title}\n${base.body}`)).toBe(
      true,
    );
    expect(messages.some((m) => m.body.includes("예약 뒤 바뀐 게시본"))).toBe(
      false,
    );
  });

  it("stops unsent old revisions even after republishing and fills start cards with frozen defaults", async () => {
    await publish();
    const job = await fixture();
    await change("contentStop", { id: "content-test-a", expectedVersion: 2 });
    await change("contentPublish", {
      id: "content-test-a",
      expectedVersion: 3,
    });
    await atomic((tx) => sendTableContent(tx, job));
    const messages = await db.message.findMany({
      where: { room: { tableId: "content-test-table" }, kind: "CONTENT" },
    });
    expect(messages).toHaveLength(3);
    expect(messages.some((m) => m.body.includes(base.title))).toBe(false);
    expect(
      (job.payload as unknown as { contentSnapshot: ContentSnapshot })
        .contentSnapshot.cards[0].revision,
    ).toBe(2);
  });

  it("falls back when delivery occurs after expiration and skips canceled or replaced tables", async () => {
    await publish("content-test-a", {
      ...base,
      validUntil: new Date(Date.now() + 3 * 86400000).toISOString(),
    });
    const job = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4 * 86400000);
    // Extend only this fixture's end so the late-delivery expiry path is exercised.
    await db.eventSlot.update({
      where: { id: "content-test-table" },
      data: { endsAt: new Date(Date.now() + 86400000) },
    });
    await atomic((tx) => sendTableContent(tx, job));
    const messages = await db.message.findMany({
      where: { room: { tableId: "content-test-table" }, kind: "CONTENT" },
    });
    expect(messages).toHaveLength(3);
    expect(messages.some((m) => m.body.includes(base.title))).toBe(false);
    vi.useRealTimers();
    const replacement = await fixture("content-test-replaced");
    await db.diningTable.update({
      where: { id: "content-test-replaced" },
      data: { status: "REALLOCATING" },
    });
    expect(await atomic((tx) => sendTableContent(tx, replacement))).toBe(0);
    const canceled = await fixture("content-test-canceled");
    await db.eventSlot.update({
      where: { id: "content-test-canceled" },
      data: { status: "CANCELED" },
    });
    expect(await atomic((tx) => sendTableContent(tx, canceled))).toBe(0);
  });

  it("provides three default start cards without catalog entries and schedules other timings independently", async () => {
    const job = await fixture();
    expect(await atomic((tx) => sendTableContent(tx, job))).toBe(3);
    await publish("content-test-reminder", {
      ...base,
      timing: "REMINDER",
      tag: "전체",
    });
    await publish("content-test-end", { ...base, timing: "END", tag: "전체" });
    await fixture("content-test-timed");
    const jobs = await db.job.findMany({
      where: {
        key: { in: ["reminder:content-test-timed", "end:content-test-timed"] },
      },
    });
    for (const timed of jobs)
      expect(await atomic((tx) => sendTableContent(tx, timed))).toBe(1);
    expect(
      await db.message.count({
        where: { room: { tableId: "content-test-timed" }, kind: "CONTENT" },
      }),
    ).toBe(2);
  });
});
