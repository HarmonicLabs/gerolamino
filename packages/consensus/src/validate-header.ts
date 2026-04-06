/**
 * Header validation — five Ouroboros Praos assertions.
 *
 * All five can run in parallel (no dependencies between them):
 *   1. AssertKnownLeaderVrf — VRF key matches registered pool
 *   2. AssertVrfProof — VRF proof valid, output matches
 *   3. AssertLeaderStake — check_vrf_leader passes (stake threshold)
 *   4. AssertKesSignature — KES Sum6 verify, period in bounds
 *   5. AssertOperationalCertificate — opcert sequence valid, cold key verify
 *
 * Worker pool architecture: CPU-bound crypto runs in parallel Workers.
 *   - TUI: BunWorker (OS threads via worker_threads)
 *   - Chrome: BrowserWorker (Web Workers from service worker)
 */
import { Effect, Schema } from "effect";

export class HeaderValidationError extends Schema.TaggedErrorClass<HeaderValidationError>()(
  "HeaderValidationError",
  {
    assertion: Schema.String,
    cause: Schema.Defect,
  },
) {}

export interface BlockHeader {
  readonly slot: bigint;
  readonly blockNo: bigint;
  readonly hash: Uint8Array;
  readonly prevHash: Uint8Array;
  readonly issuerVk: Uint8Array;
  readonly vrfVk: Uint8Array;
  readonly vrfProof: Uint8Array;
  readonly vrfOutput: Uint8Array;
  readonly kesSig: Uint8Array;
  readonly kesPeriod: number;
  readonly opcertSig: Uint8Array;
  readonly opcertSeqNo: number;
  readonly opcertKesPeriod: number;
  readonly protocolVersion: { major: number; minor: number };
  readonly bodySize: number;
  readonly bodyHash: Uint8Array;
}

export interface LedgerView {
  readonly epochNonce: Uint8Array;
  readonly poolVrfKeys: ReadonlyMap<string, Uint8Array>;
  readonly poolStake: ReadonlyMap<string, bigint>;
  readonly totalStake: bigint;
  readonly activeSlotsCoeff: number;
  readonly maxKesEvolutions: number;
}

/**
 * Validate a block header against the ledger view.
 * All five assertions run via Effect.all (parallel).
 */
export const validateHeader = (
  header: BlockHeader,
  ledgerView: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.gen(function* () {
    yield* Effect.all([
      assertKnownLeaderVrf(header, ledgerView),
      assertVrfProof(header, ledgerView),
      assertLeaderStake(header, ledgerView),
      assertKesSignature(header, ledgerView),
      assertOperationalCertificate(header),
    ]);
  });

// TODO: implement each assertion using wasm-utils crypto primitives

const assertKnownLeaderVrf = (
  _header: BlockHeader,
  _view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.void; // placeholder

const assertVrfProof = (
  _header: BlockHeader,
  _view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.void;

const assertLeaderStake = (
  _header: BlockHeader,
  _view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.void;

const assertKesSignature = (
  _header: BlockHeader,
  _view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.void;

const assertOperationalCertificate = (
  _header: BlockHeader,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.void;
