/**
 * Header bridge — converts ledger BlockHeader to consensus BlockHeader.
 *
 * The ledger package decodes raw CBOR into a rich BlockHeader schema.
 * The consensus package needs a flattened BlockHeader interface for validation.
 * This module bridges the two.
 *
 * Two entry points:
 *   - `decodeAndBridge`: for full block CBOR (from BlockFetch or ImmutableDB)
 *   - `decodeWrappedHeader`: for N2N ChainSync wrapped headers
 */
import { Config, Effect, Schema } from "effect";
import { parseSync, encodeSync, CborKinds, type CborSchemaType } from "cbor-schema";
import type { BlockHeader as LedgerBlockHeader } from "ledger";
import { decodeMultiEraBlock, decodeMultiEraHeader, MultiEraHeader, isByronBlock } from "ledger";
import { BlockHeader as ConsensusBlockHeader } from "./validate-header";
import { CryptoService } from "./crypto";
import { concat } from "./util";
import type { ServiceMap } from "effect";

/** Typed error for header bridge decode/bridge failures. */
export class HeaderBridgeError extends Schema.TaggedErrorClass<HeaderBridgeError>()(
  "HeaderBridgeError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Slots per KES period — configurable via CARDANO_SLOTS_PER_KES_PERIOD, defaults to 129600. */
const SlotsPerKesPeriod = Config.number("CARDANO_SLOTS_PER_KES_PERIOD").pipe(
  Config.withDefault(129600),
);

/** Byron epoch length — configurable via CARDANO_BYRON_EPOCH_LENGTH, defaults to 21600 (= 10k). */
const ByronEpochLength = Config.number("CARDANO_BYRON_EPOCH_LENGTH").pipe(
  Config.withDefault(21600),
);

// ---------------------------------------------------------------------------
// DecodedHeader — Schema tagged union for Byron vs Shelley+ headers
// ---------------------------------------------------------------------------

/** Byron header fields — no Praos validation needed (Ouroboros Classic). */
export const ByronHeaderInfo = Schema.TaggedStruct("byron", {
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
  prevHash: Schema.Uint8Array,
  era: Schema.Literal(0),
  /** Whether this is an Epoch Boundary Block (subtag 0). */
  isEbb: Schema.Boolean,
});
export type ByronHeaderInfo = typeof ByronHeaderInfo.Type;

/** Shelley+ decoded header — full Praos validation. */
export const ShelleyHeaderInfo = Schema.TaggedStruct("shelley", {
  header: ConsensusBlockHeader,
  era: Schema.Number,
});
export type ShelleyHeaderInfo = typeof ShelleyHeaderInfo.Type;

/** Result of decoding an N2N ChainSync header. */
export const DecodedHeader = Schema.Union([ByronHeaderInfo, ShelleyHeaderInfo]).pipe(
  Schema.toTaggedUnion("_tag"),
);
export type DecodedHeader = typeof DecodedHeader.Type;

/**
 * Extract the raw CBOR-encoded header body from block CBOR bytes
 * and compute its blake2b-256 hash.
 *
 * Block structure: [era, [header, txBodies, witnesses, auxData, ...]]
 * Header structure: [headerBody, kesSignature]
 * Hash = blake2b-256(CBOR(headerBody))
 */
export const computeHeaderHash = (
  blockCbor: Uint8Array,
  crypto: { blake2b256: (data: Uint8Array) => Uint8Array },
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.gen(function* () {
    const top = parseSync(blockCbor);
    if (top._tag !== CborKinds.Array || top.items.length < 2)
      return yield* new HeaderBridgeError({ operation: "computeHeaderHash", cause: "Invalid block CBOR: expected [era, blockBody]" });

    const blockBody = top.items[1]!;
    if (blockBody._tag !== CborKinds.Array || blockBody.items.length < 1)
      return yield* new HeaderBridgeError({ operation: "computeHeaderHash", cause: "Invalid block body: expected array" });

    const header = blockBody.items[0]!;
    if (header._tag !== CborKinds.Array || header.items.length < 2)
      return yield* new HeaderBridgeError({ operation: "computeHeaderHash", cause: "Invalid header: expected [headerBody, kesSig]" });

    const headerBody = header.items[0]!;
    return crypto.blake2b256(encodeSync(headerBody));
  });

/**
 * Compute header hash from raw header CBOR bytes (as from ChainSync).
 * Header structure: [headerBody, kesSignature]
 * Hash = blake2b-256(CBOR(headerBody))
 */
export const computeHeaderHashFromHeader = (
  headerCbor: Uint8Array,
  crypto: { blake2b256: (data: Uint8Array) => Uint8Array },
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.gen(function* () {
    const parsed = parseSync(headerCbor);
    if (parsed._tag !== CborKinds.Array || parsed.items.length < 2)
      return yield* new HeaderBridgeError({ operation: "computeHeaderHashFromHeader", cause: "Invalid header CBOR: expected [headerBody, kesSig]" });

    const headerBody = parsed.items[0]!;
    return crypto.blake2b256(encodeSync(headerBody));
  });

/**
 * Bridge a ledger BlockHeader to a consensus BlockHeader.
 *
 * @param ledgerHeader - Decoded header from the ledger package
 * @param headerHash - 32-byte header hash (from computeHeaderHash or chunk index)
 * @param slotsPerKesPeriod - Slots per KES period (default 129600)
 */
export const bridgeHeader = (
  ledgerHeader: LedgerBlockHeader,
  headerHash: Uint8Array,
  headerBodyCbor: Uint8Array,
  blake2b256: (data: Uint8Array) => Uint8Array,
  slotsPerKesPeriod = 129600,
): ConsensusBlockHeader => {
  const base = {
    slot: ledgerHeader.slot,
    blockNo: ledgerHeader.blockNo,
    hash: headerHash,
    prevHash: ledgerHeader.prevHash ?? new Uint8Array(32),
    issuerVk: ledgerHeader.issuerVKey,
    vrfVk: ledgerHeader.vrfVKey,
    vrfProof: ledgerHeader.vrfResult.proof,
    kesSig: ledgerHeader.kesSignature,
    kesPeriod: Math.floor(Number(ledgerHeader.slot) / slotsPerKesPeriod),
    opcertSig: ledgerHeader.opCert.sigma,
    opcertVkHot: ledgerHeader.opCert.hotVKey,
    opcertSeqNo: Number(ledgerHeader.opCert.seqNo),
    opcertKesPeriod: Number(ledgerHeader.opCert.kesPeriod),
    bodyHash: ledgerHeader.bodyHash,
    headerBodyCbor,
  };

  // Pre-Babbage: separate leaderVrf and nonceVrf with raw outputs.
  if (ledgerHeader.nonceVrf !== undefined) {
    return {
      ...base,
      vrfOutput: ledgerHeader.vrfResult.output,
      nonceVrfOutput: ledgerHeader.nonceVrf.output,
    };
  }

  // Babbage+: single VRF proof — derive tagged outputs.
  // Leader = blake2b-256(0x4c ∥ proofHash), Nonce = blake2b-256(0x4e ∥ proofHash)
  return {
    ...base,
    vrfOutput: blake2b256(concat(new Uint8Array([0x4c]), ledgerHeader.vrfResult.output)),
    nonceVrfOutput: blake2b256(concat(new Uint8Array([0x4e]), ledgerHeader.vrfResult.output)),
  };
};

/** Type guards for grouping MultiEraHeader variants. */
const isShelleyLikeHeader = MultiEraHeader.isAnyOf(["shelley", "allegra", "mary", "alonzo"]);
const isBabbageLikeHeader = MultiEraHeader.isAnyOf(["babbage", "conway"]);

/**
 * Bridge a MultiEraHeader (tagged union) to a consensus BlockHeader.
 * Only handles Shelley+ variants — Byron headers return via the separate Byron path.
 */
export const bridgeMultiEraHeader = (
  multiEraHeader: MultiEraHeader,
  headerHash: Uint8Array,
  headerBodyCbor: Uint8Array,
  blake2b256: (data: Uint8Array) => Uint8Array,
  slotsPerKesPeriod = 129600,
): Effect.Effect<ConsensusBlockHeader, HeaderBridgeError> => {
  if (isShelleyLikeHeader(multiEraHeader)) {
    const h = multiEraHeader;
    return Effect.succeed({
      slot: h.slot, blockNo: h.blockNo, hash: headerHash,
      prevHash: h.prevHash ?? new Uint8Array(32),
      issuerVk: h.issuerVKey, vrfVk: h.vrfVKey,
      vrfProof: h.vrfResult.proof, vrfOutput: h.vrfResult.output,
      nonceVrfOutput: h.nonceVrf.output,
      kesSig: h.kesSignature, kesPeriod: Math.floor(Number(h.slot) / slotsPerKesPeriod),
      opcertSig: h.opCert.sigma, opcertVkHot: h.opCert.hotVKey,
      opcertSeqNo: Number(h.opCert.seqNo), opcertKesPeriod: Number(h.opCert.kesPeriod),
      bodyHash: h.bodyHash, headerBodyCbor,
    });
  }

  if (isBabbageLikeHeader(multiEraHeader)) {
    const h = multiEraHeader;
    return Effect.succeed({
      slot: h.slot, blockNo: h.blockNo, hash: headerHash,
      prevHash: h.prevHash ?? new Uint8Array(32),
      issuerVk: h.issuerVKey, vrfVk: h.vrfVKey,
      vrfProof: h.vrfResult.proof,
      vrfOutput: blake2b256(concat(new Uint8Array([0x4c]), h.vrfResult.output)),
      nonceVrfOutput: blake2b256(concat(new Uint8Array([0x4e]), h.vrfResult.output)),
      kesSig: h.kesSignature, kesPeriod: Math.floor(Number(h.slot) / slotsPerKesPeriod),
      opcertSig: h.opCert.sigma, opcertVkHot: h.opCert.hotVKey,
      opcertSeqNo: Number(h.opCert.seqNo), opcertKesPeriod: Number(h.opCert.kesPeriod),
      bodyHash: h.bodyHash, headerBodyCbor,
    });
  }

  return new HeaderBridgeError({ operation: "bridgeMultiEraHeader", cause: "Byron headers should use the Byron path" });
};

/**
 * Decode block CBOR and produce a consensus BlockHeader.
 * Returns undefined for Byron blocks (skip consensus validation).
 * Reads CARDANO_SLOTS_PER_KES_PERIOD from Config (default 129600).
 */
export const decodeAndBridge = (
  blockCbor: Uint8Array,
  headerHash: Uint8Array,
) =>
  Effect.gen(function* () {
    const slotsPerKesPeriod = yield* SlotsPerKesPeriod;
    const crypto = yield* CryptoService;
    const block = yield* decodeMultiEraBlock(blockCbor);
    if (isByronBlock(block)) {
      return undefined;
    }

    // Extract raw header body CBOR for KES signing verification.
    // Block = [era, [header, txBodies, witnesses, auxData, ...]]
    // Header = [headerBody, kesSig]
    const top = parseSync(blockCbor);
    if (top._tag !== CborKinds.Array)
      return yield* new HeaderBridgeError({ operation: "decodeAndBridge", cause: "Invalid block CBOR" });
    const blockBody = top.items[1];
    if (!blockBody || blockBody._tag !== CborKinds.Array)
      return yield* new HeaderBridgeError({ operation: "decodeAndBridge", cause: "Invalid block body" });
    const headerNode = blockBody.items[0];
    if (!headerNode || headerNode._tag !== CborKinds.Array)
      return yield* new HeaderBridgeError({ operation: "decodeAndBridge", cause: "Invalid header" });
    const headerBodyCbor = encodeSync(headerNode.items[0]!);

    const header = yield* bridgeMultiEraHeader(block.multiEraHeader, headerHash, headerBodyCbor, crypto.blake2b256, slotsPerKesPeriod);
    return { header, era: block.era, txCount: block.txBodies.length };
  });

/**
 * Decode a N2N ChainSync header and produce a consensus BlockHeader.
 *
 * After ChainSync schema extraction, headerBytes contain the raw CBOR:
 *   - Byron (eraVariant 0): raw Byron header (5-element array)
 *   - Shelley+ (eraVariant 1+): [headerBody, kesSig]
 *
 * The eraVariant is the N2N hard-fork combinator index (0-6), distinct
 * from ledger era tags (0-7). Mapping: N2N 0→Byron, 1→Shelley(2), 2→Allegra(3), etc.
 *
 * Returns undefined only if decoding fails for an expected reason.
 */
export const decodeWrappedHeader = (
  headerBytes: Uint8Array,
  eraVariant: number,
): Effect.Effect<DecodedHeader, HeaderBridgeError, CryptoService> =>
  Effect.gen(function* () {
    const slotsPerKesPeriod = yield* SlotsPerKesPeriod;
    const byronEpochLength = yield* ByronEpochLength;
    const crypto = yield* CryptoService;

    // Byron (N2N variant 0) — decode via Byron-specific path
    if (eraVariant === 0) {
      return yield* decodeByronWrappedHeader(headerBytes, byronEpochLength, crypto);
    }

    // Shelley+ (N2N variant 1-6) — headerBytes = [headerBody, kesSig]
    const parsed = parseSync(headerBytes);

    // Handle potential Tag(24) wrapping — some paths may still have it
    let headerNode: CborSchemaType;
    if (parsed._tag === CborKinds.Tag && parsed.tag === 24n && parsed.data._tag === CborKinds.Bytes) {
      headerNode = parseSync(parsed.data.bytes);
    } else {
      headerNode = parsed;
    }

    if (headerNode._tag !== CborKinds.Array || headerNode.items.length < 2)
      return yield* new HeaderBridgeError({ operation: "decodeWrappedHeader", cause: `Invalid Shelley+ header: expected [headerBody, kesSig], got ${headerNode._tag} with ${headerNode._tag === CborKinds.Array ? headerNode.items.length : 0} items` });

    // Map N2N era variant to ledger era: N2N 1→Shelley(2), 2→Allegra(3), etc.
    const ledgerEra = eraVariant + 1;
    const multiEraHeader = yield* Effect.mapError(
      decodeMultiEraHeader(headerNode, ledgerEra),
      (issue) => new HeaderBridgeError({ operation: "decodeWrappedHeader", cause: `Header decode failed: ${String(issue)}` }),
    );

    // Header hash = blake2b-256(CBOR(headerBody))
    const headerBodyCbor = encodeSync(headerNode.items[0]!);
    const headerHash = crypto.blake2b256(headerBodyCbor);

    const header = yield* bridgeMultiEraHeader(multiEraHeader, headerHash, headerBodyCbor, crypto.blake2b256, slotsPerKesPeriod);
    return {
      _tag: "shelley" as const,
      header,
      era: ledgerEra,
    };
  });

// ---------------------------------------------------------------------------
// Byron header decoding
// ---------------------------------------------------------------------------

/**
 * Decode a Byron header from raw CBOR bytes.
 *
 * Byron headers come in two flavors distinguished by the N2N byronPrefix subtag:
 *   - EBB (subtag 0): Epoch Boundary Block — 5-element array, consensus_data = [epochId, difficulty]
 *   - Main block (subtag 1): Regular block — 5-element array, consensus_data = [slotId, pubKey, difficulty, blockSig]
 *
 * Since the subtag is stripped before we get the raw bytes, we distinguish by
 * examining the consensus_data (index 3): EBB has 2 items, main has 4 items.
 *
 * Hash computation:
 *   - EBB:  blake2b-256(0x82 0x00 ∥ rawHeaderCbor)
 *   - Main: blake2b-256(0x82 0x01 ∥ rawHeaderCbor)
 */
const decodeByronWrappedHeader = (
  headerBytes: Uint8Array,
  byronEpochLength: number,
  crypto: ServiceMap.Service.Shape<typeof CryptoService>,
): Effect.Effect<ByronHeaderInfo, HeaderBridgeError> =>
  Effect.gen(function* () {
    const parsed = parseSync(headerBytes);
    if (parsed._tag !== CborKinds.Array || parsed.items.length < 4)
      return yield* new HeaderBridgeError({ operation: "decodeByronHeader", cause: `Invalid Byron header: expected 5-element array, got ${parsed._tag}` });

    // prevHash is always at index 1
    const prevHashNode = parsed.items[1]!;
    const prevHash = prevHashNode._tag === CborKinds.Bytes
      ? prevHashNode.bytes
      : new Uint8Array(32);

    // consensusData is at index 3
    const consensusData = parsed.items[3]!;
    if (consensusData._tag !== CborKinds.Array)
      return yield* new HeaderBridgeError({ operation: "decodeByronHeader", cause: "Byron header: consensus_data is not an array" });

    const isEbb = consensusData.items.length === 2;

    let slot: bigint;
    let blockNo: bigint;

    if (isEbb) {
      // EBB: consensus_data = [epochId: uint, difficulty: [uint]]
      const epochNode = consensusData.items[0]!;
      if (epochNode._tag !== CborKinds.UInt)
        return yield* new HeaderBridgeError({ operation: "decodeByronHeader", cause: "Byron EBB: epochId is not uint" });

      const epoch = epochNode.num;
      slot = epoch * BigInt(byronEpochLength);

      // Difficulty = [uint] — the block number
      const diffNode = consensusData.items[1]!;
      if (diffNode._tag === CborKinds.Array && diffNode.items.length > 0 && diffNode.items[0]!._tag === CborKinds.UInt) {
        blockNo = diffNode.items[0]!.num;
      } else {
        blockNo = 0n;
      }
    } else {
      // Main block: consensus_data = [slotId, pubKey, difficulty, blockSig]
      // slotId = [epoch: uint, slot_in_epoch: uint]
      const slotIdNode = consensusData.items[0]!;
      if (slotIdNode._tag !== CborKinds.Array || slotIdNode.items.length < 2)
        return yield* new HeaderBridgeError({ operation: "decodeByronHeader", cause: "Byron main: slotId is not [epoch, slot]" });

      const epochNode = slotIdNode.items[0]!;
      const slotInEpochNode = slotIdNode.items[1]!;
      if (epochNode._tag !== CborKinds.UInt || slotInEpochNode._tag !== CborKinds.UInt)
        return yield* new HeaderBridgeError({ operation: "decodeByronHeader", cause: "Byron main: epoch/slot not uint" });

      slot = epochNode.num * BigInt(byronEpochLength) + slotInEpochNode.num;

      // Difficulty (index 2) = [uint]
      const diffNode = consensusData.items[2]!;
      if (diffNode._tag === CborKinds.Array && diffNode.items.length > 0 && diffNode.items[0]!._tag === CborKinds.UInt) {
        blockNo = diffNode.items[0]!.num;
      } else {
        blockNo = 0n;
      }
    }

    // Byron header hash: blake2b-256(CBOR([subtag, rawHeader]))
    // This is equivalent to: blake2b-256(0x82 ∥ CBOR(subtag) ∥ rawHeaderBytes)
    const subtag = isEbb ? 0x00 : 0x01;
    const hashInput = concat(new Uint8Array([0x82, subtag]), headerBytes);
    const hash = crypto.blake2b256(hashInput);

    return {
      _tag: "byron" as const,
      slot,
      blockNo,
      hash,
      prevHash,
      era: 0 as const,
      isEbb,
    };
  });
