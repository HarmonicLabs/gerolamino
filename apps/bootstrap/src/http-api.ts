/**
 * HttpApi definition for apps/bootstrap.
 *
 * Replaces the hand-crafted `openapi.ts` and the raw-HttpRouter JSON endpoint
 * in `server.ts`. Auto-generates OpenAPI at `/openapi.json` via
 * `HttpApiBuilder.layer(..., { openapiPath })` + serves a Swagger UI at
 * `/docs` via `HttpApiSwagger.layer`.
 *
 * WebSocket endpoints (`/bootstrap`, `/relay`) stay outside HttpApi — they
 * upgrade to raw sockets via `HttpServerRequest.upgrade`, which HttpApi's
 * schema-first request/response model doesn't cover. Those routes are
 * composed into the same `HttpRouter` via `HttpRouter.use` in `server.ts`.
 *
 * Per-endpoint handlers receive `SnapshotMeta` + `PreloadedLedger` captured
 * in the `InfoGroupLive` closure — avoids a separate Context.Service just
 * for bootstrap metadata.
 */
import { Effect, Layer, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type { SnapshotMeta } from "./loader.ts";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/** `/info` — snapshot metadata served to browser clients on first-connect. */
export const InfoResponse = Schema.Struct({
  protocolMagic: Schema.Number,
  /** BigInt serialised as string — avoids `Schema.BigInt` JSON ambiguity. */
  snapshotSlot: Schema.String,
  totalChunks: Schema.Number,
});
export type InfoResponseT = typeof InfoResponse.Type;

/** `/snapshots` — list of available Mithril snapshots on disk. */
export const SnapshotMetaResponse = Schema.Struct({
  slot: Schema.String,
  chunks: Schema.Number,
});

/** `/sync-status` — current bootstrap server state. */
export const SyncStatusResponse = Schema.Struct({
  /** True when serving a snapshot at tip (no further fetches in flight). */
  synced: Schema.Boolean,
  tipSlot: Schema.String,
  tipHashHex: Schema.String,
});

/**
 * `/peers` — upstream peers the relay proxy is connected to.
 *
 * Status literals MUST match `consensus/src/rpc/node-rpc-group.ts` →
 * `PeerInfoStatus` (the wire-canonical shape derived from `PeerStatus`
 * in `consensus/peer/manager.ts`). Any drift silently creates a schema
 * mismatch at the HTTP boundary for clients consuming both endpoints.
 */
export const PeerInfo = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  status: Schema.Literals(["connecting", "syncing", "synced", "stalled", "disconnected"]),
  tipSlot: Schema.optional(Schema.String),
  latencyMs: Schema.optionalKey(Schema.Number),
});

/** `/mempool` — in-memory view of pending transactions (stub until Phase 3e). */
export const TxSummary = Schema.Struct({
  hashHex: Schema.String,
  sizeBytes: Schema.Number,
  feePerByte: Schema.Number,
});

// ---------------------------------------------------------------------------
// HttpApi definition
// ---------------------------------------------------------------------------

/**
 * REST API exposed by apps/bootstrap. Five read-only GET endpoints plus
 * auto-generated `/openapi.json` (wired via `HttpApiBuilder.layer(Api,
 * { openapiPath })` in `server.ts`).
 */
export const BootstrapApi = HttpApi.make("bootstrap").add(
  HttpApiGroup.make("info")
    .add(HttpApiEndpoint.get("root", "/info", { success: InfoResponse }))
    .add(
      HttpApiEndpoint.get("snapshots", "/snapshots", {
        success: Schema.Array(SnapshotMetaResponse),
      }),
    )
    .add(HttpApiEndpoint.get("syncStatus", "/sync-status", { success: SyncStatusResponse }))
    .add(HttpApiEndpoint.get("peers", "/peers", { success: Schema.Array(PeerInfo) }))
    .add(HttpApiEndpoint.get("mempool", "/mempool", { success: Schema.Array(TxSummary) })),
);

// ---------------------------------------------------------------------------
// Handlers — bound to the loaded snapshot's SnapshotMeta
// ---------------------------------------------------------------------------

/**
 * Build a Layer implementing the `info` group. `meta` is captured at
 * startup; dynamic endpoints (`sync-status`, `peers`, `mempool`) return
 * placeholder data until the respective services land.
 */
export const infoGroupLayer = (
  meta: SnapshotMeta,
): Layer.Layer<HttpApiGroup.ApiGroup<"bootstrap", "info">> =>
  HttpApiBuilder.group(BootstrapApi, "info", (handlers) =>
    handlers
      .handle("root", () =>
        Effect.succeed({
          protocolMagic: meta.protocolMagic,
          snapshotSlot: meta.snapshotSlot.toString(),
          totalChunks: meta.totalChunks,
        }),
      )
      .handle("snapshots", () =>
        // Single-snapshot deployment today. When Phase 0f-iii's fixture
        // manager lands, enumerate the cache.
        Effect.succeed([{ slot: meta.snapshotSlot.toString(), chunks: meta.totalChunks }]),
      )
      .handle("syncStatus", () =>
        Effect.succeed({
          synced: true,
          tipSlot: meta.snapshotSlot.toString(),
          // Placeholder: real tip-hash extraction from LedgerState arrives
          // with Phase 3d storage wiring.
          tipHashHex: "",
        }),
      )
      // Placeholder responses for endpoints whose backing services are
      // Phase 2e (peers) + Phase 3e (mempool) — return well-typed empty
      // arrays so the OpenAPI contract is correct from day one.
      .handle("peers", () => Effect.succeed([]))
      .handle("mempool", () => Effect.succeed([])),
  );
