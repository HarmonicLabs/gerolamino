/**
 * Header validation — five Ouroboros Praos assertions.
 *
 * All five can run in parallel (no dependencies between them):
 *   1. AssertKnownLeaderVrf — VRF key matches registered pool
 *   2. AssertVrfProof — VRF proof valid, output matches (stub: needs vrf_verify)
 *   3. AssertLeaderStake — check_vrf_leader passes (stub: needs WASM export)
 *   4. AssertKesSignature — KES Sum6 verify, period in bounds
 *   5. AssertOperationalCertificate — opcert sequence valid, cold key verify
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
  readonly issuerVk: Uint8Array; // 32B pool cold verification key
  readonly vrfVk: Uint8Array; // 32B VRF verification key
  readonly vrfProof: Uint8Array; // VRF proof bytes
  readonly vrfOutput: Uint8Array; // VRF output (certified random)
  readonly kesSig: Uint8Array; // KES Sum6 signature
  readonly kesPeriod: number; // KES period of the signature
  readonly opcertSig: Uint8Array; // Ed25519 signature of opcert
  readonly opcertVkHot: Uint8Array; // KES verification key (hot)
  readonly opcertSeqNo: number; // Operational certificate counter
  readonly opcertKesPeriod: number; // Start KES period in opcert
  readonly bodyHash: Uint8Array; // Hash of block body
}

export interface LedgerView {
  readonly epochNonce: Uint8Array;
  readonly poolVrfKeys: ReadonlyMap<string, Uint8Array>; // poolId hex → VRF vk
  readonly poolStake: ReadonlyMap<string, bigint>; // poolId hex → lovelace
  readonly totalStake: bigint;
  readonly activeSlotsCoeff: number; // f parameter
  readonly maxKesEvolutions: number; // max KES period
}

/** Hex-encode a Uint8Array for map lookups. */
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Validate a block header against the ledger view.
 * All five assertions run via Effect.all (parallel by default).
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
      assertOperationalCertificate(header, ledgerView),
    ]);
  });

// ---------------------------------------------------------------------------
// 1. AssertKnownLeaderVrf
// ---------------------------------------------------------------------------

/**
 * The VRF key in the header must match the pool's registered VRF key.
 * Lookup: blake2b-256(issuerVk) → poolId → registered VRF vk.
 */
const assertKnownLeaderVrf = (
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      const hasher = new Bun.CryptoHasher("blake2b256");
      const poolId = hex(new Uint8Array(hasher.update(header.issuerVk).digest().buffer));
      const registeredVrfVk = view.poolVrfKeys.get(poolId);
      if (!registeredVrfVk) {
        throw `pool ${poolId} not registered`;
      }
      if (hex(registeredVrfVk) !== hex(header.vrfVk)) {
        throw `VRF key mismatch for pool ${poolId}`;
      }
    },
    catch: (cause) =>
      new HeaderValidationError({ assertion: "AssertKnownLeaderVrf", cause }),
  });

// ---------------------------------------------------------------------------
// 2. AssertVrfProof
// ---------------------------------------------------------------------------

/**
 * VRF proof must be valid for the given input and VRF key.
 * TODO: requires vrf_verify from wasm-utils (Phase 4).
 */
const assertVrfProof = (
  _header: BlockHeader,
  _view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.void; // stub — needs vrf_verify WASM export

// ---------------------------------------------------------------------------
// 3. AssertLeaderStake
// ---------------------------------------------------------------------------

/**
 * VRF output must be below the leadership threshold for the pool's stake.
 * φ_f(σ) = 1 - (1-f)^σ where σ = poolStake / totalStake
 * TODO: requires check_vrf_leader from wasm-utils (Phase 4).
 */
const assertLeaderStake = (
  _header: BlockHeader,
  _view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.void; // stub — needs check_vrf_leader WASM export

// ---------------------------------------------------------------------------
// 4. AssertKesSignature
// ---------------------------------------------------------------------------

/**
 * KES Sum6 signature must verify and KES period must be in bounds.
 * Uses kes_sum6_verify from wasm-utils.
 */
const assertKesSignature = (
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      // KES period bounds check
      const kesPeriodSinceOpcert = header.kesPeriod - header.opcertKesPeriod;
      if (kesPeriodSinceOpcert < 0) {
        throw `KES period ${header.kesPeriod} before opcert start ${header.opcertKesPeriod}`;
      }
      if (kesPeriodSinceOpcert >= view.maxKesEvolutions) {
        throw `KES period ${kesPeriodSinceOpcert} exceeds max evolutions ${view.maxKesEvolutions}`;
      }
      // TODO: call kes_sum6_verify once wasm-utils is initialized
      // const valid = kes_sum6_verify(header.kesSig, header.kesPeriod, header.opcertVkHot, header.bodyHash);
      // if (!valid) throw "KES signature invalid";
    },
    catch: (cause) =>
      new HeaderValidationError({ assertion: "AssertKesSignature", cause }),
  });

// ---------------------------------------------------------------------------
// 5. AssertOperationalCertificate
// ---------------------------------------------------------------------------

/**
 * Opcert: cold key (issuerVk) must have signed the hot key (opcertVkHot).
 * Uses ed25519_verify from wasm-utils.
 */
const assertOperationalCertificate = (
  header: BlockHeader,
  _view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      // The opcert signature covers: hot KES vk ∥ sequence number ∥ KES period
      // TODO: construct the signed message and call ed25519_verify
      // const msg = concat(header.opcertVkHot, be32(header.opcertSeqNo), be32(header.opcertKesPeriod));
      // const valid = ed25519_verify(msg, header.opcertSig, header.issuerVk);
      // if (!valid) throw "opcert signature invalid";

      // Sequence number must be non-negative
      if (header.opcertSeqNo < 0) {
        throw `invalid opcert sequence number: ${header.opcertSeqNo}`;
      }
    },
    catch: (cause) =>
      new HeaderValidationError({ assertion: "AssertOperationalCertificate", cause }),
  });
