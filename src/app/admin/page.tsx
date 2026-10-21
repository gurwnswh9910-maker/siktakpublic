import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Admin from "@/components/admin";
export default async function Page() {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) redirect("/login");
  const u = await db.user.findUnique({ where: { id: s.user.id } });
  if (!u || !["ADMIN", "OPERATIONS", "SAFETY"].includes(u.role))
    redirect("/app");
  return <Admin />;
}
