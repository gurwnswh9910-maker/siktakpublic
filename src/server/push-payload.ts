import { Buffer } from "node:buffer";

// Leave room for Web Push encryption overhead below the 4096-byte service limit.
export const MAX_PUSH_PAYLOAD_BYTES = 3000;

type PushContent = {
  id: string;
  title: string;
  body: string;
  href: string;
};

export function buildPushPayload(notification: PushContent): string {
  const serialize = (body: string) =>
    JSON.stringify({
      id: notification.id,
      title: notification.title,
      body,
      url: notification.href,
    });
  const full = serialize(notification.body);
  if (Buffer.byteLength(full, "utf8") <= MAX_PUSH_PAYLOAD_BYTES) return full;

  const suffix = "…";
  let remaining =
    MAX_PUSH_PAYLOAD_BYTES - Buffer.byteLength(serialize(suffix), "utf8");
  // Titles and destinations are system-generated and fit comfortably today.
  // Reject an impossible envelope instead of sending an oversized payload or
  // changing its notification identity, title, or navigation destination.
  if (remaining < 0)
    throw new Error("Push notification metadata exceeds the payload budget");

  let preview = "";
  const segments = new Intl.Segmenter("ko", { granularity: "grapheme" });
  for (const { segment } of segments.segment(notification.body)) {
    // Count JSON escaping too: a newline is two bytes and a quote is escaped.
    const bytes = Buffer.byteLength(JSON.stringify(segment), "utf8") - 2;
    if (bytes > remaining) break;
    preview += segment;
    remaining -= bytes;
  }
  return serialize(preview + suffix);
}
