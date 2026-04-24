/**
 * Ledger → Consensus bridge: extracts LedgerView and nonces from ExtLedgerState.
 *
 * The ExtLedgerState is decoded from a Mithril snapshot's "state" file by the
 * ledger package. This module maps its PoolDistr and PraosChainDepState into
 * the consensus-layer types needed for header validation.
 */
import { Effect, HashMap, Option, Schema } from "effect";
import { CborKinds, type CborSchemaType, CborValue } from "codecs";
import type { ExtLedgerState } from "ledger";
import type { LedgerView } from "../validate/header";
import { SlotClock } from "../praos/clock";
import { Nonces } from "../praos/nonce";

export class SnapshotDecodeError extends Schema.TaggedErrorClass<SnapshotDecodeError>()(
  "SnapshotDecodeError",
  { message: Schema.String },
) {}

// ---------------------------------------------------------------------------
// Protocol-param defaults (current Cardano mainnet / preprod values)
// ---------------------------------------------------------------------------

/** Conway CBOR-Map keys for the two pparams we currently bridge. */
const PPARAM_KEY = { maxHeaderSize: 4, maxBlockBodySize: 2 } as const;
/** Fallbacks used when the CBOR Map has no entry for the requested key. */
const PPARAM_DEFAULT = { maxHeaderSize: 1100, maxBlockBodySize: 90112 } as const;
/** Haskell `maxKesEvolutions` constant (protocol-wide). */
const MAX_KES_EVOLUTIONS = 62;

// ---------------------------------------------------------------------------
// LedgerView extraction
// ---------------------------------------------------------------------------

/**
 * Extract a LedgerView from a decoded ExtLedgerState.
 *
 * Uses PoolDistr for VRF keys and stake distribution (most direct source).
 * `activeSlotsCoeff` + `maxKesEvolutions` come from `SlotClock.config` + a
 * Haskell protocol constant, respectively.
 */
export const extractLedgerView = (state: ExtLedgerState) =>
  Effect.gen(function* () {
    const slotClock = yield* SlotClock;
    const poolDistr = state.newEpochState.poolDistr;

    // Ledger `poolDistr.pools` is `HashMap<Uint8Array, IndividualPoolStake>`;
    // `LedgerView` keys are hex strings (computed from `hex(blake2b256(issuerVk))`
    // at header-validation time). Normalise once at the bridge boundary so
    // each pool entry crosses `toHex()` exactly once even though it fans out
    // into two HashMaps.
    const normalised = Array.from(
      HashMap.entries(poolDistr.pools),
      ([poolHash, ps]) => ({
        hexHash: poolHash.toHex(),
        vrfKeyHash: ps.vrfKeyHash,
        totalStake: ps.totalStake,
      }),
    );
    const poolVrfKeys = HashMap.fromIterable(
      normalised.map((p) => [p.hexHash, p.vrfKeyHash] as const),
    );
    const poolStake = HashMap.fromIterable(
      normalised.map((p) => [p.hexHash, p.totalStake] as const),
    );

    const pparams = state.newEpochState.epochState.ledgerState.utxoState.govState.currentPParams;
    const result: LedgerView = {
      epochNonce: extractPraosNonces(state.chainDepState).epochNonce,
      poolVrfKeys,
      poolStake,
      totalStake: poolDistr.totalActiveStake,
      activeSlotsCoeff: slotClock.config.activeSlotsCoeff,
      maxKesEvolutions: MAX_KES_EVOLUTIONS,
      maxHeaderSize: extractPParamUint(pparams, PPARAM_KEY.maxHeaderSize) ?? PPARAM_DEFAULT.maxHeaderSize,
      maxBlockBodySize:
        extractPParamUint(pparams, PPARAM_KEY.maxBlockBodySize) ?? PPARAM_DEFAULT.maxBlockBodySize,
      ocertCounters: extractOcertCounters(state.chainDepState),
    };
    return result;
  });

/**
 * Extract initial `Nonces` from a snapshot's ExtLedgerState. Falls back
 * to zero-filled nonces if the chain-dep state fails to decode.
 */
export const extractNonces = (state: ExtLedgerState): Nonces => {
  const { evolvingNonce, candidateNonce, epochNonce } = extractPraosNonces(state.chainDepState);
  return new Nonces({
    active: epochNonce,
    evolving: evolvingNonce,
    candidate: candidateNonce,
    epoch: state.newEpochState.epoch,
  });
};

/**
 * Extract the snapshot tip as a consensus-compatible point (includes blockNo).
 */
export const extractSnapshotTip = (
  state: ExtLedgerState,
): { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined =>
  Option.getOrUndefined(state.tip);

// ---------------------------------------------------------------------------
// Protocol-parameter extraction (CBOR Map lookup by uint key)
// ---------------------------------------------------------------------------

/**
 * Look up a uint-valued entry in a CBOR Map by numeric key. Returns
 * `undefined` if the input isn't a Map, the key is absent, or the value
 * isn't a uint.
 *
 * Single `Array.prototype.find` + typed narrowing via `CborValue.guards`
 * replaces the previous `for (const entry of …) { … return }` loop.
 */
const extractPParamUint = (pparams: CborSchemaType, key: number): number | undefined => {
  if (!CborValue.guards[CborKinds.Map](pparams)) return undefined;
  const entry = pparams.entries.find(
    (e) => CborValue.guards[CborKinds.UInt](e.k) && Number(e.k.num) === key,
  );
  return entry !== undefined && CborValue.guards[CborKinds.UInt](entry.v)
    ? Number(entry.v.num)
    : undefined;
};

// ---------------------------------------------------------------------------
// Praos chain-dep-state nonce extraction
// ---------------------------------------------------------------------------

/**
 * PraosState CBOR layout (Array(7)):
 *   [0] lastSlot: WithOrigin SlotNo
 *   [1] ocertCounters: Map(KeyHash → Word64)
 *   [2] evolvingNonce: Nonce
 *   [3] candidateNonce: Nonce
 *   [4] epochNonce: Nonce
 *   [5] labNonce: Nonce
 *   [6] lastEpochBlockNonce: Nonce
 *
 * Nonce encoding: Array(0) = NeutralNonce, Array(1, [bytes32]) = Nonce(hash)
 */
const PraosNonces = Schema.Struct({
  evolvingNonce: Schema.Uint8Array,
  candidateNonce: Schema.Uint8Array,
  epochNonce: Schema.Uint8Array,
});
type PraosNonces = typeof PraosNonces.Type;

/** Zero-filled 32-byte nonce — frozen module-level so fallback branches
 *  all share a single allocation. */
const ZERO_NONCE = new Uint8Array(32);
const EMPTY_NONCES = PraosNonces.make({
  evolvingNonce: ZERO_NONCE,
  candidateNonce: ZERO_NONCE,
  epochNonce: ZERO_NONCE,
});

/** Decode a CBOR Nonce: Array(0) → zeros, Array(1, [bytes32]) → hash,
 *  raw Bytes(32) → hash. Anything else falls back to zeros. */
const decodeNonce = (cbor: CborSchemaType): Uint8Array => {
  if (CborValue.guards[CborKinds.Array](cbor)) {
    if (cbor.items.length === 0) return ZERO_NONCE;
    const [head] = cbor.items;
    if (
      head !== undefined &&
      CborValue.guards[CborKinds.Bytes](head) &&
      head.bytes.length === 32
    ) {
      return head.bytes;
    }
    return ZERO_NONCE;
  }
  if (CborValue.guards[CborKinds.Bytes](cbor) && cbor.bytes.length === 32) return cbor.bytes;
  return ZERO_NONCE;
};

/** Pull `evolvingNonce` / `candidateNonce` / `epochNonce` out of the
 *  PraosState CBOR Array. Gracefully returns `EMPTY_NONCES` on shape
 *  mismatch — snapshots from older nodes may lack fields. */
const extractPraosNonces = (chainDepState: CborSchemaType): PraosNonces => {
  if (!CborValue.guards[CborKinds.Array](chainDepState)) return EMPTY_NONCES;
  // Indices [2], [3], [4] per PraosState layout above.
  const [, , evolving, candidate, epoch] = chainDepState.items;
  if (evolving === undefined || candidate === undefined || epoch === undefined) return EMPTY_NONCES;
  return PraosNonces.make({
    evolvingNonce: decodeNonce(evolving),
    candidateNonce: decodeNonce(candidate),
    epochNonce: decodeNonce(epoch),
  });
};

// ---------------------------------------------------------------------------
// OpCert counter extraction
// ---------------------------------------------------------------------------

/**
 * Extract opcert counters from PraosState[1] (`Map(KeyHash → Word64)`).
 *
 * Per Haskell PraosState: index [1] is
 *   `praosStateOCertCounters :: Map (KeyHash BlockIssuer) Word64`.
 * The CBOR Map has 28-byte key hashes (blake2b-224 of pool cold VKey)
 * and uint64 seqNo values.
 */
export const extractOcertCounters = (
  chainDepState: CborSchemaType,
): HashMap.HashMap<string, number> => {
  if (!CborValue.guards[CborKinds.Array](chainDepState) || chainDepState.items.length < 7) {
    return HashMap.empty();
  }
  const mapNode = chainDepState.items[1]!;
  if (!CborValue.guards[CborKinds.Map](mapNode)) return HashMap.empty();

  // `.flatMap([tuple] | [])` is the canonical `filterMap` idiom —
  // skips entries whose key/value types don't match, keeps the matching
  // ones, no mutable accumulator.
  return HashMap.fromIterable(
    mapNode.entries.flatMap((e) =>
      CborValue.guards[CborKinds.Bytes](e.k) && CborValue.guards[CborKinds.UInt](e.v)
        ? [[e.k.bytes.toHex(), Number(e.v.num)] as const]
        : [],
    ),
  );
};
