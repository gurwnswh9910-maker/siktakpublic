type Heartbeat = {
  at?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  processed?: number;
  succeeded?: number;
  retrying?: number;
  failed?: number;
  interrupted?: number;
};
type DispatchHeartbeat = {
  at?: string;
  hasDueJobs?: boolean;
  oldestDueAt?: string | null;
};
type AutomationState =
  | "IDLE"
  | "WAITING"
  | "RUNNING"
  | "READY"
  | "DELAYED"
  | "ATTENTION"
  | "OFFLINE";

export function automationStatus(
  settings: { key: string; value: unknown }[],
  mode = process.env.AUTOMATION_MODE === "scheduler" ? "scheduler" : "worker",
  now = Date.now(),
) {
  const heartbeat = settings.find(
    (s) =>
      s.key ===
      (mode === "scheduler" ? "schedulerHeartbeat" : "workerHeartbeat"),
  )?.value as Heartbeat | undefined;
  const age = heartbeat?.at ? now - new Date(heartbeat.at).getTime() : Infinity;
  const recent = age >= 0 && age < (mode === "scheduler" ? 180000 : 45000);
  const status = heartbeat?.status ?? null;
  let online =
    recent &&
    status !== "FAILED" &&
    status !== "INTERRUPTED" &&
    status !== "DEADLINE";
  let state: AutomationState = online
    ? status === "RUNNING"
      ? "RUNNING"
      : "READY"
    : "OFFLINE";
  const dispatchSetting =
    mode === "scheduler"
      ? settings.find((s) => s.key === "schedulerDispatchHeartbeat")
      : undefined;
  const dispatch = dispatchSetting?.value as DispatchHeartbeat | undefined;
  if (dispatchSetting) {
    const dispatchAge = dispatch?.at
      ? now - new Date(dispatch.at).getTime()
      : Infinity;
    const dueAge = dispatch?.oldestDueAt
      ? now - new Date(dispatch.oldestDueAt).getTime()
      : NaN;
    if (
      !(dispatchAge >= 0 && dispatchAge < 7 * 60000) ||
      typeof dispatch?.hasDueJobs !== "boolean" ||
      (dispatch.hasDueJobs && !(dueAge >= 0))
    ) {
      state = "OFFLINE";
    } else if (
      ["FAILED", "INTERRUPTED", "DEADLINE"].includes(status ?? "") ||
      (heartbeat?.failed ?? 0) > 0 ||
      (heartbeat?.interrupted ?? 0) > 0 ||
      (status === "RUNNING" && !recent)
    ) {
      state = "ATTENTION";
    } else if (dispatch.hasDueJobs && dueAge >= 180000) {
      state = "DELAYED";
    } else if (status === "RUNNING" && recent) {
      state = "RUNNING";
    } else {
      state = dispatch.hasDueJobs ? "WAITING" : "IDLE";
    }
    online = ["IDLE", "WAITING", "RUNNING"].includes(state);
  }
  return {
    mode,
    online,
    status,
    state,
    lastDispatchCheckAt: dispatch?.at ?? null,
    hasDueJobs: dispatch?.hasDueJobs ?? null,
    oldestDueAt: dispatch?.oldestDueAt ?? null,
    lastRunAt: heartbeat?.startedAt ?? heartbeat?.at ?? null,
    lastFinishedAt: heartbeat?.finishedAt ?? null,
    processed: heartbeat?.processed ?? 0,
    succeeded: heartbeat?.succeeded ?? 0,
    retrying: heartbeat?.retrying ?? 0,
    failed: heartbeat?.failed ?? 0,
    interrupted: heartbeat?.interrupted ?? 0,
  };
}
