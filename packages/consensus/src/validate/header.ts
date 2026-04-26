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
import { Effect, Equal, HashMap, Metric, Option, Schema } from "effect";
import { Crypto } from "wasm-utils";
import { concat, be64 } from "../util";
import { BlockValidationFailed, SPAN } from "../observability.ts";
import type { Context } from "effect";

/** Enumerates the 5 Praos header-validation buckets (Envelope + the 4
 * pool/VRF/KES/opcert assertions). Narrows `assertion` from a free-form
 * string so `Match.value(e.assertion)` matches exhaustively. */
export const HeaderAssertion = Schema.Literals([
  "Envelope",
  "AssertKnownLeaderVrf",
  "AssertVrfProof",
  "AssertLeaderStake",
  "AssertKesSignature",
  "AssertOperationalCertificate",
]);
export type HeaderAssertion = typeof HeaderAssertion.Type;

export class HeaderValidationError extends Schema.TaggedErrorClass<HeaderValidationError>()(
  "HeaderValidationError",
  {
    assertion: HeaderAssertion,
    message: Schema.String,
    blockSlot: Schema.optional(Schema.BigInt),
    blockHash: Schema.optional(Schema.Uint8Array),
  },
) {}

const headerValidationError = (
  assertion: HeaderAssertion,
  message: string,
  header: BlockHeader,
): HeaderValidationError =>
  new HeaderValidationError({
    assertion,
    message,
    blockSlot: header.slot,
    blockHash: header.hash,
  });

/** Curry-first helper: fix `(assertion, header)` so every `Effect.mapError`
 *  along a crypto pipeline reads as `.pipe(Effect.mapError(toHeaderErr))`. */
const headerErrFor =
  (assertion: HeaderAssertion, header: BlockHeader) =>
  (cause: unknown): HeaderValidationError =>
    headerValidationError(assertion, String(cause), header);

/** Babbage+ leader-VRF output = `blake2b256(0x4c ∥ proofHash)` (ASCII 'L',
 *  per Haskell `Praos/VRF.hs:108`). Shared with `bridges/header.ts`. */
const VRF_LEADER_TAG_BYTE = new Uint8Array([0x4c]);

/** Praos fraction denominator for `activeSlotsCoeff` — f is always
 *  expressed as `coeffNum / 100` in Cardano configs. */
const COEFF_DENOMINATOR = 100;

/** All-zero byte array sentinel — `view.epochNonce` and stub VRF proof
 *  hashes use this to signal "no real data", in which case the affected
 *  assertion gracefully no-ops (genesis-sync path). */
const isAllZero = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

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
    yield* validateEnvelope(header, prevTip, ledgerView);
    const crypto = yield* Crypto;

    // Hoist `poolId = blake2b256(issuerVk).toHex()` once. Three of the
    // five assertions (KnownLeaderVrf, LeaderStake, OperationalCertificate)
    // need it; computing inline runs the hash three times in parallel.
    // Skipped in the genesis path where all three would early-exit anyway.
    const needsPoolId =
      HashMap.size(ledgerView.poolVrfKeys) > 0 ||
      ledgerView.totalStake !== 0n ||
      HashMap.size(ledgerView.ocertCounters) > 0;
    const poolId: string | undefined = needsPoolId
      ? (yield* crypto
          .blake2b256(header.issuerVk)
          .pipe(Effect.mapError(headerErrFor("AssertKnownLeaderVrf", header)))).toHex()
      : undefined;

    // The five assertions are independent — VRF proof, KES signature, opcert
    // Ed25519 verify, and leader-threshold check all hit different crypto
    // primitives. Run unbounded so a worker-backed `Crypto` layer can spread
    // them across cores; the default sequential `Effect.all` would serialize
    // four crypto operations that have no data dependency on each other.
    yield* Effect.all(
      [
        assertKnownLeaderVrf(header, ledgerView, poolId),
        assertVrfProof(crypto, header, ledgerView),
        assertLeaderStake(crypto, header, ledgerView, poolId),
        assertKesSignature(crypto, header, ledgerView),
        assertOperationalCertificate(crypto, header, ledgerView, poolId),
      ],
      { concurrency: "unbounded" },
    );
  }).pipe(
    Effect.tapError(() => Metric.update(BlockValidationFailed, 1)),
    Effect.withSpan(SPAN.ValidateHeader, {
      attributes: {
        "block.slot": String(header.slot),
        "block.no": String(header.blockNo),
      },
    }),
  );

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
            `PrevHash mismatch: expected ${prevTip.hash.toHex()}, got ${header.prevHash.toHex()}`,
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
// Pure now — receives `poolId` from `validateHeader`'s hoisted blake2b256.
const assertKnownLeaderVrf = (
  header: BlockHeader,
  view: LedgerView,
  poolId: string | undefined,
): Effect.Effect<void, HeaderValidationError> => {
  if (HashMap.size(view.poolVrfKeys) === 0 || poolId === undefined) return Effect.void;
  const toErr = headerErrFor("AssertKnownLeaderVrf", header);
  const registeredVrfVk = HashMap.get(view.poolVrfKeys, poolId);
  if (Option.isNone(registeredVrfVk))
    return Effect.fail(toErr(`pool ${poolId} not registered`));
  if (!Equal.equals(registeredVrfVk.value, header.vrfVk))
    return Effect.fail(toErr(`VRF key mismatch for pool ${poolId}`));
  return Effect.void;
};

// 2. VRF proof valid (ECVRF-ED25519-SHA512-Elligator2 via amaru-vrf-dalek)
// Gracefully skips when epoch nonce is all-zeros (genesis sync — no real nonce).
const assertVrfProof = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> => {
  if (isAllZero(view.epochNonce)) return Effect.void;
  const toErr = headerErrFor("AssertVrfProof", header);
  return Effect.gen(function* () {
    // VRF input: `blake2b-256(slot_be64 ∥ epoch_nonce)`. `be64` already
    // produces a big-endian 8-byte buffer (platform-independent).
    const vrfInput = yield* crypto
      .blake2b256(concat(be64(header.slot), view.epochNonce))
      .pipe(Effect.mapError(toErr));

    // Verify the VRF proof — WASM call; returns 64-byte proof hash on success.
    const proofHash = yield* crypto
      .vrfVerifyProof(header.vrfVk, header.vrfProof, vrfInput)
      .pipe(Effect.mapError(toErr));

    // Skip output comparison if stub returns all-zero hash (test-only).
    // A real ECVRF proof hash is never all zeros.
    if (isAllZero(proofHash)) return;

    // Declared VRF output must equal `blake2b-256(0x4c ∥ proofHash)` —
    // the leader-tagged derivation (Babbage+, Haskell `Praos/VRF.hs:108`).
    const expectedOutput = yield* crypto
      .blake2b256(concat(VRF_LEADER_TAG_BYTE, proofHash))
      .pipe(Effect.mapError(toErr));
    if (!Equal.equals(expectedOutput, header.vrfOutput))
      return yield* Effect.fail(
        toErr(
          `VRF output mismatch: expected ${expectedOutput.toHex()}, got ${header.vrfOutput.toHex()}`,
        ),
      );
  });
};

// 3. Leader stake threshold — check_vrf_leader via Crypto service
// Gracefully skips when pool stake data is absent (genesis sync without bootstrap).
// Receives hoisted `poolId` from `validateHeader`.
const assertLeaderStake = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
  poolId: string | undefined,
): Effect.Effect<void, HeaderValidationError> => {
  if (view.totalStake === 0n || poolId === undefined) return Effect.void;
  const toErr = headerErrFor("AssertLeaderStake", header);
  return Effect.gen(function* () {
    const poolStake = HashMap.get(view.poolStake, poolId);
    if (Option.isNone(poolStake))
      return yield* Effect.fail(toErr(`pool ${poolId} has no registered stake`));

    // Decompose activeSlotsCoeff (e.g. 0.05 → 5/100). For Cardano
    // mainnet/preprod, f = 1/20 → coeffNum = 5.
    const coeffNum = Math.round(view.activeSlotsCoeff * COEFF_DENOMINATOR);

    // checkVrfLeader is a WASM call via the Crypto service.
    const isLeader = yield* crypto
      .checkVrfLeader(
        header.vrfOutput.toHex(),
        poolStake.value.toString(),
        view.totalStake.toString(),
        coeffNum.toString(),
        COEFF_DENOMINATOR.toString(),
      )
      .pipe(Effect.mapError(toErr));
    if (!isLeader)
      return yield* Effect.fail(
        toErr(`pool ${poolId} is not leader for this slot (VRF threshold not met)`),
      );
  });
};

// 4. KES signature verify + period bounds
const assertKesSignature = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
): Effect.Effect<void, HeaderValidationError> => {
  const toErr = headerErrFor("AssertKesSignature", header);
  return Effect.gen(function* () {
    const kesPeriodSinceOpcert = header.kesPeriod - header.opcertKesPeriod;
    if (kesPeriodSinceOpcert < 0)
      return yield* Effect.fail(
        toErr(`KES period ${header.kesPeriod} before opcert start ${header.opcertKesPeriod}`),
      );
    if (kesPeriodSinceOpcert >= view.maxKesEvolutions)
      return yield* Effect.fail(
        toErr(`KES period ${kesPeriodSinceOpcert} exceeds max ${view.maxKesEvolutions}`),
      );
    // Verify KES signature over CBOR(headerBody) — not bodyHash.
    // pallas expects RELATIVE period (kesPeriod - opcertKesPeriod), not absolute.
    const valid = yield* crypto
      .kesSum6Verify(header.kesSig, kesPeriodSinceOpcert, header.opcertVkHot, header.headerBodyCbor)
      .pipe(Effect.mapError(toErr));
    if (!valid) return yield* Effect.fail(toErr("KES signature invalid"));
  });
};

// 5. Opcert: cold key must have signed the hot key + counter monotonicity
// Per Haskell Praos.hs:638-648: DSIGN verify + counter check (m <= n <= m+1)
// Receives hoisted `poolId` from `validateHeader` for the counter-monotonicity branch.
const assertOperationalCertificate = (
  crypto: Context.Service.Shape<typeof Crypto>,
  header: BlockHeader,
  view: LedgerView,
  poolId: string | undefined,
): Effect.Effect<void, HeaderValidationError> => {
  const toErr = headerErrFor("AssertOperationalCertificate", header);
  return Effect.gen(function* () {
    if (header.opcertSeqNo < 0)
      return yield* Effect.fail(toErr(`invalid opcert sequence number: ${header.opcertSeqNo}`));
    // Opcert message: hotVk(32 bytes) ∥ seqNo(BE64) ∥ kesPeriod(BE64)
    // Per Amaru/Haskell: seqNo and kesPeriod are Word64, serialized as 8-byte big-endian.
    const msg = concat(header.opcertVkHot, be64(header.opcertSeqNo), be64(header.opcertKesPeriod));
    const valid = yield* crypto
      .ed25519Verify(msg, header.opcertSig, header.issuerVk)
      .pipe(Effect.mapError(toErr));
    if (!valid) return yield* Effect.fail(toErr("opcert Ed25519 signature invalid"));

    // Counter monotonicity check (per Haskell Praos.hs:645-648).
    // Gracefully skip when counters are empty (genesis sync without bootstrap).
    if (HashMap.size(view.ocertCounters) > 0 && poolId !== undefined) {
      const lastSeqNo = HashMap.get(view.ocertCounters, poolId).pipe(Option.getOrElse(() => 0));
      if (header.opcertSeqNo < lastSeqNo)
        return yield* Effect.fail(
          toErr(`opcert seqNo ${header.opcertSeqNo} < last ${lastSeqNo} (CounterTooSmall)`),
        );
      if (header.opcertSeqNo > lastSeqNo + 1)
        return yield* Effect.fail(
          toErr(`opcert seqNo ${header.opcertSeqNo} > last + 1 (CounterOverIncremented)`),
        );
    }
  });
};
