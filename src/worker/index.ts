import { tick } from "./runner";
import { db } from "@/server/db";
let running = true;
process.on("SIGTERM", () => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});
console.log("Siktak worker ready");
async function main() {
  let heartbeatAt = 0;
  while (running) {
    try {
      if (Date.now() - heartbeatAt > 15000) {
        await db.setting.upsert({
          where: { key: "workerHeartbeat" },
          create: {
            key: "workerHeartbeat",
            value: { mode: "worker", at: new Date().toISOString() },
          },
          update: { value: { mode: "worker", at: new Date().toISOString() } },
        });
        heartbeatAt = Date.now();
      }
      if (await tick()) continue;
    } catch (e) {
      console.error(
        "Worker poll failed:",
        e instanceof Error ? e.message : "unknown",
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await db.$disconnect();
}
void main();
