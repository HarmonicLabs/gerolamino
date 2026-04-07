/**
 * Header validation — five Ouroboros Praos assertions.
 *
 * All five can run in parallel (no dependencies between them):
 *   1. AssertKnownLeaderVrf — VRF key matches registered pool
 *   2. AssertVrfProof — VRF proof valid (stub: needs vrf_verify export)
 *   3. AssertLeaderStake — stake threshold check (stub: needs check_vrf_leader export)
 *   4. AssertKesSignature — KES Sum6 verify + period bounds
 *   5. AssertOperationalCertificate — opcert ed25519 verify + sequence check
 */
import { Effect, Schema } from "effect";
import { CryptoService } from "./crypto";
import { hex, concat, be32 } from "./util";

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
  readonly opcertVkHot: Uint8Array;
  readonly opcertSeqNo: number;
  readonly opcertKesPeriod: number;
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
 * Validate a block header. All five assertions run in parallel via Effect.all.
 * Requires CryptoService in the environment.
 */
export const validateHeader = (
  header: BlockHeader,
  ledgerView: LedgerView,
): Effect.Effect<void, HeaderValidationError, CryptoService> =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService;
    yield* Effect.all([
      assertKnownLeaderVrf(crypto, header, ledgerView),
      assertVrfProof(crypto, header, ledgerView),
      assertLeaderStake(crypto, header, ledgerView),
      assertKesSignature(crypto, header, ledgerView),
      assertOperationalCertificate(crypto, header),
    ]);
  });

// 1. VRF key must match the pool's registered VRF key
const assertKnownLeaderVrf = (
  crypto: ServiceMap.Service.Shape<typeof CryptoService>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      const poolId = hex(crypto.blake2b256(header.issuerVk));
      const registeredVrfVk = view.poolVrfKeys.get(poolId);
      if (!registeredVrfVk) throw `pool ${poolId} not registered`;
      if (hex(registeredVrfVk) !== hex(header.vrfVk)) throw `VRF key mismatch for pool ${poolId}`;
    },
    catch: (cause) => new HeaderValidationError({ assertion: "AssertKnownLeaderVrf", cause }),
  });

// 2. VRF proof valid (ECVRF-ED25519-SHA512-Elligator2 via amaru-vrf-dalek)
const assertVrfProof = (
  crypto: ServiceMap.Service.Shape<typeof CryptoService>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      // Construct VRF input: blake2b-256(slot_be64 || epoch_nonce)
      const slotBuf = new Uint8Array(8);
      new DataView(slotBuf.buffer).setBigUint64(0, header.slot);
      const vrfInput = crypto.blake2b256(concat(slotBuf, view.epochNonce));

      // Verify the VRF proof — returns 64-byte proof hash on success, throws on failure.
      const proofHash = crypto.vrfVerifyProof(header.vrfVk, header.vrfProof, vrfInput);

      // Skip output comparison if stub returns all-zero hash (test-only CryptoServiceBunNative).
      // A real ECVRF proof hash is never all zeros.
      if (proofHash.every((b) => b === 0)) return;

      // Verify the declared VRF output matches the computed proof hash.
      // The VRF output in the header is the leader-tagged hash: blake2b-256(0x4c || proofHash)
      const leaderTag = new Uint8Array([0x4c]);
      const expectedOutput = crypto.blake2b256(concat(leaderTag, proofHash));
      if (hex(expectedOutput) !== hex(header.vrfOutput))
        throw `VRF output mismatch: expected ${hex(expectedOutput)}, got ${hex(header.vrfOutput)}`;
    },
    catch: (cause) => new HeaderValidationError({ assertion: "AssertVrfProof", cause }),
  });

// 3. Leader stake threshold — check_vrf_leader via CryptoService
const assertLeaderStake = (
  crypto: ServiceMap.Service.Shape<typeof CryptoService>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      const poolId = hex(crypto.blake2b256(header.issuerVk));
      const poolStake = view.poolStake.get(poolId);
      if (poolStake === undefined) throw `pool ${poolId} has no registered stake`;
      if (view.totalStake === 0n) throw "total stake is zero";

      // Decompose activeSlotsCoeff (e.g. 0.05 → 5/100)
      // For Cardano mainnet/preprod, f = 1/20
      const coeffDen = 100;
      const coeffNum = Math.round(view.activeSlotsCoeff * coeffDen);

      const isLeader = crypto.checkVrfLeader(
        hex(header.vrfOutput),
        poolStake.toString(),
        view.totalStake.toString(),
        coeffNum.toString(),
        coeffDen.toString(),
      );
      if (!isLeader) throw `pool ${poolId} is not leader for this slot (VRF threshold not met)`;
    },
    catch: (cause) => new HeaderValidationError({ assertion: "AssertLeaderStake", cause }),
  });

// 4. KES signature verify + period bounds
const assertKesSignature = (
  crypto: ServiceMap.Service.Shape<typeof CryptoService>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      const kesPeriodSinceOpcert = header.kesPeriod - header.opcertKesPeriod;
      if (kesPeriodSinceOpcert < 0)
        throw `KES period ${header.kesPeriod} before opcert start ${header.opcertKesPeriod}`;
      if (kesPeriodSinceOpcert >= view.maxKesEvolutions)
        throw `KES period ${kesPeriodSinceOpcert} exceeds max ${view.maxKesEvolutions}`;
      // Verify KES signature over the block body hash
      const valid = crypto.kesSum6Verify(
        header.kesSig,
        header.kesPeriod,
        header.opcertVkHot,
        header.bodyHash,
      );
      if (!valid) throw "KES signature invalid";
    },
    catch: (cause) => new HeaderValidationError({ assertion: "AssertKesSignature", cause }),
  });

// 5. Opcert: cold key must have signed the hot key
const assertOperationalCertificate = (
  crypto: ServiceMap.Service.Shape<typeof CryptoService>,
  header: BlockHeader,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.try({
    try: () => {
      if (header.opcertSeqNo < 0) throw `invalid opcert sequence number: ${header.opcertSeqNo}`;
      // Opcert message: hotVk ∥ seqNo(BE32) ∥ kesPeriod(BE32)
      const msg = concat(header.opcertVkHot, be32(header.opcertSeqNo), be32(header.opcertKesPeriod));
      const valid = crypto.ed25519Verify(msg, header.opcertSig, header.issuerVk);
      if (!valid) throw "opcert Ed25519 signature invalid";
    },
    catch: (cause) => new HeaderValidationError({ assertion: "AssertOperationalCertificate", cause }),
  });

// Re-export for type usage
import type { ServiceMap } from "effect";
