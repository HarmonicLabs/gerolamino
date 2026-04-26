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
import { Config, Context, Effect, Schema } from "effect";
import { CborKinds, type CborSchemaType, CborValue, parseSync, skipCborItem } from "codecs";
import type { BlockHeader as LedgerBlockHeader } from "ledger";
import {
  decodeMultiEraBlock,
  decodeMultiEraHeader,
  isBabbageLikeHeader,
  isByronBlock,
  isShelleyLikeHeader,
  type MultiEraHeader,
} from "ledger";
import { Crypto, type CryptoOpError } from "wasm-utils";
import { BlockHeader as ConsensusBlockHeader } from "../validate/header";
import { concat } from "../util";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default slots-per-KES-period (mainnet / preprod); overridable via Config. */
const DEFAULT_SLOTS_PER_KES_PERIOD = 129600;

/** Default Byron epoch length (= 10k blocks); overridable via Config. */
const DEFAULT_BYRON_EPOCH_LENGTH = 21600;

/** VRF output tagging (Babbage+): `blake2b256(0x4c ∥ proof)` = leader,
 *  `blake2b256(0x4e ∥ proof)` = nonce. ASCII 'L' / 'N' per Haskell
 *  `Praos/VRF.hs:108-109`. */
const VRF_LEADER_TAG = 0x4c;
const VRF_NONCE_TAG = 0x4e;

/** Byron header-hash subtag: 0 = EBB, 1 = main block.
 *  Hash = `blake2b256(0x82 ∥ subtag ∥ rawHeaderBytes)`. */
const BYRON_EBB_SUBTAG = 0x00;
const BYRON_MAIN_SUBTAG = 0x01;

/** Pre-allocated `[0x82, subtag]` 2-byte prefixes for the Byron header-hash
 *  computation — picked once per block in `decodeByronWrappedHeader`, so a
 *  single module-level allocation beats `new Uint8Array(2)` per call. */
const BYRON_EBB_HASH_PREFIX = new Uint8Array([0x82, BYRON_EBB_SUBTAG]);
const BYRON_MAIN_HASH_PREFIX = new Uint8Array([0x82, BYRON_MAIN_SUBTAG]);

/** Shared "no prev hash" sentinel (genesis block or missing predecessor). */
const EMPTY_PREV_HASH = new Uint8Array(32);

// ---------------------------------------------------------------------------
// CBOR byte-offset helpers
// ---------------------------------------------------------------------------

/**
 * Byte width of a CBOR major-type header given its `additionalInfo` byte.
 * Returns `undefined` for indefinite-length (0x1f) and reserved values
 * (28-30) — Cardano block / header envelopes never use these.
 *
 * Per RFC 8949 §3:
 *   addInfo 0-23  → inline length (1 byte total)
 *   addInfo 24-27 → `1 + 2^(addInfo − 24)` bytes total (2, 3, 5, 9)
 */
const cborHeaderByteWidth = (addInfo: number): number | undefined => {
  if (addInfo < 24) return 1;
  if (addInfo <= 27) return 1 + 2 ** (addInfo - 24);
  return undefined;
};

/** Top-level CBOR major type (top 3 bits of the initial byte). */
const cborMajorType = (initialByte: number): number => initialByte >> 5;

/**
 * Extract the first element of a CBOR array as a raw byte slice.
 * Skips the array header, then uses `skipCborItem` to find the end of
 * the first item. Zero-copy — returns a `subarray` view of `buf`.
 */
const extractFirstArrayItemBytes = (
  buf: Uint8Array,
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.gen(function* () {
    const initial = buf[0]!;
    if (cborMajorType(initial) !== CborKinds.Array)
      return yield* new HeaderBridgeError({
        operation: "extractFirstArrayItemBytes",
        cause: `expected array, got major type ${cborMajorType(initial)}`,
      });
    const itemsStart = cborHeaderByteWidth(initial & 0x1f);
    if (itemsStart === undefined)
      return yield* new HeaderBridgeError({
        operation: "extractFirstArrayItemBytes",
        cause: "indefinite arrays not supported",
      });
    return buf.subarray(itemsStart, skipCborItem(buf, itemsStart));
  });

/**
 * Skip past a CBOR array header, returning the offset of the first item.
 * Fails with `HeaderBridgeError` for indefinite-length arrays (not a
 * protocol shape Cardano uses for block / header envelopes).
 */
const skipArrayHeader = (
  buf: Uint8Array,
  offset: number,
  operation: HeaderBridgeOperation,
): Effect.Effect<number, HeaderBridgeError> => {
  const width = cborHeaderByteWidth(buf[offset]! & 0x1f);
  return width === undefined
    ? Effect.fail(new HeaderBridgeError({ operation, cause: "indefinite arrays not supported" }))
    : Effect.succeed(offset + width);
};

/** Assert `buf[offset]` starts a CBOR array. One-shot gate used at each
 *  level when walking block → [header, ...] → [headerBody, kesSig]. */
const expectArrayAt = (
  buf: Uint8Array,
  offset: number,
  operation: HeaderBridgeOperation,
  cause: string,
): Effect.Effect<void, HeaderBridgeError> =>
  cborMajorType(buf[offset]!) === CborKinds.Array
    ? Effect.void
    : Effect.fail(new HeaderBridgeError({ operation, cause }));

/**
 * Navigate into block CBOR to extract the original FULL header bytes.
 * Block = [era, [header, txBodies, ...]]
 * Returns the raw bytes of header = [headerBody, kesSig] without re-encoding.
 *
 * Used for hash computation: Shelley header hash = blake2b-256(entire header CBOR).
 */
const extractOriginalFullHeaderBytes = (
  blockCbor: Uint8Array,
  operation: HeaderBridgeOperation,
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.gen(function* () {
    yield* expectArrayAt(blockCbor, 0, operation, "block is not a CBOR array");
    const afterTop = yield* skipArrayHeader(blockCbor, 0, operation);
    const afterEra = skipCborItem(blockCbor, afterTop);
    yield* expectArrayAt(blockCbor, afterEra, operation, "blockBody is not a CBOR array");
    const headerStart = yield* skipArrayHeader(blockCbor, afterEra, operation);
    return blockCbor.subarray(headerStart, skipCborItem(blockCbor, headerStart));
  });

/**
 * Navigate into block CBOR to extract the original header BODY bytes.
 * Block = [era, [header, ...]], Header = [headerBody, kesSig]
 * Returns the raw bytes of headerBody only (for KES signature verification).
 */
const extractOriginalHeaderBodyBytes = (
  blockCbor: Uint8Array,
  operation: HeaderBridgeOperation,
): Effect.Effect<Uint8Array, HeaderBridgeError> =>
  Effect.gen(function* () {
    yield* expectArrayAt(blockCbor, 0, operation, "block is not a CBOR array");
    const afterTop = yield* skipArrayHeader(blockCbor, 0, operation);
    const afterEra = skipCborItem(blockCbor, afterTop);
    yield* expectArrayAt(blockCbor, afterEra, operation, "blockBody is not a CBOR array");
    const headerPos = yield* skipArrayHeader(blockCbor, afterEra, operation);
    yield* expectArrayAt(blockCbor, headerPos, operation, "header is not a CBOR array");
    const headerBodyStart = yield* skipArrayHeader(blockCbor, headerPos, operation);
    return blockCbor.subarray(headerBodyStart, skipCborItem(blockCbor, headerBodyStart));
  });

// ---------------------------------------------------------------------------
// Operation enum + error
// ---------------------------------------------------------------------------

/** Enumerates every `HeaderBridgeError`-raising op in this file. `operation`
 * is narrowed to this literal set so consumers can `Match.value(e.operation)`
 * exhaustively, and typos at construction time fail at compile time. */
export const HeaderBridgeOperation = Schema.Literals([
  "extractFirstArrayItemBytes",
  "bridgeHeader.leaderVrfTag",
  "bridgeHeader.nonceVrfTag",
  "bridgeMultiEraHeader",
  "bridgeMultiEraHeader.leaderVrfTag",
  "bridgeMultiEraHeader.nonceVrfTag",
  "decodeAndBridge",
  "decodeWrappedHeader",
  "decodeWrappedHeader.headerHash",
  "decodeByronHeader",
  "decodeByronWrappedHeader.hash",
  "computeHeaderHash",
  "computeHeaderHashFromHeader",
]);
export type HeaderBridgeOperation = typeof HeaderBridgeOperation.Type;

/** Typed error for header bridge decode / bridge failures. */
export class HeaderBridgeError extends Schema.TaggedErrorClass<HeaderBridgeError>()(
  "HeaderBridgeError",
  {
    operation: HeaderBridgeOperation,
    cause: Schema.Defect,
  },
) {}

const mapCryptoErr =
  (operation: HeaderBridgeOperation) =>
  (cause: CryptoOpError): HeaderBridgeError =>
    new HeaderBridgeError({ operation, cause });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SlotsPerKesPeriod = Effect.gen(function* () {
  return yield* Config.number("CARDANO_SLOTS_PER_KES_PERIOD").pipe(
    Config.withDefault(DEFAULT_SLOTS_PER_KES_PERIOD),
  );
}).pipe(Effect.orDie);

const ByronEpochLength = Effect.gen(function* () {
  return yield* Config.number("CARDANO_BYRON_EPOCH_LENGTH").pipe(
    Config.withDefault(DEFAULT_BYRON_EPOCH_LENGTH),
  );
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

// ---------------------------------------------------------------------------
// Header hash helpers (unchanged public API)
// ---------------------------------------------------------------------------

/**
 * Extract the raw CBOR-encoded header from block CBOR bytes and compute its
 * blake2b-256 hash. Per Haskell MemoBytes, `bhHash` hashes the full BHeader
 * (body + KES sig), not just the body — so we slice the entire header subarray.
 */
export const computeHeaderHash = (
  blockCbor: Uint8Array,
): Effect.Effect<Uint8Array, HeaderBridgeError, Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    const fullHeaderCbor = yield* extractOriginalFullHeaderBytes(blockCbor, "computeHeaderHash");
    return yield* crypto
      .blake2b256(fullHeaderCbor)
      .pipe(Effect.mapError(mapCryptoErr("computeHeaderHash")));
  });

/**
 * Compute header hash from raw header CBOR bytes (as from ChainSync).
 * Hash = blake2b-256(entire [headerBody, kesSig] CBOR).
 */
export const computeHeaderHashFromHeader = (
  headerCbor: Uint8Array,
): Effect.Effect<Uint8Array, HeaderBridgeError, Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    return yield* crypto
      .blake2b256(headerCbor)
      .pipe(Effect.mapError(mapCryptoErr("computeHeaderHashFromHeader")));
  });

// ---------------------------------------------------------------------------
// Common Praos header builder helpers
// ---------------------------------------------------------------------------

/** Minimum structural shape shared by every Shelley-family header (Ledger
 *  `BlockHeader` or `MultiEraHeader` Shelley-like / Babbage-like variants).
 *  Accepted structurally, so `commonPraosHeaderFields` works for all three. */
type PraosHeaderCore = {
  readonly slot: bigint;
  readonly blockNo: bigint;
  readonly prevHash?: Uint8Array | undefined;
  readonly issuerVKey: Uint8Array;
  readonly vrfVKey: Uint8Array;
  readonly vrfResult: { readonly proof: Uint8Array };
  readonly kesSignature: Uint8Array;
  readonly opCert: {
    readonly sigma: Uint8Array;
    readonly hotVKey: Uint8Array;
    readonly seqNo: bigint;
    readonly kesPeriod: bigint;
  };
  readonly bodyHash: Uint8Array;
  readonly bodySize: bigint;
};

/** Fields shared by every Shelley+ consensus `BlockHeader` — factored out
 *  so the three call paths (pre-Babbage ledger, Babbage+ ledger, MultiEra)
 *  don't hand-duplicate 17 lines each. */
const commonPraosHeaderFields = (
  h: PraosHeaderCore,
  headerHash: Uint8Array,
  headerBodyCbor: Uint8Array,
  slotsPerKesPeriod: number,
) => ({
  slot: h.slot,
  blockNo: h.blockNo,
  hash: headerHash,
  prevHash: h.prevHash ?? EMPTY_PREV_HASH,
  issuerVk: h.issuerVKey,
  vrfVk: h.vrfVKey,
  vrfProof: h.vrfResult.proof,
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

/** Derive Babbage+ `vrfOutput` + `nonceVrfOutput` from a single VRF proof
 *  via domain-tagging (`0x4c`/`0x4e` prefix). Runs both blake2b-256s in
 *  parallel — the two hashes are independent so there's no reason to
 *  serialise them. */
// Module-level 1-byte tag prefixes — `deriveTaggedVrfOutputs` runs on every
// Babbage+ block in the sync hot path; pre-allocating these constants
// avoids two `new Uint8Array(1)` allocations per call.
const VRF_LEADER_TAG_BYTE = new Uint8Array([VRF_LEADER_TAG]);
const VRF_NONCE_TAG_BYTE = new Uint8Array([VRF_NONCE_TAG]);

const deriveTaggedVrfOutputs = (
  crypto: Context.Service.Shape<typeof Crypto>,
  rawVrfOutput: Uint8Array,
  leaderOp: HeaderBridgeOperation,
  nonceOp: HeaderBridgeOperation,
): Effect.Effect<{ vrfOutput: Uint8Array; nonceVrfOutput: Uint8Array }, HeaderBridgeError> =>
  Effect.all(
    {
      vrfOutput: crypto
        .blake2b256(concat(VRF_LEADER_TAG_BYTE, rawVrfOutput))
        .pipe(Effect.mapError(mapCryptoErr(leaderOp))),
      nonceVrfOutput: crypto
        .blake2b256(concat(VRF_NONCE_TAG_BYTE, rawVrfOutput))
        .pipe(Effect.mapError(mapCryptoErr(nonceOp))),
    },
    { concurrency: "unbounded" },
  );

// ---------------------------------------------------------------------------
// Bridge implementations
// ---------------------------------------------------------------------------

/**
 * Bridge a ledger `BlockHeader` to a consensus `BlockHeader`. Pre-Babbage
 * headers carry a separate `nonceVrf` cert with raw outputs; Babbage+ uses
 * a single VRF proof with Haskell-style domain tagging.
 */
export const bridgeHeader = (
  ledgerHeader: LedgerBlockHeader,
  headerHash: Uint8Array,
  headerBodyCbor: Uint8Array,
  crypto: Context.Service.Shape<typeof Crypto>,
  slotsPerKesPeriod = DEFAULT_SLOTS_PER_KES_PERIOD,
): Effect.Effect<ConsensusBlockHeader, HeaderBridgeError> => {
  const base = commonPraosHeaderFields(ledgerHeader, headerHash, headerBodyCbor, slotsPerKesPeriod);

  // Pre-Babbage: raw VRF outputs from two separate certs.
  if (ledgerHeader.nonceVrf !== undefined) {
    return Effect.succeed({
      ...base,
      vrfOutput: ledgerHeader.vrfResult.output,
      nonceVrfOutput: ledgerHeader.nonceVrf.output,
    });
  }

  // Babbage+: domain-tagged derivation from the single VRF output.
  return deriveTaggedVrfOutputs(
    crypto,
    ledgerHeader.vrfResult.output,
    "bridgeHeader.leaderVrfTag",
    "bridgeHeader.nonceVrfTag",
  ).pipe(Effect.map((vrf) => ({ ...base, ...vrf })));
};

/**
 * Bridge a `MultiEraHeader` (tagged union) to a consensus `BlockHeader`.
 * Byron variants aren't supported here — callers dispatch to the Byron
 * path explicitly via `decodeWrappedHeader`.
 */
export const bridgeMultiEraHeader = (
  multiEraHeader: MultiEraHeader,
  headerHash: Uint8Array,
  headerBodyCbor: Uint8Array,
  crypto: Context.Service.Shape<typeof Crypto>,
  slotsPerKesPeriod = DEFAULT_SLOTS_PER_KES_PERIOD,
): Effect.Effect<ConsensusBlockHeader, HeaderBridgeError> => {
  if (isShelleyLikeHeader(multiEraHeader)) {
    const base = commonPraosHeaderFields(
      multiEraHeader,
      headerHash,
      headerBodyCbor,
      slotsPerKesPeriod,
    );
    return Effect.succeed({
      ...base,
      vrfOutput: multiEraHeader.vrfResult.output,
      nonceVrfOutput: multiEraHeader.nonceVrf.output,
    });
  }

  if (isBabbageLikeHeader(multiEraHeader)) {
    const base = commonPraosHeaderFields(
      multiEraHeader,
      headerHash,
      headerBodyCbor,
      slotsPerKesPeriod,
    );
    return deriveTaggedVrfOutputs(
      crypto,
      multiEraHeader.vrfResult.output,
      "bridgeMultiEraHeader.leaderVrfTag",
      "bridgeMultiEraHeader.nonceVrfTag",
    ).pipe(Effect.map((vrf) => ({ ...base, ...vrf })));
  }

  return Effect.fail(
    new HeaderBridgeError({
      operation: "bridgeMultiEraHeader",
      cause: "Byron headers should use the Byron path",
    }),
  );
};

// ---------------------------------------------------------------------------
// Tag(24) unwrap helper
// ---------------------------------------------------------------------------

/** Unwrap a CBOR `Tag(24)`-wrapped `bytes` envelope if present. N2N ChainSync
 *  occasionally delivers headers inside `Tag(24)(bytes)` — both the inner
 *  node (for structural checks) and the raw bytes (for hash computation)
 *  are returned from a single unwrap call to avoid re-scanning. */
const unwrapTag24 = (
  node: CborSchemaType,
  fallbackRaw: Uint8Array,
): { readonly node: CborSchemaType; readonly raw: Uint8Array } =>
  CborValue.guards[CborKinds.Tag](node) &&
  node.tag === 24n &&
  CborValue.guards[CborKinds.Bytes](node.data)
    ? { node: parseSync(node.data.bytes), raw: node.data.bytes }
    : { node, raw: fallbackRaw };

// ---------------------------------------------------------------------------
// decodeAndBridge — full block CBOR → consensus header
// ---------------------------------------------------------------------------

/**
 * Decode block CBOR and produce a consensus `BlockHeader`. Returns
 * `undefined` for Byron blocks (skip consensus validation). Reads
 * `CARDANO_SLOTS_PER_KES_PERIOD` from Config (default 129600).
 */
export const decodeAndBridge = (blockCbor: Uint8Array, headerHash: Uint8Array) =>
  Effect.gen(function* () {
    const slotsPerKesPeriod = yield* SlotsPerKesPeriod;
    const crypto = yield* Crypto;
    const block = yield* decodeMultiEraBlock(blockCbor);
    if (isByronBlock(block)) return undefined;

    // Shape-check block = [era, [header, ...]] structurally before slicing.
    const top = parseSync(blockCbor);
    if (!CborValue.guards[CborKinds.Array](top))
      return yield* new HeaderBridgeError({
        operation: "decodeAndBridge",
        cause: "Invalid block CBOR",
      });
    const blockBody = top.items[1];
    if (blockBody === undefined || !CborValue.guards[CborKinds.Array](blockBody))
      return yield* new HeaderBridgeError({
        operation: "decodeAndBridge",
        cause: "Invalid block body",
      });
    const headerNode = blockBody.items[0];
    if (headerNode === undefined || !CborValue.guards[CborKinds.Array](headerNode))
      return yield* new HeaderBridgeError({
        operation: "decodeAndBridge",
        cause: "Invalid header",
      });

    const headerBodyCbor = yield* extractOriginalHeaderBodyBytes(blockCbor, "decodeAndBridge");
    const header = yield* bridgeMultiEraHeader(
      block.multiEraHeader,
      headerHash,
      headerBodyCbor,
      crypto,
      slotsPerKesPeriod,
    );
    return { header, era: block.era, txCount: block.txBodies.length };
  });

// ---------------------------------------------------------------------------
// decodeWrappedHeader — N2N ChainSync wrapped header → DecodedHeader
// ---------------------------------------------------------------------------

/**
 * Decode a N2N ChainSync header and produce a consensus `BlockHeader`.
 *
 * After ChainSync schema extraction, `headerBytes` contain the raw CBOR:
 *   - Byron (eraVariant 0): raw Byron header (5-element array)
 *   - Shelley+ (eraVariant 1+): [headerBody, kesSig]
 *
 * `eraVariant` is the N2N hard-fork combinator index (0-6), distinct from
 * ledger era tags (0-7). Mapping: N2N 0→Byron, 1→Shelley(2), 2→Allegra(3), …
 */
export const decodeWrappedHeader = (
  headerBytes: Uint8Array,
  eraVariant: number,
  /** Byron subtag from ChainSync byronPrefix[0] (0=EBB, 1=main). When
   *  provided, used directly for hash computation instead of re-deriving. */
  byronSubtag?: number,
): Effect.Effect<DecodedHeader, HeaderBridgeError, Crypto> =>
  Effect.gen(function* () {
    const slotsPerKesPeriod = yield* SlotsPerKesPeriod;
    const byronEpochLength = yield* ByronEpochLength;
    const crypto = yield* Crypto;

    // Byron (N2N variant 0) — decode via Byron-specific path.
    if (eraVariant === 0)
      return yield* decodeByronWrappedHeader(headerBytes, byronEpochLength, crypto, byronSubtag);

    // Shelley+ (N2N variant 1-6) — headerBytes = [headerBody, kesSig],
    // optionally wrapped in Tag(24)(bytes). unwrapTag24 yields both the
    // inner structured node and the raw bytes for hash computation.
    const { node: headerNode, raw: rawHeaderBytes } = unwrapTag24(
      parseSync(headerBytes),
      headerBytes,
    );

    if (!CborValue.guards[CborKinds.Array](headerNode) || headerNode.items.length < 2)
      return yield* new HeaderBridgeError({
        operation: "decodeWrappedHeader",
        cause: `Invalid Shelley+ header: expected [headerBody, kesSig], got ${headerNode._tag}`,
      });

    // Map N2N era variant to ledger era: N2N 1→Shelley(2), 2→Allegra(3), …
    const ledgerEra = eraVariant + 1;
    const multiEraHeader = yield* Effect.mapError(
      decodeMultiEraHeader(headerNode, ledgerEra),
      (issue) =>
        new HeaderBridgeError({
          operation: "decodeWrappedHeader",
          cause: `Header decode failed: ${String(issue)}`,
        }),
    );

    // Header hash = blake2b-256(ENTIRE header CBOR = [headerBody, kesSig]).
    // Use the raw wire bytes to preserve original CBOR encoding (MemoBytes).
    const headerHash = yield* crypto
      .blake2b256(rawHeaderBytes)
      .pipe(Effect.mapError(mapCryptoErr("decodeWrappedHeader.headerHash")));
    const headerBodyCbor = yield* extractFirstArrayItemBytes(rawHeaderBytes);
    const header = yield* bridgeMultiEraHeader(
      multiEraHeader,
      headerHash,
      headerBodyCbor,
      crypto,
      slotsPerKesPeriod,
    );
    return DecodedHeader.cases.shelley.make({ header, era: ledgerEra });
  });

// ---------------------------------------------------------------------------
// Byron header decoding
// ---------------------------------------------------------------------------

/** Byron "difficulty" CBOR is `[uint]` — the block number. Malformed
 *  encodings degrade to `0n` (matching the historical fallback). */
const extractByronDifficultyBlockNo = (node: CborSchemaType): bigint => {
  if (!CborValue.guards[CborKinds.Array](node)) return 0n;
  const [head] = node.items;
  return head !== undefined && CborValue.guards[CborKinds.UInt](head) ? head.num : 0n;
};

/** Byron EBB consensus data: `[epochId: uint, difficulty: [uint]]`. */
const decodeByronEbbSlotAndBlockNo = (
  consensusDataItems: ReadonlyArray<CborSchemaType>,
  byronEpochLength: number,
): Effect.Effect<{ slot: bigint; blockNo: bigint }, HeaderBridgeError> => {
  const epochNode = consensusDataItems[0]!;
  if (!CborValue.guards[CborKinds.UInt](epochNode))
    return Effect.fail(
      new HeaderBridgeError({
        operation: "decodeByronHeader",
        cause: "Byron EBB: epochId is not uint",
      }),
    );
  return Effect.succeed({
    slot: epochNode.num * BigInt(byronEpochLength),
    blockNo: extractByronDifficultyBlockNo(consensusDataItems[1]!),
  });
};

/** Byron main consensus data: `[slotId, pubKey, difficulty, blockSig]`
 *  where `slotId = [epoch: uint, slotInEpoch: uint]`. */
const decodeByronMainSlotAndBlockNo = (
  consensusDataItems: ReadonlyArray<CborSchemaType>,
  byronEpochLength: number,
): Effect.Effect<{ slot: bigint; blockNo: bigint }, HeaderBridgeError> => {
  const slotIdNode = consensusDataItems[0]!;
  if (!CborValue.guards[CborKinds.Array](slotIdNode) || slotIdNode.items.length < 2)
    return Effect.fail(
      new HeaderBridgeError({
        operation: "decodeByronHeader",
        cause: "Byron main: slotId is not [epoch, slot]",
      }),
    );
  const [epochNode, slotInEpochNode] = slotIdNode.items;
  if (
    epochNode === undefined ||
    slotInEpochNode === undefined ||
    !CborValue.guards[CborKinds.UInt](epochNode) ||
    !CborValue.guards[CborKinds.UInt](slotInEpochNode)
  )
    return Effect.fail(
      new HeaderBridgeError({
        operation: "decodeByronHeader",
        cause: "Byron main: epoch/slot not uint",
      }),
    );
  return Effect.succeed({
    slot: epochNode.num * BigInt(byronEpochLength) + slotInEpochNode.num,
    blockNo: extractByronDifficultyBlockNo(consensusDataItems[2]!),
  });
};

/**
 * Decode a Byron header from raw CBOR bytes.
 *
 * Byron headers come in two flavours distinguished by the N2N byronPrefix
 * subtag:
 *   - EBB (subtag 0): Epoch Boundary Block — consensus_data = [epochId, diff]
 *   - Main (subtag 1): Regular block — consensus_data = [slotId, vk, diff, sig]
 *
 * Since the subtag is stripped before we see the raw bytes, callers that
 * can supply the authoritative subtag do so via `authoritativeSubtag`; we
 * otherwise fall back to a shape heuristic (consensus_data array length).
 *
 * Hash = `blake2b256(0x82 ∥ subtag ∥ rawHeaderBytes)` where `0x82` is the
 * CBOR array-of-2 header and `subtag` is a CBOR uint 0 or 1.
 */
const decodeByronWrappedHeader = (
  headerBytes: Uint8Array,
  byronEpochLength: number,
  crypto: Context.Service.Shape<typeof Crypto>,
  /** Authoritative subtag from ChainSync byronPrefix (0=EBB, 1=main).
   *  Falls back to heuristic detection via consensus_data array length. */
  authoritativeSubtag?: number,
): Effect.Effect<ByronHeaderInfo, HeaderBridgeError> =>
  Effect.gen(function* () {
    const parsed = parseSync(headerBytes);
    if (!CborValue.guards[CborKinds.Array](parsed) || parsed.items.length < 4)
      return yield* new HeaderBridgeError({
        operation: "decodeByronHeader",
        cause: `Invalid Byron header: expected 5-element array, got ${parsed._tag}`,
      });

    // prevHash always at index 1, consensus_data always at index 3.
    const prevHashNode = parsed.items[1]!;
    const prevHash = CborValue.guards[CborKinds.Bytes](prevHashNode)
      ? prevHashNode.bytes
      : EMPTY_PREV_HASH;

    const consensusData = parsed.items[3]!;
    if (!CborValue.guards[CborKinds.Array](consensusData))
      return yield* new HeaderBridgeError({
        operation: "decodeByronHeader",
        cause: "Byron header: consensus_data is not an array",
      });

    // Prefer authoritative subtag from ChainSync protocol when available.
    // Fall back to heuristic: EBB consensus_data has 2 items, main has 4.
    const isEbb =
      authoritativeSubtag !== undefined
        ? authoritativeSubtag === BYRON_EBB_SUBTAG
        : consensusData.items.length === 2;

    const { slot, blockNo } = yield* isEbb
      ? decodeByronEbbSlotAndBlockNo(consensusData.items, byronEpochLength)
      : decodeByronMainSlotAndBlockNo(consensusData.items, byronEpochLength);

    // Byron header hash: blake2b-256(0x82 ∥ CBOR(subtag) ∥ rawHeaderBytes).
    // Hash prefixes are pre-allocated module-level constants (one for EBB,
    // one for main blocks) to avoid the per-Byron-block `new Uint8Array(2)`.
    const hashPrefix = isEbb ? BYRON_EBB_HASH_PREFIX : BYRON_MAIN_HASH_PREFIX;
    const hash = yield* crypto
      .blake2b256(concat(hashPrefix, headerBytes))
      .pipe(Effect.mapError(mapCryptoErr("decodeByronWrappedHeader.hash")));

    return ByronHeaderInfo.make({
      slot,
      blockNo,
      hash,
      prevHash,
      era: 0,
      isEbb,
    });
  });
