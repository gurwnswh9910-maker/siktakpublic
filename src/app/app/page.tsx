import { auth } from "@/server/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Participant from "@/components/participant";
export default async function Page() {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) redirect("/login");
  return <Participant />;
}
