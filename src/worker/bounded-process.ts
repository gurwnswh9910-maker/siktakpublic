import { spawn } from "node:child_process";

export type ProcessResult = {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
};

// The work lives in a separate process because a timeout Promise cannot stop
// synchronous matching, an open transaction, or further push recipients.
export function runBoundedProcess(
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onMessage?: (message: unknown) => void;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted)
    return Promise.resolve({ exitCode: null, timedOut: false, aborted: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      // Credentials stay in the environment, never command arguments/logs.
      env: { ...process.env, SCHEDULER_SECRET: undefined },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let timedOut = false;
    let aborted = false;
    let error: Error | undefined;
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const abort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("message", (message) => options.onMessage?.(message));
    child.once("error", (e) => {
      error = e;
    });
    // Wait for actual process termination before releasing the scheduler lease.
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ exitCode, timedOut, aborted });
    });
  });
}
