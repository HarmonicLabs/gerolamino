/**
 * Cross-context protocol between the MV3 background service worker and the
 * offscreen document that performs Mithril snapshot decoding.
 *
 * Rationale:
 *   - Chrome MV3 service workers cannot spawn Web Workers directly.
 *   - Synchronous CBOR decoding of a ~30MB ExtLedgerState blob blocks the SW
 *     main thread for ~2-3s, during which chrome.storage.session.set calls
 *     cannot flush, so the popup UI freezes.
 *   - The offscreen document runs in a separate OS process, so any CPU work
 *     performed there leaves the SW thread free to serve RPC / storage events.
 *
 * Wire format:
 *   - Transport is a BroadcastChannel (structured clone, same-origin).
 *   - All messages are plain records whose fields are structured-clone safe:
 *     Uint8Array, bigint, string, number, plain arrays / objects.
 *   - Class instances (HashMap, Nonces, etc.) are serialized to plain records
 *     and rehydrated on the receiving side.
 *   - Each request/response carries a `requestId` so concurrent decodes are
 *     trivially disambiguated (we only issue one at a time today, but this
 *     keeps the protocol future-proof).
 */
import { Schema } from "effect";
import { BootstrapPhase } from "./rpc.ts";

export const OFFSCREEN_CHANNEL = "gerolamino/offscreen";

// ---------------------------------------------------------------------------
// SW → Offscreen
// ---------------------------------------------------------------------------

export const OffscreenRequest = Schema.Struct({
  tag: Schema.Literal("decode-ledger-state"),
  requestId: Schema.String,
  payload: Schema.Uint8Array,
});
export type OffscreenRequest = typeof OffscreenRequest.Type;

// ---------------------------------------------------------------------------
// Offscreen → SW
// ---------------------------------------------------------------------------

/** Flat projection of consensus `LedgerView` — HashMap values expanded to
 * arrays of entries so the payload is structured-clone compatible. */
export const SerializedLedgerView = Schema.Struct({
  epochNonce: Schema.Uint8Array,
  poolVrfKeys: Schema.Array(Schema.Tuple([Schema.String, Schema.Uint8Array])),
  poolStake: Schema.Array(Schema.Tuple([Schema.String, Schema.BigInt])),
  totalStake: Schema.BigInt,
  activeSlotsCoeff: Schema.Number,
  maxKesEvolutions: Schema.Number,
  maxHeaderSize: Schema.Number,
  maxBlockBodySize: Schema.Number,
  ocertCounters: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
});
export type SerializedLedgerView = typeof SerializedLedgerView.Type;

/** Plain record mirror of the `Nonces` TaggedClass. */
export const SerializedNonces = Schema.Struct({
  active: Schema.Uint8Array,
  evolving: Schema.Uint8Array,
  candidate: Schema.Uint8Array,
  epoch: Schema.BigInt,
});
export type SerializedNonces = typeof SerializedNonces.Type;

export const SerializedTip = Schema.UndefinedOr(
  Schema.Struct({
    slot: Schema.BigInt,
    blockNo: Schema.BigInt,
    hash: Schema.Uint8Array,
  }),
);
export type SerializedTip = typeof SerializedTip.Type;

export const OffscreenProgress = Schema.Struct({
  tag: Schema.Literal("decode-progress"),
  requestId: Schema.String,
  phase: BootstrapPhase,
  accountsWritten: Schema.Number,
  totalAccounts: Schema.optional(Schema.Number),
  stakeEntriesWritten: Schema.Number,
  totalStakeEntries: Schema.optional(Schema.Number),
});
export type OffscreenProgress = typeof OffscreenProgress.Type;

export const OffscreenComplete = Schema.Struct({
  tag: Schema.Literal("decode-complete"),
  requestId: Schema.String,
  ledgerView: SerializedLedgerView,
  nonces: SerializedNonces,
  tip: SerializedTip,
  accountsWritten: Schema.Number,
  stakeEntriesWritten: Schema.Number,
});
export type OffscreenComplete = typeof OffscreenComplete.Type;

export const OffscreenError = Schema.Struct({
  tag: Schema.Literal("decode-error"),
  requestId: Schema.String,
  message: Schema.String,
});
export type OffscreenError = typeof OffscreenError.Type;

export const OffscreenReady = Schema.Struct({
  tag: Schema.Literal("ready"),
});
export type OffscreenReady = typeof OffscreenReady.Type;

export const OffscreenResponse = Schema.Union([
  OffscreenReady,
  OffscreenProgress,
  OffscreenComplete,
  OffscreenError,
]);
export type OffscreenResponse = typeof OffscreenResponse.Type;
