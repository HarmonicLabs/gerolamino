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
import type { BootstrapPhase } from "./rpc.ts";

export const OFFSCREEN_CHANNEL = "gerolamino/offscreen";

// ---------------------------------------------------------------------------
// SW → Offscreen
// ---------------------------------------------------------------------------

export type OffscreenRequest = {
  readonly tag: "decode-ledger-state";
  readonly requestId: string;
  readonly payload: Uint8Array;
};

// ---------------------------------------------------------------------------
// Offscreen → SW
// ---------------------------------------------------------------------------

/** Flat projection of consensus `LedgerView` — HashMap values expanded to
 * arrays of entries so the payload is structured-clone compatible. */
export type SerializedLedgerView = {
  readonly epochNonce: Uint8Array;
  readonly poolVrfKeys: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly poolStake: ReadonlyArray<readonly [string, bigint]>;
  readonly totalStake: bigint;
  readonly activeSlotsCoeff: number;
  readonly maxKesEvolutions: number;
};

/** Plain record mirror of the `Nonces` TaggedClass. */
export type SerializedNonces = {
  readonly active: Uint8Array;
  readonly evolving: Uint8Array;
  readonly candidate: Uint8Array;
  readonly epoch: bigint;
};

export type SerializedTip =
  | { readonly slot: bigint; readonly hash: Uint8Array }
  | undefined;

export type OffscreenProgress = {
  readonly tag: "decode-progress";
  readonly requestId: string;
  readonly phase: BootstrapPhase;
  readonly accountsWritten: number;
  readonly totalAccounts?: number;
  readonly stakeEntriesWritten: number;
  readonly totalStakeEntries?: number;
};

export type OffscreenComplete = {
  readonly tag: "decode-complete";
  readonly requestId: string;
  readonly ledgerView: SerializedLedgerView;
  readonly nonces: SerializedNonces;
  readonly tip: SerializedTip;
  readonly accountsWritten: number;
  readonly stakeEntriesWritten: number;
};

export type OffscreenError = {
  readonly tag: "decode-error";
  readonly requestId: string;
  readonly message: string;
};

export type OffscreenReady = { readonly tag: "ready" };

export type OffscreenResponse =
  | OffscreenReady
  | OffscreenProgress
  | OffscreenComplete
  | OffscreenError;
