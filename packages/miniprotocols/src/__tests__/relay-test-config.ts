/**
 * Relay proxy URL for miniprotocol integration scripts/tests.
 */
import { Config, Effect } from "effect";

const normalizeWsBase = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  return `ws://${trimmed}`;
};

/** WebSocket base URL for websockify (no `/relay` suffix). */
export const RelayWsUrl = Config.string("RELAY_WS_URL").pipe(
  Config.orElse(() => Config.succeed("ws://127.0.0.1:3040")),
  Config.map(normalizeWsBase),
);

/** Resolved at script entry via `Effect.runPromise` / `runSync`. */
export const relayWsUrlSync = (): string => Effect.runSync(RelayWsUrl);
