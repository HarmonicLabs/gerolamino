/**
 * Header bridge — converts ledger BlockHeader to consensus BlockHeader.
 *
 * The ledger package decodes raw CBOR into a rich BlockHeader schema.
 * The consensus package needs a flattened BlockHeader interface for validation.
 * This module bridges the two.
 *
 * Also computes the header hash (blake2b-256 of CBOR-encoded header body)
 * from raw block CBOR bytes.
 */
import { Effect } from "effect";
import { parseSync, encodeSync, CborKinds } from "cbor-schema";
import type { BlockHeader as LedgerBlockHeader } from "ledger/lib/block/block";
import { decodeMultiEraBlock } from "ledger/lib/block/block";
import type { BlockHeader as ConsensusBlockHeader } from "./validate-header";

/** Cardano constant: slots per KES period (universal across all networks). */
const SLOTS_PER_KES_PERIOD = 129600;

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
 * Bridge a ledger BlockHeader to a consensus BlockHeader.
 *
 * @param ledgerHeader - Decoded header from the ledger package
 * @param headerHash - 32-byte header hash (from computeHeaderHash or chunk index)
 */
export const bridgeHeader = (
  ledgerHeader: LedgerBlockHeader,
  headerHash: Uint8Array,
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
  kesPeriod: Math.floor(Number(ledgerHeader.slot) / SLOTS_PER_KES_PERIOD),
  opcertSig: ledgerHeader.opCert.sigma,
  opcertVkHot: ledgerHeader.opCert.hotVKey,
  opcertSeqNo: Number(ledgerHeader.opCert.seqNo),
  opcertKesPeriod: Number(ledgerHeader.opCert.kesPeriod),
  bodyHash: ledgerHeader.bodyHash,
});

/**
 * Decode block CBOR and produce a consensus BlockHeader.
 * Returns undefined for Byron blocks (skip consensus validation).
 */
export const decodeAndBridge = (
  blockCbor: Uint8Array,
  headerHash: Uint8Array,
) =>
  Effect.gen(function* () {
    const block = yield* decodeMultiEraBlock(blockCbor);
    if (block._tag === "byron") {
      return undefined;
    }
    return {
      header: bridgeHeader(block.header, headerHash),
      era: block.era,
      txCount: block.txBodies.length,
    };
  });
