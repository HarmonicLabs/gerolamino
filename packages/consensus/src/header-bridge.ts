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
import { Config, Effect } from "effect";
import { parseSync, encodeSync, CborKinds } from "cbor-schema";
import type { BlockHeader as LedgerBlockHeader } from "ledger/lib/block/block";
import { decodeMultiEraBlock, decodeBlockHeader } from "ledger/lib/block/block";
import type { BlockHeader as ConsensusBlockHeader } from "./validate-header";

/** Slots per KES period — configurable via CARDANO_SLOTS_PER_KES_PERIOD, defaults to 129600. */
const SlotsPerKesPeriod = Config.number("CARDANO_SLOTS_PER_KES_PERIOD").pipe(
  Config.withDefault(129600),
);

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
): Uint8Array => {
  const top = parseSync(blockCbor);
  if (top._tag !== CborKinds.Array || top.items.length < 2)
    throw new Error("Invalid block CBOR: expected [era, blockBody]");

  const blockBody = top.items[1]!;
  if (blockBody._tag !== CborKinds.Array || blockBody.items.length < 1)
    throw new Error("Invalid block body: expected array");

  const header = blockBody.items[0]!;
  if (header._tag !== CborKinds.Array || header.items.length < 2)
    throw new Error("Invalid header: expected [headerBody, kesSig]");

  const headerBody = header.items[0]!;
  return crypto.blake2b256(encodeSync(headerBody));
};

/**
 * Compute header hash from raw header CBOR bytes (as from ChainSync).
 * Header structure: [headerBody, kesSignature]
 * Hash = blake2b-256(CBOR(headerBody))
 */
export const computeHeaderHashFromHeader = (
  headerCbor: Uint8Array,
  crypto: { blake2b256: (data: Uint8Array) => Uint8Array },
): Uint8Array => {
  const parsed = parseSync(headerCbor);
  if (parsed._tag !== CborKinds.Array || parsed.items.length < 2)
    throw new Error("Invalid header CBOR: expected [headerBody, kesSig]");

  const headerBody = parsed.items[0]!;
  return crypto.blake2b256(encodeSync(headerBody));
};

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
  slotsPerKesPeriod = 129600,
): ConsensusBlockHeader => ({
  slot: ledgerHeader.slot,
  blockNo: ledgerHeader.blockNo,
  hash: headerHash,
  prevHash: ledgerHeader.prevHash ?? new Uint8Array(32),
  issuerVk: ledgerHeader.issuerVKey,
  vrfVk: ledgerHeader.vrfVKey,
  vrfProof: ledgerHeader.vrfResult.proof,
  vrfOutput: ledgerHeader.vrfResult.output,
  kesSig: ledgerHeader.kesSignature,
  kesPeriod: Math.floor(Number(ledgerHeader.slot) / slotsPerKesPeriod),
  opcertSig: ledgerHeader.opCert.sigma,
  opcertVkHot: ledgerHeader.opCert.hotVKey,
  opcertSeqNo: Number(ledgerHeader.opCert.seqNo),
  opcertKesPeriod: Number(ledgerHeader.opCert.kesPeriod),
  bodyHash: ledgerHeader.bodyHash,
});

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
    const block = yield* decodeMultiEraBlock(blockCbor);
    if (block._tag === "byron") {
      return undefined;
    }
    return {
      header: bridgeHeader(block.header, headerHash, slotsPerKesPeriod),
      era: block.era,
      txCount: block.txBodies.length,
    };
  });

/**
 * Decode a N2N ChainSync wrapped header and produce a consensus BlockHeader.
 *
 * ChainSync sends headers as raw CBOR bytes (after Tag(24) unwrap).
 * Format varies by era:
 *   - Byron: [era_tag, byron_header_data] — skip
 *   - Shelley+: [headerBody, kesSig] — decode via ledger
 *
 * Returns undefined for Byron headers.
 */
export const decodeWrappedHeader = (
  headerBytes: Uint8Array,
) =>
  Effect.gen(function* () {
    const slotsPerKesPeriod = yield* SlotsPerKesPeriod;
    const parsed = parseSync(headerBytes);

    if (parsed._tag !== CborKinds.Array || parsed.items.length < 2)
      return undefined;

    // Determine if this is [era_tag, header] or bare [headerBody, kesSig]
    const first = parsed.items[0]!;

    if (first._tag === CborKinds.UInt && first.num <= 7n) {
      // [era_tag, header] format — era 0-1 = Byron, skip
      if (first.num <= 1n) return undefined;

      // era 2+ = Shelley+: parsed.items[1] is the header [headerBody, kesSig]
      const headerCbor = parsed.items[1]!;
      if (headerCbor._tag !== CborKinds.Array || headerCbor.items.length < 2)
        return undefined;

      const ledgerHeader = yield* decodeBlockHeader(headerCbor);

      // Header hash = blake2b-256(CBOR(headerBody))
      const headerBodyCbor = encodeSync(headerCbor.items[0]!);
      const hasher = new Bun.CryptoHasher("blake2b256");
      hasher.update(headerBodyCbor);
      const headerHash = new Uint8Array(hasher.digest());

      return {
        header: bridgeHeader(ledgerHeader, headerHash, slotsPerKesPeriod),
        era: Number(first.num),
      };
    }

    // Bare [headerBody, kesSig] (no era wrapper)
    const ledgerHeader = yield* decodeBlockHeader(parsed);
    const headerBodyCbor = encodeSync(first);
    const hasher = new Bun.CryptoHasher("blake2b256");
    hasher.update(headerBodyCbor);
    const headerHash = new Uint8Array(hasher.digest());

    return {
      header: bridgeHeader(ledgerHeader, headerHash, slotsPerKesPeriod),
      era: undefined,
    };
  });
