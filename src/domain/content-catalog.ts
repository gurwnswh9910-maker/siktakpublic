export const contentTimings = ["START", "REMINDER", "END"] as const;
export const contentKinds = ["QUESTION", "ACTIVITY", "GUIDE"] as const;
export const contentTags = [
  "전체",
  "여행",
  "음식",
  "운동",
  "문화",
  "일상",
  "깊은 대화",
] as const;
export type ContentTiming = (typeof contentTimings)[number];
export type ContentDraft = {
  title: string;
  body: string;
  kind: (typeof contentKinds)[number];
  timing: ContentTiming;
  tag: (typeof contentTags)[number];
  priority: number;
  validFrom: string | null;
  validUntil: string | null;
};
export type ContentItem = {
  id: string;
  version: number;
  draft: ContentDraft;
  activeRevision: number | null;
  stoppedThrough: number;
  updatedAt: string;
};
export type ContentRevision = ContentDraft & {
  id: string;
  revision: number;
  publishedAt: string;
};
export type ContentCatalogEntry = ContentItem & {
  published: ContentRevision | null;
};
export type ContentSnapshot = {
  schemaVersion: 1;
  timing: ContentTiming;
  scheduledAt: string;
  cards: ContentRevision[];
  fallback: { title: string; body: string }[];
};
