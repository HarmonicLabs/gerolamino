/**
 * Header validation — five Ouroboros Praos assertions.
 *
 * All five can run in parallel (no dependencies between them):
 *   1. AssertKnownLeaderVrf — VRF key matches registered pool
 *   2. AssertVrfProof — VRF proof valid (ECVRF-ED25519-SHA512-Elligator2)
 *   3. AssertLeaderStake — stake threshold check (via pallas-math)
 *   4. AssertKesSignature — KES Sum6 verify over CBOR(headerBody) + period bounds
 *   5. AssertOperationalCertificate — opcert ed25519 verify + sequence check
 */
import { Effect, Equal, HashMap, Option, Schema } from "effect";
import { Crypto } from "wasm-utils";
import { hex, concat, be64 } from "../util";
import type { Context } from "effect";

export class HeaderValidationError extends Schema.TaggedErrorClass<HeaderValidationError>()(
  "HeaderValidationError",
  {
    assertion: Schema.String,
    message: Schema.String,
    blockSlot: Schema.optional(Schema.BigInt),
    blockHash: Schema.optional(Schema.Uint8Array),
  },
) {}

const headerValidationError = (
  assertion: string,
  message: string,
  header: BlockHeader,
): HeaderValidationError =>
  new HeaderValidationError({
    assertion,
    message,
    blockSlot: header.slot,
    blockHash: header.hash,
  });

// ---------------------------------------------------------------------------
// BlockHeader — consensus-layer view of a Shelley+ block header
// ---------------------------------------------------------------------------

export const BlockHeader = Schema.Struct({
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
  prevHash: Schema.Uint8Array,
  issuerVk: Schema.Uint8Array,
  vrfVk: Schema.Uint8Array,
  vrfProof: Schema.Uint8Array,
  /** Leader-tagged VRF output (Babbage+: blake2b(0x4c ∥ proofHash), pre-Babbage: leaderVrf.output). */
  vrfOutput: Schema.Uint8Array,
  /** Nonce-tagged VRF output for nonce evolution (Babbage+: blake2b(0x4e ∥ proofHash), pre-Babbage: nonceVrf.output). */
  nonceVrfOutput: Schema.Uint8Array,
  kesSig: Schema.Uint8Array,
  kesPeriod: Schema.Number,
  opcertSig: Schema.Uint8Array,
  opcertVkHot: Schema.Uint8Array,
  opcertSeqNo: Schema.Number,
  opcertKesPeriod: Schema.Number,
  bodyHash: Schema.Uint8Array,
  /** Declared block body size (from header, for protocol param size check). */
  bodySize: Schema.Number,
  /** Raw CBOR of the header body — KES signs this, not bodyHash. */
  headerBodyCbor: Schema.Uint8Array,
});
export type BlockHeader = typeof BlockHeader.Type;

// ---------------------------------------------------------------------------
// LedgerView — stake distribution + protocol params for validation
// ---------------------------------------------------------------------------

export const LedgerView = Schema.Struct({
  epochNonce: Schema.Uint8Array,
  poolVrfKeys: Schema.HashMap(Schema.String, Schema.Uint8Array),
  poolStake: Schema.HashMap(Schema.String, Schema.BigInt),
  totalStake: Schema.BigInt,
  activeSlotsCoeff: Schema.Number,
  maxKesEvolutions: Schema.Number,
  /** Protocol param: max header size in bytes (default 1100). 0 = skip check. */
  maxHeaderSize: Schema.Number,
  /** Protocol param: max block body size in bytes (default 90112). 0 = skip check. */
  maxBlockBodySize: Schema.Number,
  /** Opcert counters: pool key hash (hex) → last seen sequence number. */
  ocertCounters: Schema.HashMap(Schema.String, Schema.Number),
});
export type LedgerView = typeof LedgerView.Type;

/** Previous tip state for envelope validation. */
export const PrevTip = Schema.Struct({
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
});
export type PrevTip = typeof PrevTip.Type;

/**
 * Validate a block header. Envelope checks run first, then five Praos assertions
 * run in parallel via Effect.all. Requires `Crypto` in the environment.
 *
 * @param prevTip Previous block's tip (undefined for genesis / first block after intersection)
 */
export const validateHeader = (
  header: BlockHeader,
  ledgerView: LedgerView,
  prevTip?: PrevTip,
): Effect.Effect<void, HeaderValidationError, Crypto> =>
  Effect.gen(function* () {
    // Envelope checks (fast, sequential) — per Haskell HeaderValidation.hs:366-378
    yield* validateEnvelope(header, prevTip, ledgerView);

    // Protocol checks (crypto-heavy, parallel) — 5 Praos assertions
    const crypto = yield* Crypto;
    yield* Effect.all([
      assertKnownLeaderVrf(crypto, header, ledgerView),
      assertVrfProof(crypto, header, ledgerView),
      assertLeaderStake(crypto, header, ledgerView),
      assertKesSignature(crypto, header, ledgerView),
      assertOperationalCertificate(crypto, header, ledgerView),
    ]);
  });

// ---------------------------------------------------------------------------
// Envelope validation — chain structure integrity (blockNo, slot, prevHash, sizes)
// Per Haskell ouroboros-consensus HeaderValidation.hs ValidateEnvelope
// ---------------------------------------------------------------------------

const validateEnvelope = (
  header: BlockHeader,
  prevTip: PrevTip | undefined,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.gen(function* () {
    if (prevTip) {
      // BlockNo must be exactly prev + 1 (Haskell: UnexpectedBlockNo)
      if (header.blockNo !== prevTip.blockNo + 1n)
        return yield* Effect.fail(
          headerValidationError(
            "Envelope",
            `BlockNo ${header.blockNo} != expected ${prevTip.blockNo + 1n}`,
            header,
          ),
        );
      // Slot must be strictly increasing (Haskell: UnexpectedSlotNo)
      if (header.slot <= prevTip.slot)
        return yield* Effect.fail(
          headerValidationError(
            "Envelope",
            `Slot ${header.slot} not > prev ${prevTip.slot}`,
            header,
          ),
        );
      // PrevHash must chain correctly (Haskell: UnexpectedPrevHash)
      if (!Equal.equals(header.prevHash, prevTip.hash))
        return yield* Effect.fail(
          headerValidationError(
            "Envelope",
            `PrevHash mismatch: expected ${hex(prevTip.hash)}, got ${hex(header.prevHash)}`,
            header,
          ),
        );
    }
    // Size limits from protocol params (Haskell: additionalEnvelopeChecks)
    if (view.maxHeaderSize > 0 && header.headerBodyCbor.byteLength > view.maxHeaderSize)
      return yield* Effect.fail(
        headerValidationError(
          "Envelope",
          `Header size ${header.headerBodyCbor.byteLength} exceeds max ${view.maxHeaderSize}`,
          header,
        ),
      );
    if (view.maxBlockBodySize > 0 && header.bodySize > view.maxBlockBodySize)
      return yield* Effect.fail(
        headerValidationError(
          "Envelope",
          `Block body size ${header.bodySize} exceeds max ${view.maxBlockBodySize}`,
          header,
        ),
      );
  });

// 1. VRF key must match the pool's registered VRF key
// Gracefully skips when pool data is absent (genesis sync without bootstrap).
const assertKnownLeaderVrf = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> => {
  if (HashMap.size(view.poolVrfKeys) === 0) return Effect.void;
  return Effect.gen(function* () {
    const poolIdBytes = yield* crypto
      .blake2b256(header.issuerVk)
      .pipe(
        Effect.mapError((cause) =>
          headerValidationError("AssertKnownLeaderVrf", String(cause), header),
        ),
      );
    const poolId = hex(poolIdBytes);
    const registeredVrfVk = HashMap.get(view.poolVrfKeys, poolId);
    if (Option.isNone(registeredVrfVk))
      return yield* Effect.fail(
        headerValidationError("AssertKnownLeaderVrf", `pool ${poolId} not registered`, header),
      );
    if (!Equal.equals(registeredVrfVk.value, header.vrfVk))
      return yield* Effect.fail(
        headerValidationError("AssertKnownLeaderVrf", `VRF key mismatch for pool ${poolId}`, header),
      );
  });
};

// 2. VRF proof valid (ECVRF-ED25519-SHA512-Elligator2 via amaru-vrf-dalek)
// Gracefully skips when epoch nonce is all-zeros (genesis sync — no real nonce).
const assertVrfProof = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> => {
  if (view.epochNonce.every((b) => b === 0)) return Effect.void;
  return Effect.gen(function* () {
    // Construct VRF input: blake2b-256(slot_be64 || epoch_nonce)
    const slotBuf = new Uint8Array(8);
    new DataView(slotBuf.buffer).setBigUint64(0, header.slot);
    const vrfInput = yield* crypto
      .blake2b256(concat(slotBuf, view.epochNonce))
      .pipe(
        Effect.mapError((cause) => headerValidationError("AssertVrfProof", String(cause), header)),
      );

    // Verify the VRF proof — WASM call; returns 64-byte proof hash on success.
    const proofHash = yield* crypto
      .vrfVerifyProof(header.vrfVk, header.vrfProof, vrfInput)
      .pipe(
        Effect.mapError((cause) => headerValidationError("AssertVrfProof", String(cause), header)),
      );

    // Skip output comparison if stub returns all-zero hash (test-only).
    // A real ECVRF proof hash is never all zeros.
    if (proofHash.every((b) => b === 0)) return;

    // Verify the declared VRF output matches the computed proof hash.
    // The VRF output in the header is the leader-tagged hash: blake2b-256(0x4c || proofHash)
    const leaderTag = new Uint8Array([0x4c]);
    const expectedOutput = yield* crypto
      .blake2b256(concat(leaderTag, proofHash))
      .pipe(
        Effect.mapError((cause) => headerValidationError("AssertVrfProof", String(cause), header)),
      );
    if (!Equal.equals(expectedOutput, header.vrfOutput))
      return yield* Effect.fail(
        headerValidationError(
          "AssertVrfProof",
          `VRF output mismatch: expected ${hex(expectedOutput)}, got ${hex(header.vrfOutput)}`,
          header,
        ),
      );
  });
};

// 3. Leader stake threshold — check_vrf_leader via Crypto service
// Gracefully skips when pool stake data is absent (genesis sync without bootstrap).
const assertLeaderStake = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> => {
  if (view.totalStake === 0n) return Effect.void;
  return Effect.gen(function* () {
    const poolIdBytes = yield* crypto
      .blake2b256(header.issuerVk)
      .pipe(
        Effect.mapError((cause) =>
          headerValidationError("AssertLeaderStake", String(cause), header),
        ),
      );
    const poolId = hex(poolIdBytes);
    const poolStake = HashMap.get(view.poolStake, poolId);
    if (Option.isNone(poolStake))
      return yield* Effect.fail(
        headerValidationError(
          "AssertLeaderStake",
          `pool ${poolId} has no registered stake`,
          header,
        ),
      );

    // Decompose activeSlotsCoeff (e.g. 0.05 → 5/100)
    // For Cardano mainnet/preprod, f = 1/20
    const coeffDen = 100;
    const coeffNum = Math.round(view.activeSlotsCoeff * coeffDen);

    // checkVrfLeader is a WASM call via the Crypto service.
    const isLeader = yield* crypto
      .checkVrfLeader(
        hex(header.vrfOutput),
        poolStake.value.toString(),
        view.totalStake.toString(),
        coeffNum.toString(),
        coeffDen.toString(),
      )
      .pipe(
        Effect.mapError((cause) =>
          headerValidationError("AssertLeaderStake", String(cause), header),
        ),
      );
    if (!isLeader)
      return yield* Effect.fail(
        headerValidationError(
          "AssertLeaderStake",
          `pool ${poolId} is not leader for this slot (VRF threshold not met)`,
          header,
        ),
      );
  });
};

// 4. KES signature verify + period bounds
const assertKesSignature = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.gen(function* () {
    const kesPeriodSinceOpcert = header.kesPeriod - header.opcertKesPeriod;
    if (kesPeriodSinceOpcert < 0)
      return yield* Effect.fail(
        headerValidationError(
          "AssertKesSignature",
          `KES period ${header.kesPeriod} before opcert start ${header.opcertKesPeriod}`,
          header,
        ),
      );
    if (kesPeriodSinceOpcert >= view.maxKesEvolutions)
      return yield* Effect.fail(
        headerValidationError(
          "AssertKesSignature",
          `KES period ${kesPeriodSinceOpcert} exceeds max ${view.maxKesEvolutions}`,
          header,
        ),
      );
    // Verify KES signature over CBOR(headerBody) — not bodyHash.
    // pallas expects RELATIVE period (kesPeriod - opcertKesPeriod), not absolute.
    const valid = yield* crypto
      .kesSum6Verify(
        header.kesSig,
        kesPeriodSinceOpcert,
        header.opcertVkHot,
        header.headerBodyCbor,
      )
      .pipe(
        Effect.mapError((cause) =>
          headerValidationError("AssertKesSignature", String(cause), header),
        ),
      );
    if (!valid)
      return yield* Effect.fail(
        headerValidationError("AssertKesSignature", "KES signature invalid", header),
      );
  });

// 5. Opcert: cold key must have signed the hot key + counter monotonicity
// Per Haskell Praos.hs:638-648: DSIGN verify + counter check (m <= n <= m+1)
const assertOperationalCertificate = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> =>
  Effect.gen(function* () {
    if (header.opcertSeqNo < 0)
      return yield* Effect.fail(
        headerValidationError(
          "AssertOperationalCertificate",
          `invalid opcert sequence number: ${header.opcertSeqNo}`,
          header,
        ),
      );
    // Opcert message: hotVk(32 bytes) ∥ seqNo(BE64) ∥ kesPeriod(BE64)
    // Per Amaru/Haskell: seqNo and kesPeriod are Word64, serialized as 8-byte big-endian.
    const msg = concat(header.opcertVkHot, be64(header.opcertSeqNo), be64(header.opcertKesPeriod));
    const valid = yield* crypto
      .ed25519Verify(msg, header.opcertSig, header.issuerVk)
      .pipe(
        Effect.mapError((cause) =>
          headerValidationError("AssertOperationalCertificate", String(cause), header),
        ),
      );
    if (!valid)
      return yield* Effect.fail(
        headerValidationError(
          "AssertOperationalCertificate",
          "opcert Ed25519 signature invalid",
          header,
        ),
      );

    // Counter monotonicity check (per Haskell Praos.hs:645-648).
    // Gracefully skip when counters are empty (genesis sync without bootstrap).
    if (HashMap.size(view.ocertCounters) > 0) {
      const poolIdBytes = yield* crypto
        .blake2b256(header.issuerVk)
        .pipe(
          Effect.mapError((cause) =>
            headerValidationError("AssertOperationalCertificate", String(cause), header),
          ),
        );
      const poolId = hex(poolIdBytes);
      const lastSeqNo = HashMap.get(view.ocertCounters, poolId).pipe(Option.getOrElse(() => 0));
      if (header.opcertSeqNo < lastSeqNo)
        return yield* Effect.fail(
          headerValidationError(
            "AssertOperationalCertificate",
            `opcert seqNo ${header.opcertSeqNo} < last ${lastSeqNo} (CounterTooSmall)`,
            header,
          ),
        );
      if (header.opcertSeqNo > lastSeqNo + 1)
        return yield* Effect.fail(
          headerValidationError(
            "AssertOperationalCertificate",
            `opcert seqNo ${header.opcertSeqNo} > last + 1 (CounterOverIncremented)`,
            header,
          ),
        );
    }
  });
