import { describe, expect, it } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import {
  buildPushPayload,
  MAX_PUSH_PAYLOAD_BYTES,
} from "@/server/push-payload";

const notification = {
  id: "notification-123",
  title: "다음 만남을 선택해 주세요",
  href: "/app?tab=detail&application=application-123",
  body: "선택한 모임의 상세 안내입니다.",
};

describe("Web Push payload size", () => {
  it("keeps a fitting message and the exact byte-limit boundary unchanged", () => {
    expect(JSON.parse(buildPushPayload(notification))).toEqual({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      url: notification.href,
    });
    const overhead = Buffer.byteLength(
      buildPushPayload({ ...notification, body: "" }),
      "utf8",
    );
    const body = "a".repeat(MAX_PUSH_PAYLOAD_BYTES - overhead);
    const serialized = buildPushPayload({ ...notification, body });
    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_PUSH_PAYLOAD_BYTES);
    expect(JSON.parse(serialized).body).toBe(body);
  });

  it("bounds long Korean templates and alternative titles without mutating the saved content", () => {
    const source = {
      ...notification,
      body: `${"안".repeat(1000)}\n${Array.from({ length: 3 }, () => `${"제".repeat(1000)} · 홍대 · 금요일 오후 7:30`).join("\n")}`,
    };
    const original = { ...source };
    expect(Buffer.byteLength(JSON.stringify(source), "utf8")).toBeGreaterThan(
      4096,
    );
    const serialized = buildPushPayload(source);
    const result = JSON.parse(serialized);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_PUSH_PAYLOAD_BYTES,
    );
    expect(result).toMatchObject({
      id: source.id,
      title: source.title,
      url: source.href,
    });
    expect(result.body).toMatch(/…$/u);
    expect(source.body.startsWith(result.body.slice(0, -1))).toBe(true);
    expect(source).toEqual(original);
  });

  it("does not cut emoji families, flags, or combining characters in the middle", () => {
    const group = "👨‍👩‍👧‍👦🇰🇷e\u0301한";
    const serialized = buildPushPayload({
      ...notification,
      body: group.repeat(150),
    });
    const { body } = JSON.parse(serialized);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_PUSH_PAYLOAD_BYTES,
    );
    expect(body).toMatch(/^(?:👨‍👩‍👧‍👦|🇰🇷|e\u0301|한)+…$/u);
    expect(body).not.toContain("\uFFFD");
  });

  it("includes JSON escaping and long encoded destinations in the total budget", () => {
    const source = {
      ...notification,
      href: `/app?tab=detail&application=${encodeURIComponent("한".repeat(150))}`,
      body: '"\\\n\t\u0000'.repeat(1000),
    };
    const serialized = buildPushPayload(source);
    const result = JSON.parse(serialized);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_PUSH_PAYLOAD_BYTES,
    );
    expect(result.url).toBe(source.href);
    expect(result.body.endsWith("…")).toBe(true);
    expect(source.body.startsWith(result.body.slice(0, -1))).toBe(true);
  });

  it("keeps the real encrypted Web Push request below 4096 bytes", () => {
    const key = createECDH("prime256v1");
    key.generateKeys();
    const subscription = {
      endpoint: "https://fcm.googleapis.com/synthetic-payload-test",
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    };
    const options = {
      TTL: 86400,
      timeout: 10000,
      vapidDetails: {
        subject: "mailto:demo@example.com",
        ...webpush.generateVAPIDKeys(),
      },
    };
    const source = {
      ...notification,
      body: `${"안".repeat(1000)}${`\n${"제".repeat(100)} · 서울 홍대 · 금요일 오후 7시 30분`.repeat(3)}`,
    };
    const oversized = webpush.generateRequestDetails(
      subscription,
      JSON.stringify(source),
      options,
    );
    expect(oversized.body.byteLength).toBeGreaterThan(4096);
    // Encryption and request construction only; no request is sent.
    const request = webpush.generateRequestDetails(
      subscription,
      buildPushPayload(source),
      options,
    );
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(request.body.byteLength).toBeLessThanOrEqual(4096);
  });

  it("rejects an impossible metadata envelope while preserving its identity fields", () => {
    expect(() =>
      buildPushPayload({ ...notification, title: "한".repeat(2000) }),
    ).toThrow("metadata exceeds the payload budget");
  });
});
