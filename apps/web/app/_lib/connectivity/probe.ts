// P3C-03 — lightweight `/healthz` probe used by the desktop iframe surface's
// 5-second heartbeat (TR-OFFLINE-2). `credentials: "omit"` keeps the session
// cookie off every probe (privacy + a small log-volume win on the BFF). A 2s
// timeout via `AbortController` ensures a hung connection counts as a failed
// heartbeat instead of stalling the polling loop.
//
// Returns `true` on a 2xx response; any non-2xx, network error, abort, or
// timeout returns `false`. The body shape (`{"status":"ok"}` per API §7.9.1)
// is not validated — a 200 response is sufficient evidence the process is up.

const PROBE_TIMEOUT_MS = 2000;

export async function probeHealthz(
  externalSignal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  // If the caller passed their own signal (e.g., the provider's per-mount
  // controller for unmount cleanup), abort our local controller when theirs
  // fires so the fetch is cancelled the moment the provider tears down.
  const externalAbortListener = (): void => controller.abort();
  externalSignal?.addEventListener("abort", externalAbortListener);

  try {
    const response = await fetch("/healthz", {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutHandle);
    externalSignal?.removeEventListener("abort", externalAbortListener);
  }
}

export { PROBE_TIMEOUT_MS };
