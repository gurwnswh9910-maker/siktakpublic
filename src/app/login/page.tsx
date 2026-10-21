import Login from "@/components/login";
export const dynamic = "force-dynamic";
export default function Page() {
  return <Login demo={process.env.DEMO_MODE === "true"} />;
}
