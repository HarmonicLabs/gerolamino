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
import { parseSync, skipCborItem, CborKinds, type CborSchemaType } from "codecs";
import type { BlockHeader as LedgerBlockHeader } from "ledger";
import { decodeMultiEraBlock, decodeMultiEraHeader, MultiEraHeader, isByronBlock } from "ledger";
import { BlockHeader as ConsensusBlockHeader } from "./validate-header";
import { CryptoService } from "./crypto";
import { concat } from "./util";
import type { Context } from "effect";

// ---------------------------------------------------------------------------
// Byte-offset helpers — extract original CBOR bytes without re-encoding
// ---------------------------------------------------------------------------

/**
 * Extract the first element of a CBOR array as a raw byte slice.
 * Skips the array header, then uses skipCborItem to find the end of the first item.
 * Returns a subarray of the original buffer (zero-copy).
 */
const extractFirstArrayItemBytes = (buf: Uint8Array): Uint8Array => {
  const headerByte = buf[0]!;
  const majorType = headerByte >> 5;
  if (majorType !== CborKinds.Array) throw new Error(`extractFirstArrayItemBytes: expected array, got major type ${majorType}`);
  const addInfo = headerByte & 0x1f;

  // Find where array items begin (past the array header)
  let itemsStart: number;
  if (addInfo < 24) itemsStart = 1;
  else if (addInfo === 24) itemsStart = 2;
  else if (addInfo === 25) itemsStart = 3;
  else if (addInfo === 26) itemsStart = 5;
  else if (addInfo === 27) itemsStart = 9;
  else throw new Error(`extractFirstArrayItemBytes: indefinite arrays not supported`);

  const firstItemEnd = skipCborItem(buf, itemsStart);
  return buf.subarray(itemsStart, firstItemEnd);
};

/**
 * Navigate into block CBOR to extract the original FULL header bytes.
 * Block = [era, [header, txBodies, ...]]
 * Returns the raw bytes of header = [headerBody, kesSig] without re-encoding.
 *
 * Used for hash computation: Shelley header hash = blake2b-256(entire header CBOR).
 */
const extractOriginalFullHeaderBytes = (
  blockCbor: Uint8Array,
  operation: string,
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.try({
    try: () => {
      let pos = 0;

      // Top-level array header [era, blockBody]
      if ((blockCbor[pos]! >> 5) !== CborKinds.Array) throw "block is not a CBOR array";
      pos = skipArrayHeader(blockCbor, pos);

      // Skip era (first element)
      pos = skipCborItem(blockCbor, pos);

      // blockBody array header [header, txBodies, ...]
      if ((blockCbor[pos]! >> 5) !== CborKinds.Array) throw "blockBody is not a CBOR array";
      pos = skipArrayHeader(blockCbor, pos);

      // Extract the full header item (= first element of blockBody)
      const headerStart = pos;
      const headerEnd = skipCborItem(blockCbor, headerStart);
      return blockCbor.subarray(headerStart, headerEnd);
    },
    catch: (cause) => new HeaderBridgeError({ operation, cause: String(cause) }),
  });

/**
 * Navigate into block CBOR to extract the original header BODY bytes.
 * Block = [era, [header, ...]], Header = [headerBody, kesSig]
 * Returns the raw bytes of headerBody only (for KES signature verification).
 */
const extractOriginalHeaderBodyBytes = (
  blockCbor: Uint8Array,
  operation: string,
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.try({
    try: () => {
      let pos = 0;

      // Top-level array header [era, blockBody]
      if ((blockCbor[pos]! >> 5) !== CborKinds.Array) throw "block is not a CBOR array";
      pos = skipArrayHeader(blockCbor, pos);

      // Skip era (first element)
      pos = skipCborItem(blockCbor, pos);

      // blockBody array header [header, txBodies, ...]
      if ((blockCbor[pos]! >> 5) !== CborKinds.Array) throw "blockBody is not a CBOR array";
      pos = skipArrayHeader(blockCbor, pos);

      // header array header [headerBody, kesSig]
      if ((blockCbor[pos]! >> 5) !== CborKinds.Array) throw "header is not a CBOR array";
      const headerBodyStart = skipArrayHeader(blockCbor, pos);
      const headerBodyEnd = skipCborItem(blockCbor, headerBodyStart);
      return blockCbor.subarray(headerBodyStart, headerBodyEnd);
    },
    catch: (cause) => new HeaderBridgeError({ operation, cause: String(cause) }),
  });

/**
 * Skip past a CBOR array header, returning the offset of the first item.
 * Only supports definite-length arrays.
 */
const skipArrayHeader = (buf: Uint8Array, offset: number): number => {
  const addInfo = buf[offset]! & 0x1f;
  if (addInfo < 24) return offset + 1;
  if (addInfo === 24) return offset + 2;
  if (addInfo === 25) return offset + 3;
  if (addInfo === 26) return offset + 5;
  if (addInfo === 27) return offset + 9;
  throw new Error(`skipArrayHeader: indefinite arrays not supported`);
};

/** Typed error for header bridge decode/bridge failures. */
export class HeaderBridgeError extends Schema.TaggedErrorClass<HeaderBridgeError>()(
  "HeaderBridgeError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Slots per KES period — configurable via CARDANO_SLOTS_PER_KES_PERIOD, defaults to 129600. */
const SlotsPerKesPeriod = Effect.gen(function* () {
  return yield* Config.number("CARDANO_SLOTS_PER_KES_PERIOD").pipe(Config.withDefault(129600));
}).pipe(Effect.orDie);

/** Byron epoch length — configurable via CARDANO_BYRON_EPOCH_LENGTH, defaults to 21600 (= 10k). */
const ByronEpochLength = Effect.gen(function* () {
  return yield* Config.number("CARDANO_BYRON_EPOCH_LENGTH").pipe(Config.withDefault(21600));
}).pipe(Effect.orDie);

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
 * Extract the raw CBOR-encoded header from block CBOR bytes
 * and compute its blake2b-256 hash.
 *
 * Block structure: [era, [header, txBodies, witnesses, auxData, ...]]
 * Header structure: [headerBody, kesSignature]
 * Hash = blake2b-256(ENTIRE header = [headerBody, kesSig])
 *
 * Per Haskell MemoBytes pattern: bhHash hashes the full BHeader (body + KES sig),
 * not just the body. Uses byte-offset slicing to preserve original CBOR bytes.
 */
export const computeHeaderHash = (
  blockCbor: Uint8Array,
  crypto: { blake2b256: (data: Uint8Array) => Uint8Array },
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.gen(function* () {
    const fullHeaderCbor = yield* extractOriginalFullHeaderBytes(blockCbor, "computeHeaderHash");
    return crypto.blake2b256(fullHeaderCbor);
  });

/**
 * Compute header hash from raw header CBOR bytes (as from ChainSync).
 * Header structure: [headerBody, kesSignature]
 * Hash = blake2b-256(ENTIRE header CBOR)
 *
 * Per Haskell MemoBytes pattern: bhHash hashes the full BHeader (body + KES sig).
 */
export const computeHeaderHashFromHeader = (
  headerCbor: Uint8Array,
  crypto: { blake2b256: (data: Uint8Array) => Uint8Array },
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.succeed(crypto.blake2b256(headerCbor));

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
    bodySize: Number(ledgerHeader.bodySize),
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
      slot: h.slot,
      blockNo: h.blockNo,
      hash: headerHash,
      prevHash: h.prevHash ?? new Uint8Array(32),
      issuerVk: h.issuerVKey,
      vrfVk: h.vrfVKey,
      vrfProof: h.vrfResult.proof,
      vrfOutput: h.vrfResult.output,
      nonceVrfOutput: h.nonceVrf.output,
      kesSig: h.kesSignature,
      kesPeriod: Math.floor(Number(h.slot) / slotsPerKesPeriod),
      opcertSig: h.opCert.sigma,
      opcertVkHot: h.opCert.hotVKey,
      opcertSeqNo: Number(h.opCert.seqNo),
      opcertKesPeriod: Number(h.opCert.kesPeriod),
      bodyHash: h.bodyHash,
      bodySize: Number(h.bodySize),
      headerBodyCbor,
    });
  }

  if (isBabbageLikeHeader(multiEraHeader)) {
    const h = multiEraHeader;
    return Effect.succeed({
      slot: h.slot,
      blockNo: h.blockNo,
      hash: headerHash,
      prevHash: h.prevHash ?? new Uint8Array(32),
      issuerVk: h.issuerVKey,
      vrfVk: h.vrfVKey,
      vrfProof: h.vrfResult.proof,
      vrfOutput: blake2b256(concat(new Uint8Array([0x4c]), h.vrfResult.output)),
      nonceVrfOutput: blake2b256(concat(new Uint8Array([0x4e]), h.vrfResult.output)),
      kesSig: h.kesSignature,
      kesPeriod: Math.floor(Number(h.slot) / slotsPerKesPeriod),
      opcertSig: h.opCert.sigma,
      opcertVkHot: h.opCert.hotVKey,
      opcertSeqNo: Number(h.opCert.seqNo),
      opcertKesPeriod: Number(h.opCert.kesPeriod),
      bodyHash: h.bodyHash,
      bodySize: Number(h.bodySize),
      headerBodyCbor,
    });
  }

  return Effect.fail(new HeaderBridgeError({
    operation: "bridgeMultiEraHeader",
    cause: "Byron headers should use the Byron path",
  }));
};

/**
 * Decode block CBOR and produce a consensus BlockHeader.
 * Returns undefined for Byron blocks (skip consensus validation).
 * Reads CARDANO_SLOTS_PER_KES_PERIOD from Config (default 129600).
 */
export const decodeAndBridge = (blockCbor: Uint8Array, headerHash: Uint8Array) =>
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
      return yield* new HeaderBridgeError({
        operation: "decodeAndBridge",
        cause: "Invalid block CBOR",
      });
    const blockBody = top.items[1];
    if (!blockBody || blockBody._tag !== CborKinds.Array)
      return yield* new HeaderBridgeError({
        operation: "decodeAndBridge",
        cause: "Invalid block body",
      });
    const headerNode = blockBody.items[0];
    if (!headerNode || headerNode._tag !== CborKinds.Array)
      return yield* new HeaderBridgeError({
        operation: "decodeAndBridge",
        cause: "Invalid header",
      });
    // Extract original header body bytes via byte-offset slicing (MemoBytes pattern)
    const headerBodyCbor = yield* extractOriginalHeaderBodyBytes(blockCbor, "decodeAndBridge");

    const header = yield* bridgeMultiEraHeader(
      block.multiEraHeader,
      headerHash,
      headerBodyCbor,
      crypto.blake2b256,
      slotsPerKesPeriod,
    );
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
  /** Byron subtag from ChainSync byronPrefix[0] (0=EBB, 1=main). When provided,
   *  used directly for hash computation instead of re-deriving from consensus data. */
  byronSubtag?: number,
): Effect.Effect<DecodedHeader, HeaderBridgeError, CryptoService> =>
  Effect.gen(function* () {
    const slotsPerKesPeriod = yield* SlotsPerKesPeriod;
    const byronEpochLength = yield* ByronEpochLength;
    const crypto = yield* CryptoService;

    // Byron (N2N variant 0) — decode via Byron-specific path
    if (eraVariant === 0) {
      return yield* decodeByronWrappedHeader(headerBytes, byronEpochLength, crypto, byronSubtag);
    }

    // Shelley+ (N2N variant 1-6) — headerBytes = [headerBody, kesSig]
    const parsed = parseSync(headerBytes);

    // Handle potential Tag(24) wrapping — some paths may still have it
    let headerNode: CborSchemaType;
    if (
      parsed._tag === CborKinds.Tag &&
      parsed.tag === 24n &&
      parsed.data._tag === CborKinds.Bytes
    ) {
      headerNode = parseSync(parsed.data.bytes);
    } else {
      headerNode = parsed;
    }

    if (headerNode._tag !== CborKinds.Array || headerNode.items.length < 2)
      return yield* new HeaderBridgeError({
        operation: "decodeWrappedHeader",
        cause: `Invalid Shelley+ header: expected [headerBody, kesSig], got ${headerNode._tag} with ${headerNode._tag === CborKinds.Array ? headerNode.items.length : 0} items`,
      });

    // Map N2N era variant to ledger era: N2N 1→Shelley(2), 2→Allegra(3), etc.
    const ledgerEra = eraVariant + 1;
    const multiEraHeader = yield* Effect.mapError(
      decodeMultiEraHeader(headerNode, ledgerEra),
      (issue) =>
        new HeaderBridgeError({
          operation: "decodeWrappedHeader",
          cause: `Header decode failed: ${String(issue)}`,
        }),
    );

    // Header hash = blake2b-256(ENTIRE header CBOR = [headerBody, kesSig])
    // Per Haskell MemoBytes: bhHash hashes the full BHeader, not just the body.
    // Use the raw bytes from the wire to preserve original CBOR encoding.
    const rawHeaderBytes = (
      parsed._tag === CborKinds.Tag &&
      parsed.tag === 24n &&
      parsed.data._tag === CborKinds.Bytes
    ) ? parsed.data.bytes : headerBytes;
    const headerHash = crypto.blake2b256(rawHeaderBytes);
    // Extract just the header body bytes for KES signature verification.
    const headerBodyCbor = extractFirstArrayItemBytes(rawHeaderBytes);

    const header = yield* bridgeMultiEraHeader(
      multiEraHeader,
      headerHash,
      headerBodyCbor,
      crypto.blake2b256,
      slotsPerKesPeriod,
    );
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
  crypto: Context.Service.Shape<typeof CryptoService>,
  /** Authoritative subtag from ChainSync byronPrefix (0=EBB, 1=main).
   *  Falls back to heuristic detection via consensus_data array length. */
  authoritativeSubtag?: number,
): Effect.Effect<ByronHeaderInfo, HeaderBridgeError> =>
  Effect.gen(function* () {
    const parsed = parseSync(headerBytes);
    if (parsed._tag !== CborKinds.Array || parsed.items.length < 4)
      return yield* new HeaderBridgeError({
        operation: "decodeByronHeader",
        cause: `Invalid Byron header: expected 5-element array, got ${parsed._tag}`,
      });

    // prevHash is always at index 1
    const prevHashNode = parsed.items[1]!;
    const prevHash =
      prevHashNode._tag === CborKinds.Bytes ? prevHashNode.bytes : new Uint8Array(32);

    // consensusData is at index 3
    const consensusData = parsed.items[3]!;
    if (consensusData._tag !== CborKinds.Array)
      return yield* new HeaderBridgeError({
        operation: "decodeByronHeader",
        cause: "Byron header: consensus_data is not an array",
      });

    // Prefer authoritative subtag from ChainSync protocol when available.
    // Fall back to heuristic: EBB consensus_data has 2 items, main has 4.
    const isEbb = authoritativeSubtag !== undefined
      ? authoritativeSubtag === 0
      : consensusData.items.length === 2;

    let slot: bigint;
    let blockNo: bigint;

    if (isEbb) {
      // EBB: consensus_data = [epochId: uint, difficulty: [uint]]
      const epochNode = consensusData.items[0]!;
      if (epochNode._tag !== CborKinds.UInt)
        return yield* new HeaderBridgeError({
          operation: "decodeByronHeader",
          cause: "Byron EBB: epochId is not uint",
        });

      const epoch = epochNode.num;
      slot = epoch * BigInt(byronEpochLength);

      // Difficulty = [uint] — the block number
      const diffNode = consensusData.items[1]!;
      if (
        diffNode._tag === CborKinds.Array &&
        diffNode.items.length > 0 &&
        diffNode.items[0]!._tag === CborKinds.UInt
      ) {
        blockNo = diffNode.items[0]!.num;
      } else {
        blockNo = 0n;
      }
    } else {
      // Main block: consensus_data = [slotId, pubKey, difficulty, blockSig]
      // slotId = [epoch: uint, slot_in_epoch: uint]
      const slotIdNode = consensusData.items[0]!;
      if (slotIdNode._tag !== CborKinds.Array || slotIdNode.items.length < 2)
        return yield* new HeaderBridgeError({
          operation: "decodeByronHeader",
          cause: "Byron main: slotId is not [epoch, slot]",
        });

      const epochNode = slotIdNode.items[0]!;
      const slotInEpochNode = slotIdNode.items[1]!;
      if (epochNode._tag !== CborKinds.UInt || slotInEpochNode._tag !== CborKinds.UInt)
        return yield* new HeaderBridgeError({
          operation: "decodeByronHeader",
          cause: "Byron main: epoch/slot not uint",
        });

      slot = epochNode.num * BigInt(byronEpochLength) + slotInEpochNode.num;

      // Difficulty (index 2) = [uint]
      const diffNode = consensusData.items[2]!;
      if (
        diffNode._tag === CborKinds.Array &&
        diffNode.items.length > 0 &&
        diffNode.items[0]!._tag === CborKinds.UInt
      ) {
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
