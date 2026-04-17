/**
 * Ledger → Consensus bridge: extracts LedgerView and nonces from ExtLedgerState.
 *
 * The ExtLedgerState is decoded from a Mithril snapshot's "state" file by the
 * ledger package. This module maps its PoolDistr and PraosChainDepState into
 * the consensus-layer types needed for header validation.
 */
import { Effect, HashMap, Option, Schema } from "effect";
import { CborKinds, type CborSchemaType } from "codecs";
import { hex } from "./util";
import type { ExtLedgerState, ShelleyTip } from "ledger";
import type { LedgerView } from "./validate-header";
import { SlotClock } from "./clock";
import { Nonces } from "./nonce";

export class SnapshotDecodeError extends Schema.TaggedErrorClass<SnapshotDecodeError>()(
  "SnapshotDecodeError",
  { message: Schema.String },
) {}

/**
 * Extract a LedgerView from a decoded ExtLedgerState.
 *
 * Uses PoolDistr for VRF keys and stake distribution (most direct source).
 * activeSlotsCoeff and maxKesEvolutions come from SlotClock config / protocol constants.
 */
export const extractLedgerView = (state: ExtLedgerState) =>
  Effect.gen(function* () {
    const slotClock = yield* SlotClock;
    const poolDistr = state.newEpochState.poolDistr;

    // Build VRF key map: poolHash (hex) → vrfKeyHash
    const poolVrfKeys = HashMap.fromIterable(
      Array.from(poolDistr.pools, ([poolHash, ps]) => [poolHash, ps.vrfKeyHash] as const),
    );

    // Build stake map: poolHash (hex) → totalStake (absolute lovelace)
    const poolStake = HashMap.fromIterable(
      Array.from(poolDistr.pools, ([poolHash, ps]) => [poolHash, ps.totalStake] as const),
    );

    // Extract epoch nonce from PraosChainDepState if available
    const epochNonce = extractEpochNonceFromChainDepState(state.chainDepState);

    // Extract opcert counters from PraosChainDepState[1]
    const ocertCounters = extractOcertCounters(state.chainDepState);

    // Protocol params: maxHeaderSize and maxBlockBodySize.
    // Extract from currentPParams CBOR Map (Conway keys: 4 = maxBHSize, 2 = maxBBSize).
    // Default values match current Cardano mainnet/preprod.
    const pparams = state.newEpochState.epochState.ledgerState.utxoState.govState.currentPParams;
    const maxHeaderSize = extractPParamUint(pparams, 4) ?? 1100;
    const maxBlockBodySize = extractPParamUint(pparams, 2) ?? 90112;

    const result: LedgerView = {
      epochNonce,
      poolVrfKeys,
      poolStake,
      totalStake: poolDistr.totalActiveStake,
      activeSlotsCoeff: slotClock.config.activeSlotsCoeff,
      maxKesEvolutions: 62,
      maxHeaderSize,
      maxBlockBodySize,
      ocertCounters,
    };
    return result;
  });

/**
 * Extract initial Nonces from a snapshot's ExtLedgerState.
 *
 * Reads the PraosChainDepState to get evolving, candidate, and epoch nonces.
 * Falls back to zeros if the chain dep state can't be decoded.
 */
export const extractNonces = (state: ExtLedgerState): Nonces => {
  const epoch = state.newEpochState.epoch;
  const praosNonces = extractPraosNonces(state.chainDepState);

  return new Nonces({
    active: praosNonces.epochNonce,
    evolving: praosNonces.evolvingNonce,
    candidate: praosNonces.candidateNonce,
    epoch,
  });
};

/**
 * Extract the snapshot tip as a consensus-compatible point (includes blockNo).
 */
export const extractSnapshotTip = (
  state: ExtLedgerState,
): { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined =>
  Option.isSome(state.tip) ? state.tip.value : undefined;

// ---------------------------------------------------------------------------
// Protocol parameter extraction from CBOR Map
// ---------------------------------------------------------------------------

/** Extract a uint value from a CBOR Map by numeric key. */
function extractPParamUint(pparams: CborSchemaType, key: number): number | undefined {
  if (pparams._tag !== CborKinds.Map) return undefined;
  for (const entry of pparams.entries) {
    if (
      entry.k._tag === CborKinds.UInt &&
      Number(entry.k.num) === key &&
      entry.v._tag === CborKinds.UInt
    ) {
      return Number(entry.v.num);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PraosChainDepState nonce extraction
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
interface PraosNonces {
  readonly evolvingNonce: Uint8Array;
  readonly candidateNonce: Uint8Array;
  readonly epochNonce: Uint8Array;
}

const ZERO_NONCE = new Uint8Array(32);

/** Decode a CBOR Nonce: Array(0) → zeros, Array(1,[bytes32]) → hash. */
function decodeNonce(cbor: CborSchemaType): Uint8Array {
  if (cbor._tag === CborKinds.Array) {
    if (cbor.items.length === 0) return ZERO_NONCE;
    if (cbor.items.length === 1) {
      const inner = cbor.items[0]!;
      if (inner._tag === CborKinds.Bytes && inner.bytes.length === 32) return inner.bytes;
    }
  }
  // Raw bytes (some encodings may use this)
  if (cbor._tag === CborKinds.Bytes && cbor.bytes.length === 32) return cbor.bytes;
  return ZERO_NONCE;
}

function extractPraosNonces(chainDepState: CborSchemaType): PraosNonces {
  // PraosChainDepState is a newtype over PraosState = Array(7)
  if (chainDepState._tag !== CborKinds.Array) {
    return { evolvingNonce: ZERO_NONCE, candidateNonce: ZERO_NONCE, epochNonce: ZERO_NONCE };
  }

  const items = chainDepState.items;
  if (items.length < 7) {
    return { evolvingNonce: ZERO_NONCE, candidateNonce: ZERO_NONCE, epochNonce: ZERO_NONCE };
  }

  return {
    evolvingNonce: decodeNonce(items[2]!),
    candidateNonce: decodeNonce(items[3]!),
    epochNonce: decodeNonce(items[4]!),
  };
}

function extractEpochNonceFromChainDepState(chainDepState: CborSchemaType): Uint8Array {
  return extractPraosNonces(chainDepState).epochNonce;
}

/**
 * Extract opcert counters from PraosState[1] (Map(KeyHash → Word64)).
 *
 * Per Haskell PraosState: index [1] is `praosStateOCertCounters :: Map (KeyHash BlockIssuer) Word64`.
 * The CBOR Map has 28-byte key hashes (blake2b-224 of pool cold VKey) and uint64 seqNo values.
 */
export function extractOcertCounters(
  chainDepState: CborSchemaType,
): HashMap.HashMap<string, number> {
  if (chainDepState._tag !== CborKinds.Array || chainDepState.items.length < 7) {
    return HashMap.empty();
  }
  const mapNode = chainDepState.items[1]!;
  if (mapNode._tag !== CborKinds.Map) return HashMap.empty();

  const entries: Array<readonly [string, number]> = [];
  for (const entry of mapNode.entries) {
    if (entry.k._tag === CborKinds.Bytes && entry.v._tag === CborKinds.UInt) {
      entries.push([hex(entry.k.bytes), Number(entry.v.num)] as const);
    }
  }
  return HashMap.fromIterable(entries);
}
