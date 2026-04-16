/**
 * SW-side client for the offscreen decode worker.
 *
 * Responsibilities:
 *   1. Ensure exactly one offscreen document is alive (created lazily via
 *      `chrome.offscreen.createDocument` — which waits until the document's
 *      top-level script has executed, so the listener is guaranteed ready
 *      before we post any request).
 *   2. Exchange decode messages over a `BroadcastChannel` — structured clone
 *      supports `Uint8Array` / `bigint` / `Map` natively, so we avoid the
 *      JSON-only `chrome.runtime.sendMessage` path.
 *   3. Rehydrate the flat wire records back into `LedgerView` (with `HashMap`
 *      values) and `Nonces` (with `Schema.TaggedClass` methods) so the rest
 *      of the consensus pipeline can consume them unchanged.
 *   4. Forward incremental progress messages into `SyncStateRef.update`, so
 *      the popup dashboard animates during the 2-3s decode / account-write
 *      window instead of blocking on a single transition.
 */
import { Deferred, Effect, HashMap } from "effect";
import type { LedgerView } from "consensus";
import { Nonces } from "consensus";
import { SyncStateRef } from "./sync-state.ts";
import type {
  OffscreenComplete,
  OffscreenRequest,
  OffscreenResponse,
  SerializedLedgerView,
  SerializedNonces,
} from "./offscreen-protocol.ts";
import { OFFSCREEN_CHANNEL } from "./offscreen-protocol.ts";

/** WXT builds `entrypoints/offscreen/index.html` as `/offscreen.html`. */
const OFFSCREEN_URL = "offscreen.html";

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

/** Create the offscreen document if it does not already exist. Idempotent. */
const ensureOffscreen = Effect.gen(function* () {
  const exists = yield* Effect.promise(() => globalThis.chrome.offscreen.hasDocument());
  if (exists) {
    yield* Effect.log("[offscreen-client] Offscreen document already present");
    return;
  }
  yield* Effect.log("[offscreen-client] Creating offscreen document");
  yield* Effect.promise(() =>
    globalThis.chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [globalThis.chrome.offscreen.Reason.WORKERS],
      justification: "Decode Mithril snapshot off the service worker thread",
    }),
  );
  yield* Effect.log("[offscreen-client] Offscreen document ready");
});

// ---------------------------------------------------------------------------
// Rehydration
// ---------------------------------------------------------------------------

const rehydrateLedgerView = (lv: SerializedLedgerView): LedgerView => ({
  epochNonce: lv.epochNonce,
  poolVrfKeys: HashMap.fromIterable(lv.poolVrfKeys),
  poolStake: HashMap.fromIterable(lv.poolStake),
  totalStake: lv.totalStake,
  activeSlotsCoeff: lv.activeSlotsCoeff,
  maxKesEvolutions: lv.maxKesEvolutions,
  maxHeaderSize: lv.maxHeaderSize,
  maxBlockBodySize: lv.maxBlockBodySize,
  ocertCounters: HashMap.fromIterable(lv.ocertCounters),
});

const rehydrateNonces = (n: SerializedNonces): Nonces =>
  new Nonces({
    active: n.active,
    evolving: n.evolving,
    candidate: n.candidate,
    epoch: n.epoch,
  });

// ---------------------------------------------------------------------------
// Public: decodeLedgerStateOffscreen
// ---------------------------------------------------------------------------

export type DecodeResult = {
  readonly ledgerView: LedgerView;
  readonly nonces: Nonces;
  readonly tip: { readonly slot: bigint; readonly blockNo: bigint; readonly hash: Uint8Array } | undefined;
  readonly accountsWritten: number;
  readonly stakeEntriesWritten: number;
};

/** One-shot request ID — every decode request gets a unique tag so we can
 * reject stale / concurrent responses. */
const makeRequestId = Effect.sync(
  () => `decode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
);

/**
 * Delegate a single `LedgerState` CBOR payload to the offscreen document.
 *
 * While the offscreen is decoding + writing accounts + writing stake, it
 * pushes `decode-progress` messages; we forward them into `SyncStateRef` so
 * the popup UI shows real-time progress bars. On completion, we rehydrate
 * the LedgerView / Nonces and return them for Phase 2 consumption.
 */
export const decodeLedgerStateOffscreen = (
  payload: Uint8Array,
): Effect.Effect<DecodeResult, string, SyncStateRef> =>
  Effect.gen(function* () {
    yield* ensureOffscreen;
    const syncState = yield* SyncStateRef;
    const requestId = yield* makeRequestId;
    const channel = new BroadcastChannel(OFFSCREEN_CHANNEL);
    const done = yield* Deferred.make<OffscreenComplete, string>();

    const onMessage = (event: MessageEvent) => {
      const msg = event.data as OffscreenResponse | undefined;
      if (!msg || typeof msg !== "object") return;
      if (msg.tag === "ready") return;
      if (!("requestId" in msg) || msg.requestId !== requestId) return;
      if (msg.tag === "decode-progress") {
        Effect.runFork(
          syncState.update({
            bootstrapPhase: msg.phase,
            accountsWritten: msg.accountsWritten,
            stakeEntriesWritten: msg.stakeEntriesWritten,
            ...(msg.totalAccounts !== undefined ? { totalAccounts: msg.totalAccounts } : {}),
            ...(msg.totalStakeEntries !== undefined
              ? { totalStakeEntries: msg.totalStakeEntries }
              : {}),
          }),
        );
      } else if (msg.tag === "decode-complete") {
        Effect.runFork(Deferred.succeed(done, msg));
      } else if (msg.tag === "decode-error") {
        Effect.runFork(Deferred.fail(done, msg.message));
      }
    };
    channel.addEventListener("message", onMessage);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        channel.removeEventListener("message", onMessage);
        channel.close();
      }),
    );

    const request: OffscreenRequest = { tag: "decode-ledger-state", requestId, payload };
    yield* Effect.sync(() => channel.postMessage(request));
    yield* Effect.log(`[offscreen-client] Dispatched decode request (${requestId})`);

    const complete = yield* Deferred.await(done);
    return {
      ledgerView: rehydrateLedgerView(complete.ledgerView),
      nonces: rehydrateNonces(complete.nonces),
      tip: complete.tip,
      accountsWritten: complete.accountsWritten,
      stakeEntriesWritten: complete.stakeEntriesWritten,
    };
  }).pipe(Effect.scoped);
