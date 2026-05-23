/**
 * Playwright global setup — probes optional E2E infrastructure before workers
 * spawn. Sets `process.env.GEROLAMINO_RELAY_E2E` so integration specs can skip
 * cleanly instead of timing out against a dead relay.
 *
 * Playwright runs this once in the parent process; worker processes inherit the
 * env var (see `packages/playwright/src/runner/tasks.ts` globalSetup hook).
 */
import { RELAY_HTTP_PROBE } from "./relay-config.ts";

const probeRelay = async (): Promise<boolean> => {
  try {
    const http = await fetch(RELAY_HTTP_PROBE, { signal: AbortSignal.timeout(5_000) });
    // Any TCP listener counts — proxies often return 404/405/426 on `/`.
    return http.status < 500;
  } catch {
    return false;
  }
};

export default async function globalSetup(): Promise<void> {
  const relayUp = await probeRelay();
  process.env.GEROLAMINO_RELAY_E2E = relayUp ? "1" : "0";
  // eslint-disable-next-line no-console
  console.log(
    `[e2e global-setup] relay ${relayUp ? "available" : "unavailable"} (${RELAY_HTTP_PROBE})`,
  );
}
