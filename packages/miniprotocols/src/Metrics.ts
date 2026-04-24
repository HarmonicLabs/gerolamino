import { Metric } from "effect";

// Histogram bucket boundaries for latency metrics (milliseconds)
const latencyBoundaries = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ── Message counters (per protocol, per direction) ──

export const messagesSent = Metric.counter("ouroboros.messages.sent", {
  incremental: true,
});

export const messagesReceived = Metric.counter("ouroboros.messages.received", {
  incremental: true,
});

// ── Latency histograms ──

export const handshakeLatency = Metric.histogram("ouroboros.handshake.latency_ms", {
  boundaries: latencyBoundaries,
});

export const blockFetchLatency = Metric.histogram("ouroboros.block_fetch.latency_ms", {
  boundaries: latencyBoundaries,
});

export const keepAliveRtt = Metric.histogram("ouroboros.keepalive.rtt_ms", {
  boundaries: latencyBoundaries,
});

// ── Gauges ──

export const activeProtocols = Metric.gauge("ouroboros.protocols.active");

// ── Protocol-violation counters ──

/**
 * Bumped when a peer replies to `MsgKeepAlive` with the wrong cookie.
 * Upstream uses the spelling `KeepAliveCookieMissmatch` (typo intentional,
 * see `ouroboros-network/.../KeepAlive/Type.hs:42-45`); preserve the
 * typo here so operator dashboards correlate with upstream telemetry
 * (wave-2 research correction #27).
 */
export const keepAliveCookieMissmatch = Metric.counter(
  "ouroboros.keepalive.cookie_missmatch",
  { incremental: true },
);

/**
 * Bumped when a peer returns more entries in `MsgSharePeers` than we
 * requested via `MsgShareRequest { amount }`. Upstream codec doesn't
 * enforce the cap at the wire layer (`PeerSharing/Type.hs:77-87`), so
 * we treat oversized responses as a protocol violation and disconnect
 * the peer (wave-2 research correction #28 — not silent truncate).
 */
export const oversizedPeerSharingResponse = Metric.counter(
  "ouroboros.peer_sharing.oversized",
  { incremental: true },
);

/**
 * Bumped when a reactivated peer entity's persisted ChainSync cursor is
 * rejected by the remote with `MsgIntersectNotFound` — the peer forked
 * away from our recorded cursor and we had to reset to genesis (with
 * Fibonacci-spaced fallback points per wave-2 correction #12).
 */
export const peerCursorStaleOnReconnect = Metric.counter(
  "ouroboros.peer.cursor_stale_on_reconnect",
  { incremental: true },
);

/** Per-peer message throughput (in). */
export const peerMessagesIn = Metric.counter("ouroboros.peer.messages.in", {
  incremental: true,
});

/** Per-peer message throughput (out). */
export const peerMessagesOut = Metric.counter("ouroboros.peer.messages.out", {
  incremental: true,
});

/** Active peer entity count — bumped on `ConnectToPeer`, decremented on `Disconnect`. */
export const peerCount = Metric.gauge("ouroboros.peer.count");
