import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import webpush from "web-push";
let content = readFileSync(
  existsSync(".env") ? ".env" : ".env.example",
  "utf8",
);
const keys = webpush.generateVAPIDKeys();
const defaults = {
  BETTER_AUTH_SECRET: randomBytes(36).toString("base64url"),
  DEMO_PASSWORD: randomBytes(18).toString("base64url"),
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  SCHEDULER_SECRET: randomBytes(32).toString("base64url"),
};
for (const [key, value] of Object.entries(defaults)) {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const match = content.match(pattern);
  if (!match) content += `\n${key}=${value}\n`;
  else if (!match[1] || match[1].startsWith("replace-"))
    content = content.replace(pattern, `${key}=${value}`);
}
writeFileSync(".env", content, { mode: 0o600 });
console.log(
  "Local .env ready. Secrets were preserved or generated; read DEMO_PASSWORD from .env. No secrets were printed.",
);
