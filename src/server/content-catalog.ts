import { z } from "zod";
import type { Job, Prisma } from "@prisma/client";
import { pickContent } from "@/domain/content";
import {
  contentKinds,
  contentTags,
  contentTimings,
  type ContentDraft,
  type ContentItem,
  type ContentRevision,
  type ContentCatalogEntry,
  type ContentSnapshot,
  type ContentTiming,
} from "@/domain/content-catalog";
import { admin, audit, ensure, type Actor, type Tx } from "./db";

const itemPrefix = "content:item:";
const revisionKey = (id: string, revision: number) =>
  `content:revision:${id}:${revision}`;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]|(?:javascript|data|vbscript)\s*:/i.test(
          value,
        ),
      "HTML·스크립트 없이 일반 텍스트만 입력해 주세요.",
    );
const draftSchema = z
  .object({
    title: plain(100),
    body: plain(2000),
    kind: z.enum(contentKinds),
    timing: z.enum(contentTimings),
    tag: z.enum(contentTags),
    priority: z.number().int().min(0).max(100),
    validFrom: z.iso
      .datetime()
      .transform((value) => new Date(value).toISOString())
      .nullable(),
    validUntil: z.iso
      .datetime()
      .transform((value) => new Date(value).toISOString())
      .nullable(),
  })
  .strict()
  .refine(
    (d) => !d.validFrom || !d.validUntil || d.validFrom < d.validUntil,
    "유효 종료는 시작 이후여야 합니다.",
  );
const identity = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  expectedVersion: z.number().int().min(0),
});

export async function contentCatalog(
  tx: Pick<Tx, "setting">,
): Promise<ContentCatalogEntry[]> {
  const rows = await tx.setting.findMany({
    where: { key: { startsWith: itemPrefix } },
    orderBy: { key: "asc" },
  });
  const items = rows.map((row) => row.value as unknown as ContentItem);
  const revisions = await tx.setting.findMany({
    where: {
      key: {
        in: items.flatMap((item) =>
          item.activeRevision === null
            ? []
            : [revisionKey(item.id, item.activeRevision)],
        ),
      },
    },
  });
  const byKey = new Map(
    revisions.map((row) => [row.key, row.value as unknown as ContentRevision]),
  );
  return items.map((item) => ({
    ...item,
    published:
      item.activeRevision === null
        ? null
        : (byKey.get(revisionKey(item.id, item.activeRevision)) ?? null),
  }));
}

/** Call within the same atomic transaction as command(). */
export async function contentCommand(
  tx: Tx,
  actor: Actor,
  action: string,
  raw: unknown,
) {
  admin(actor);
  ensure(
    ["contentSave", "contentPublish", "contentStop"].includes(action),
    "알 수 없는 콘텐츠 작업입니다.",
  );
  const input =
    action === "contentSave"
      ? identity.extend({ draft: draftSchema }).strict().parse(raw)
      : identity.strict().parse(raw);
  const key = itemPrefix + input.id;
  const previous = await tx.setting.findUnique({ where: { key } });
  const item = previous?.value as unknown as ContentItem | undefined;
  ensure(
    (item?.version ?? 0) === input.expectedVersion,
    "다른 운영자가 변경했습니다. 새로 불러와 확인해 주세요.",
    409,
  );
  ensure(item || action === "contentSave", "콘텐츠를 찾을 수 없습니다.", 404);
  const now = new Date().toISOString();
  let next: ContentItem;
  if (action === "contentSave") {
    ensure("draft" in input, "콘텐츠 초안이 필요합니다.");
    const draft = draftSchema.parse(input.draft);
    if (!item)
      ensure(
        (await tx.setting.count({
          where: { key: { startsWith: itemPrefix } },
        })) < 200,
        "콘텐츠는 최대 200개까지 등록할 수 있습니다.",
      );
    next = {
      id: input.id,
      version: (item?.version ?? 0) + 1,
      draft,
      activeRevision: item?.activeRevision ?? null,
      stoppedThrough: item?.stoppedThrough ?? 0,
      updatedAt: now,
    };
  } else if (action === "contentPublish") {
    const draft = draftSchema.parse(item!.draft);
    ensure(
      !draft.validUntil || draft.validUntil > now,
      "이미 유효기간이 끝난 콘텐츠는 게시할 수 없습니다.",
    );
    const revision = item!.version + 1;
    const published: ContentRevision = {
      ...draft,
      id: item!.id,
      revision,
      publishedAt: now,
    };
    // A publication is append-only. Editing a draft never touches this row.
    await tx.setting.create({
      data: { key: revisionKey(item!.id, revision), value: json(published) },
    });
    next = {
      ...item!,
      version: revision,
      activeRevision: revision,
      updatedAt: now,
    };
  } else {
    next = {
      ...item!,
      version: item!.version + 1,
      activeRevision: null,
      stoppedThrough: item!.version,
      updatedAt: now,
    };
  }
  await tx.setting.upsert({
    where: { key },
    create: { key, value: json(next) },
    update: { value: json(next) },
  });
  await audit(
    tx,
    actor.id,
    action === "contentSave"
      ? "CONTENT_SAVED"
      : action === "contentPublish"
        ? "CONTENT_PUBLISHED"
        : "CONTENT_STOPPED",
    input.id,
    item,
    next,
  );
  return { id: next.id, version: next.version };
}

const inWindow = (card: ContentDraft, at: string) =>
  (!card.validFrom || card.validFrom <= at) &&
  (!card.validUntil || card.validUntil > at);
export function selectContentSnapshot(
  catalog: ContentCatalogEntry[],
  timing: ContentTiming,
  scheduledAt: Date,
  interests: string[],
  traits: string[],
): ContentSnapshot {
  const at = scheduledAt.toISOString();
  const seen = new Set<string>();
  const matches = (card: ContentDraft) =>
    card.tag === "전체" ||
    (card.tag === "깊은 대화"
      ? traits.some((t) => t.includes("깊은"))
      : interests.some((i) => i.includes(card.tag)));
  const cards = catalog
    .flatMap((item) =>
      item.published && item.published.revision > item.stoppedThrough
        ? [item.published]
        : [],
    )
    .filter(
      (card) => card.timing === timing && inWindow(card, at) && matches(card),
    )
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.id.localeCompare(b.id) ||
        a.revision - b.revision,
    )
    .filter((card) => {
      const signature = JSON.stringify([card.title, card.body]);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .slice(0, 3);
  return {
    schemaVersion: 1,
    timing,
    scheduledAt: at,
    cards,
    fallback:
      timing === "START"
        ? pickContent(interests, traits).map(({ title, body }) => ({
            title,
            body,
          }))
        : [],
  };
}

/** Freeze after creating the table's REMINDER/START/END jobs, before committing. */
export async function freezeTableContent(
  tx: Tx,
  tableId: string,
): Promise<void> {
  const table = await tx.diningTable.findUnique({
    where: { id: tableId },
    include: {
      applications: {
        where: { applicationStatus: "SUBMITTED", matchStatus: "CONFIRMED" },
        include: { user: { include: { profile: true } } },
      },
    },
  });
  ensure(table, "테이블을 찾을 수 없습니다.", 404);
  const catalog = await contentCatalog(tx);
  const jobs = await tx.job.findMany({
    where: {
      key: {
        in: [`reminder:${tableId}`, `start:${tableId}`, `end:${tableId}`],
      },
      status: "PENDING",
    },
  });
  for (const job of jobs) {
    const payload = job.payload as Record<string, Prisma.JsonValue>;
    if (payload.contentSnapshot) continue;
    const snapshot = selectContentSnapshot(
      catalog,
      job.kind as ContentTiming,
      job.runAt,
      table.applications.flatMap((a) => a.user.profile?.interests ?? []),
      table.applications.flatMap((a) => a.user.profile?.traits ?? []),
    );
    await tx.job.update({
      where: { id: job.id },
      data: { payload: json({ ...payload, contentSnapshot: snapshot }) },
    });
    await audit(tx, "SYSTEM", "CONTENT_SCHEDULED", job.id, undefined, snapshot);
  }
}

/** Called by the durable worker under atomic(); upsert keys make replay safe. */
export async function sendTableContent(
  tx: Tx,
  job: Pick<Job, "id" | "kind" | "payload">,
): Promise<number> {
  if (!contentTimings.includes(job.kind as ContentTiming)) return 0;
  const payload = job.payload as {
    tableId?: string;
    contentSnapshot?: ContentSnapshot;
  };
  if (!payload.tableId) return 0;
  const table = await tx.diningTable.findUnique({
    where: { id: payload.tableId },
    include: {
      event: true,
      room: true,
      applications: {
        where: { applicationStatus: "SUBMITTED", matchStatus: "CONFIRMED" },
        include: { user: { include: { profile: true } } },
      },
    },
  });
  if (
    !table?.room ||
    table.status !== "CONFIRMED" ||
    table.event.status === "CANCELED"
  )
    return 0;
  const now = new Date();
  if (
    (job.kind === "START" && table.event.endsAt <= now) ||
    (job.kind === "REMINDER" && table.event.startsAt <= now)
  )
    return 0;
  // Pre-feature jobs retain their built-in behavior; new publications apply to
  // newly scheduled jobs only, including after a restart.
  const snapshot =
    payload.contentSnapshot ??
    selectContentSnapshot(
      [],
      job.kind as ContentTiming,
      now,
      table.applications.flatMap((a) => a.user.profile?.interests ?? []),
      table.applications.flatMap((a) => a.user.profile?.traits ?? []),
    );
  ensure(
    snapshot.schemaVersion === 1 && snapshot.timing === job.kind,
    "콘텐츠 예약 정보가 올바르지 않습니다.",
  );
  const cards: { title: string; body: string }[] = [];
  for (const card of snapshot.cards) {
    const row = await tx.setting.findUnique({
      where: { key: itemPrefix + card.id },
    });
    const item = row?.value as unknown as ContentItem | undefined;
    if (
      item &&
      item.stoppedThrough < card.revision &&
      inWindow(card, now.toISOString())
    )
      cards.push(card);
  }
  if (job.kind === "START") {
    for (const fallback of snapshot.fallback) {
      if (cards.length >= 3) break;
      if (
        !cards.some(
          (card) =>
            card.title === fallback.title && card.body === fallback.body,
        )
      )
        cards.push(fallback);
    }
  }
  for (let i = 0; i < cards.length; i++) {
    const key =
      job.kind === "START"
        ? `content:${table.id}:${i}`
        : `content:${table.id}:${job.kind}:${i}`;
    await tx.message.upsert({
      where: { key },
      create: {
        roomId: table.room.id,
        kind: "CONTENT",
        body: `${cards[i].title}\n${cards[i].body}`,
        key,
      },
      update: {},
    });
  }
  return cards.length;
}
