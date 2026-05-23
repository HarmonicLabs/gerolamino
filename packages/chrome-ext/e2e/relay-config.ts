/**
 * E2E relay proxy URL — defaults to localhost; override for the Hetzner
 * websockify host:
 *
 *   GEROLAMINO_RELAY_URL=ws://87.99.129.190:3040 bunx --bun playwright test --project=integration
 *
 * Build the extension with the same base URL:
 *
 *   BOOTSTRAP_URL=ws://87.99.129.190:3040 bunx --bun wxt build --mode development
 */
import { Config, Effect } from "effect";

const normalizeWsBase = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  return `ws://${trimmed}`;
};

const relayWsUrlConfig = Config.string("GEROLAMINO_RELAY_URL").pipe(
  Config.orElse(() => Config.string("BOOTSTRAP_URL")),
  Config.orElse(() => Config.succeed("ws://localhost:3040")),
  Config.map(normalizeWsBase),
);

/** Playwright host-side relay base URL (resolved once at module load). */
export const RELAY_WS_URL = Effect.runSync(relayWsUrlConfig);

/** HTTP probe for global-setup (`websockify` often returns 404/405 on `/`). */
export const RELAY_HTTP_PROBE = (() => {
  const httpOrigin = RELAY_WS_URL.replace(/^ws/, "http").replace(/^wss/, "https");
  return `${httpOrigin}/`;
})();

export const relaySettingsSeed = (
  mode: "genesis" | "local",
): { mode: typeof mode; serverUrl: string } => ({
  mode,
  serverUrl: RELAY_WS_URL,
});
