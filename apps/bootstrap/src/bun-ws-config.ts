/**
 * Monkey-patches Bun.serve to inject WebSocket tuning knobs (payload/backpressure
 * limits, idleTimeout, sendPings, perMessageDeflate) that @effect/platform-bun's
 * BunHttpServer cannot expose — its hardcoded `websocket` literal at
 * node_modules/@effect/platform-bun/dist/BunHttpServer.js clobbers any
 * user-supplied options.websocket. Effect's open/message/close handlers are
 * preserved here; only non-handler tuning fields are merged.
 *
 * Must be imported BEFORE any @effect/platform-bun import so Bun.serve is
 * patched before Effect calls it.
 *
 * Bun's server.reload() without a `websocket` key does not touch the ws config
 * (src/bun.js/api/server.zig:1053-1063), so the config we set at initial
 * Bun.serve() time persists across Effect's internal server.reload({ fetch })
 * calls.
 */

// Only non-generic tuning fields — excludes data/message/open/close/drain/ping/pong
// which depend on the WebSocketData generic and are supplied by Effect.
type TuningKnobs = Pick<
  Bun.WebSocketHandler<unknown>,
  | "maxPayloadLength"
  | "backpressureLimit"
  | "closeOnBackpressureLimit"
  | "idleTimeout"
  | "sendPings"
  | "perMessageDeflate"
>;

const wsOverrides: TuningKnobs = {
  maxPayloadLength: 512 * 1024 * 1024, // 512 MB: peak single-message UTxO blob
  backpressureLimit: 512 * 1024 * 1024, // 512 MB: give Bun headroom before drops
  closeOnBackpressureLimit: false,
  idleTimeout: 60, // 60s: auto-ping at ~44s idle
  sendPings: true, // RFC 6455 server Ping
  perMessageDeflate: true, // wire-level gzip in addition to app-level
};

const originalServe = Bun.serve;

Bun.serve = function <WebSocketData, R extends string>(
  options: Bun.Serve.Options<WebSocketData, R>,
): Bun.Server<WebSocketData> {
  if ("websocket" in options && options.websocket) {
    return originalServe({
      ...options,
      websocket: { ...options.websocket, ...wsOverrides },
    });
  }
  return originalServe(options);
};
