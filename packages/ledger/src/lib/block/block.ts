/**
 * Multi-era block decoder.
 * Parses the Cardano wire format [era, blockData] into typed MultiEraBlock.
 *
 * Byron (era 0-1): opaque bytes (different block structure, not decoded)
 * Shelley through Conway (era 2-7): [header, txBodies[], witnessSets[], auxData, invalidTxs?]
 *
 * Header body layout differs by era:
 * - Shelley/Allegra/Mary/Alonzo: 15-element array (separate nonce+leader VRF certs, flattened opCert)
 * - Babbage/Conway: 10-element array (single VRF cert, nested opCert+protVer arrays)
 */
import { Effect, Option, Schema, SchemaIssue } from "effect";
import { CborKinds, type CborSchemaType, encodeSync, parseSync } from "cbor-schema";
import { Era, EraSchema } from "../core/era.ts";
import { Bytes32, Bytes64 } from "../core/hashes.ts";
import { decodeTxBody, TxBody } from "../tx/tx.ts";
import { expectArray, expectUint, expectBytes, isNull } from "../core/cbor-utils.ts";

// ---------------------------------------------------------------------------
// VrfCert — [output, proof]
// ---------------------------------------------------------------------------

export const VrfCert = Schema.Struct({
  output: Schema.Uint8Array,
  proof: Schema.Uint8Array,
});
export type VrfCert = typeof VrfCert.Type;

function decodeVrfCert(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<VrfCert, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, ctx, 2);
    const output = yield* expectBytes(items[0]!, `${ctx}.output`);
    const proof = yield* expectBytes(items[1]!, `${ctx}.proof`);
    return { output, proof };
  });
}

// ---------------------------------------------------------------------------
// OpCert — operational certificate (pool authorization to produce blocks)
// ---------------------------------------------------------------------------

export const OpCert = Schema.Struct({
  hotVKey: Bytes32,
  seqNo: Schema.BigInt,
  kesPeriod: Schema.BigInt,
  sigma: Bytes64,
});
export type OpCert = typeof OpCert.Type;

// ---------------------------------------------------------------------------
// ProtocolVersion
// ---------------------------------------------------------------------------

export const ProtocolVersion = Schema.Struct({
  major: Schema.BigInt,
  minor: Schema.BigInt,
});
export type ProtocolVersion = typeof ProtocolVersion.Type;

// ---------------------------------------------------------------------------
// BlockHeader — fully decoded header with all consensus-critical fields
// ---------------------------------------------------------------------------

export const BlockHeader = Schema.Struct({
  blockNo: Schema.BigInt,
  slot: Schema.BigInt,
  prevHash: Schema.optional(Bytes32), // undefined for genesis
  issuerVKey: Bytes32,
  vrfVKey: Bytes32,
  vrfResult: VrfCert, // Babbage+: single cert. Pre-Babbage: leader VRF
  nonceVrf: Schema.optional(VrfCert), // Shelley-Alonzo only (separate nonce VRF)
  bodySize: Schema.BigInt,
  bodyHash: Bytes32,
  opCert: OpCert,
  protocolVersion: ProtocolVersion,
  kesSignature: Schema.Uint8Array, // outer KES sig over header body
});
export type BlockHeader = typeof BlockHeader.Type;

export function decodeBlockHeader(
  cbor: CborSchemaType,
): Effect.Effect<BlockHeader, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    // Header: [headerBody, kesSignature]
    const headerItems = yield* expectArray(cbor, "Header", 2);
    const kesSignature = yield* expectBytes(headerItems[1]!, "Header.kesSig");

    const bodyItems = yield* expectArray(headerItems[0]!, "HeaderBody");
    const len = bodyItems.length;

    // Shelley/Allegra/Mary/Alonzo: 15-element array
    if (len === 15) {
      const prevHashCbor = bodyItems[2]!;
      return {
        blockNo: yield* expectUint(bodyItems[0]!, "HeaderBody.blockNo"),
        slot: yield* expectUint(bodyItems[1]!, "HeaderBody.slot"),
        prevHash: isNull(prevHashCbor)
          ? undefined
          : yield* expectBytes(prevHashCbor, "HeaderBody.prevHash", 32),
        issuerVKey: yield* expectBytes(bodyItems[3]!, "HeaderBody.issuerVKey", 32),
        vrfVKey: yield* expectBytes(bodyItems[4]!, "HeaderBody.vrfVKey", 32),
        nonceVrf: yield* decodeVrfCert(bodyItems[5]!, "HeaderBody.nonceVrf"),
        vrfResult: yield* decodeVrfCert(bodyItems[6]!, "HeaderBody.leaderVrf"),
        bodySize: yield* expectUint(bodyItems[7]!, "HeaderBody.bodySize"),
        bodyHash: yield* expectBytes(bodyItems[8]!, "HeaderBody.bodyHash", 32),
        opCert: {
          hotVKey: yield* expectBytes(bodyItems[9]!, "OpCert.hotVKey", 32),
          seqNo: yield* expectUint(bodyItems[10]!, "OpCert.seqNo"),
          kesPeriod: yield* expectUint(bodyItems[11]!, "OpCert.kesPeriod"),
          sigma: yield* expectBytes(bodyItems[12]!, "OpCert.sigma", 64),
        },
        protocolVersion: {
          major: yield* expectUint(bodyItems[13]!, "ProtVer.major"),
          minor: yield* expectUint(bodyItems[14]!, "ProtVer.minor"),
        },
        kesSignature,
      };
    }

    // Babbage/Conway: 10-element array
    if (len === 10) {
      const prevHashCbor = bodyItems[2]!;
      const opCertItems = yield* expectArray(bodyItems[8]!, "OpCert", 4);
      const protVerItems = yield* expectArray(bodyItems[9]!, "ProtVer", 2);
      return {
        blockNo: yield* expectUint(bodyItems[0]!, "HeaderBody.blockNo"),
        slot: yield* expectUint(bodyItems[1]!, "HeaderBody.slot"),
        prevHash: isNull(prevHashCbor)
          ? undefined
          : yield* expectBytes(prevHashCbor, "HeaderBody.prevHash", 32),
        issuerVKey: yield* expectBytes(bodyItems[3]!, "HeaderBody.issuerVKey", 32),
        vrfVKey: yield* expectBytes(bodyItems[4]!, "HeaderBody.vrfVKey", 32),
        nonceVrf: undefined, // Babbage+ merged into single vrfResult
        vrfResult: yield* decodeVrfCert(bodyItems[5]!, "HeaderBody.vrfResult"),
        bodySize: yield* expectUint(bodyItems[6]!, "HeaderBody.bodySize"),
        bodyHash: yield* expectBytes(bodyItems[7]!, "HeaderBody.bodyHash", 32),
        opCert: {
          hotVKey: yield* expectBytes(opCertItems[0]!, "OpCert.hotVKey", 32),
          seqNo: yield* expectUint(opCertItems[1]!, "OpCert.seqNo"),
          kesPeriod: yield* expectUint(opCertItems[2]!, "OpCert.kesPeriod"),
          sigma: yield* expectBytes(opCertItems[3]!, "OpCert.sigma", 64),
        },
        protocolVersion: {
          major: yield* expectUint(protVerItems[0]!, "ProtVer.major"),
          minor: yield* expectUint(protVerItems[1]!, "ProtVer.minor"),
        },
        kesSignature,
      };
    }

    return yield* Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: `HeaderBody: expected 10 or 15 elements, got ${len}`,
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Byron headers — Ouroboros Classic (not Praos)
// ---------------------------------------------------------------------------

/**
 * Byron EBB (Epoch Boundary Block) header fields.
 * EBB headers mark epoch boundaries; consensus_data = [epochId, difficulty].
 */
export const ByronEbbHeader = Schema.Struct({
  protocolMagic: Schema.BigInt,
  prevHash: Bytes32,
  epoch: Schema.BigInt,
  blockNo: Schema.BigInt,
});
export type ByronEbbHeader = typeof ByronEbbHeader.Type;

/**
 * Byron main block header fields.
 * consensus_data = [slotId(epoch, slotInEpoch), pubKey, difficulty, blockSig].
 */
export const ByronMainHeader = Schema.Struct({
  protocolMagic: Schema.BigInt,
  prevHash: Bytes32,
  epoch: Schema.BigInt,
  slotInEpoch: Schema.BigInt,
  blockNo: Schema.BigInt,
});
export type ByronMainHeader = typeof ByronMainHeader.Type;

/**
 * Decode a Byron EBB header from CBOR AST.
 * CBOR: [protocolMagic, prevHash, bodyProof, [epochId, [difficulty]], extraData]
 */
function decodeByronEbbHeader(
  cbor: CborSchemaType,
): Effect.Effect<ByronEbbHeader, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "ByronEbbHeader");
    if (items.length < 4)
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: `ByronEbbHeader: expected >=4 items, got ${items.length}`,
        }),
      );

    const protocolMagic = yield* expectUint(items[0]!, "ByronEbbHeader.protocolMagic");
    const prevHash = yield* expectBytes(items[1]!, "ByronEbbHeader.prevHash", 32);

    // consensus_data = [epochId, difficulty]
    const consensusItems = yield* expectArray(items[3]!, "ByronEbbHeader.consensusData", 2);
    const epoch = yield* expectUint(consensusItems[0]!, "ByronEbbHeader.epoch");

    // difficulty = [uint]
    const diffItems = yield* expectArray(consensusItems[1]!, "ByronEbbHeader.difficulty");
    const blockNo =
      diffItems.length > 0 && diffItems[0]!._tag === CborKinds.UInt ? diffItems[0]!.num : 0n;

    return { protocolMagic, prevHash, epoch, blockNo };
  });
}

/**
 * Decode a Byron main block header from CBOR AST.
 * CBOR: [protocolMagic, prevHash, bodyProof, [slotId, pubKey, difficulty, blockSig], extraData]
 */
function decodeByronMainHeader(
  cbor: CborSchemaType,
): Effect.Effect<ByronMainHeader, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "ByronMainHeader");
    if (items.length < 4)
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: `ByronMainHeader: expected >=4 items, got ${items.length}`,
        }),
      );

    const protocolMagic = yield* expectUint(items[0]!, "ByronMainHeader.protocolMagic");
    const prevHash = yield* expectBytes(items[1]!, "ByronMainHeader.prevHash", 32);

    // consensus_data = [slotId, pubKey, difficulty, blockSig]
    const consensusItems = yield* expectArray(items[3]!, "ByronMainHeader.consensusData");
    if (consensusItems.length < 3)
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(items[3]!), {
          message: `ByronMainHeader.consensusData: expected >=3 items, got ${consensusItems.length}`,
        }),
      );

    // slotId = [epoch, slotInEpoch]
    const slotIdItems = yield* expectArray(consensusItems[0]!, "ByronMainHeader.slotId", 2);
    const epoch = yield* expectUint(slotIdItems[0]!, "ByronMainHeader.epoch");
    const slotInEpoch = yield* expectUint(slotIdItems[1]!, "ByronMainHeader.slotInEpoch");

    // difficulty (index 2) = [uint]
    const diffItems = yield* expectArray(consensusItems[2]!, "ByronMainHeader.difficulty");
    const blockNo =
      diffItems.length > 0 && diffItems[0]!._tag === CborKinds.UInt ? diffItems[0]!.num : 0n;

    return { protocolMagic, prevHash, epoch, slotInEpoch, blockNo };
  });
}

// ---------------------------------------------------------------------------
// Shelley-like header fields (shared by Shelley, Allegra, Mary, Alonzo)
// ---------------------------------------------------------------------------

const ShelleyLikeHeaderFields = {
  blockNo: Schema.BigInt,
  slot: Schema.BigInt,
  prevHash: Schema.optional(Bytes32),
  issuerVKey: Bytes32,
  vrfVKey: Bytes32,
  nonceVrf: VrfCert,
  vrfResult: VrfCert,
  bodySize: Schema.BigInt,
  bodyHash: Bytes32,
  opCert: OpCert,
  protocolVersion: ProtocolVersion,
  kesSignature: Schema.Uint8Array,
};

// ---------------------------------------------------------------------------
// Babbage-like header fields (shared by Babbage, Conway)
// ---------------------------------------------------------------------------

const BabbageLikeHeaderFields = {
  blockNo: Schema.BigInt,
  slot: Schema.BigInt,
  prevHash: Schema.optional(Bytes32),
  issuerVKey: Bytes32,
  vrfVKey: Bytes32,
  vrfResult: VrfCert,
  bodySize: Schema.BigInt,
  bodyHash: Bytes32,
  opCert: OpCert,
  protocolVersion: ProtocolVersion,
  kesSignature: Schema.Uint8Array,
};

// ---------------------------------------------------------------------------
// MultiEraHeader — tagged union across all Cardano eras
// ---------------------------------------------------------------------------

/**
 * Multi-era block header. Each variant corresponds to a Cardano era,
 * with fields matching the era's CBOR structure.
 *
 * Tags match the Era enum string names for pattern matching.
 * Shelley-Alonzo share the 15-element header structure (with separate nonceVrf).
 * Babbage-Conway share the 10-element header structure (merged VRF).
 */
export const MultiEraHeader = Schema.TaggedUnion({
  byronEbb: ByronEbbHeader.fields,
  byron: ByronMainHeader.fields,
  shelley: ShelleyLikeHeaderFields,
  allegra: ShelleyLikeHeaderFields,
  mary: ShelleyLikeHeaderFields,
  alonzo: ShelleyLikeHeaderFields,
  babbage: BabbageLikeHeaderFields,
  conway: BabbageLikeHeaderFields,
});
export type MultiEraHeader = typeof MultiEraHeader.Type;

/** Type guards for grouping MultiEraHeader variants. */
export const isByronHeader = MultiEraHeader.isAnyOf(["byronEbb", "byron"]);
export const isShelleyLikeHeader = MultiEraHeader.isAnyOf(["shelley", "allegra", "mary", "alonzo"]);
export const isBabbageLikeHeader = MultiEraHeader.isAnyOf(["babbage", "conway"]);

/**
 * Map from ledger era number to MultiEraHeader tag for Shelley+ eras.
 * Used by decodeMultiEraHeader to determine which variant to construct.
 */
const eraToHeaderTag: Record<number, MultiEraHeader["_tag"]> = {
  [Era.Shelley]: "shelley",
  [Era.Allegra]: "allegra",
  [Era.Mary]: "mary",
  [Era.Alonzo]: "alonzo",
  [Era.Babbage]: "babbage",
  [Era.Conway]: "conway",
};

/**
 * Decode a multi-era header from CBOR AST + era number.
 *
 * @param cbor - Parsed CBOR AST of the header ([headerBody, kesSig] for Shelley+)
 * @param eraNum - Ledger era number (0 for Byron, 2-7 for Shelley-Conway)
 * @param byronSubtag - For Byron era (0): 0=EBB, 1=main block
 */
export function decodeMultiEraHeader(
  cbor: CborSchemaType,
  eraNum: number,
  byronSubtag?: number,
): Effect.Effect<MultiEraHeader, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    // Byron headers
    if (eraNum <= 1) {
      if (byronSubtag === 0) {
        const h = yield* decodeByronEbbHeader(cbor);
        return { _tag: "byronEbb" as const, ...h };
      }
      const h = yield* decodeByronMainHeader(cbor);
      return { _tag: "byron" as const, ...h };
    }

    // Shelley+ headers: [headerBody, kesSig]
    const tag = eraToHeaderTag[eraNum];
    if (!tag) {
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Unknown era: ${eraNum}` }),
      );
    }

    // Reuse existing decodeBlockHeader for the actual parsing
    const header = yield* decodeBlockHeader(cbor);

    // Shelley-like (15-element, has nonceVrf)
    if (tag === "shelley" || tag === "allegra" || tag === "mary" || tag === "alonzo") {
      return {
        _tag: tag,
        blockNo: header.blockNo,
        slot: header.slot,
        prevHash: header.prevHash,
        issuerVKey: header.issuerVKey,
        vrfVKey: header.vrfVKey,
        nonceVrf: header.nonceVrf!,
        vrfResult: header.vrfResult,
        bodySize: header.bodySize,
        bodyHash: header.bodyHash,
        opCert: header.opCert,
        protocolVersion: header.protocolVersion,
        kesSignature: header.kesSignature,
      };
    }

    // Babbage-like (10-element, no nonceVrf) — only "babbage" | "conway" can reach here
    if (tag !== "babbage" && tag !== "conway") {
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: `Unexpected tag in Babbage path: ${tag}`,
        }),
      );
    }

    return {
      _tag: tag,
      blockNo: header.blockNo,
      slot: header.slot,
      prevHash: header.prevHash,
      issuerVKey: header.issuerVKey,
      vrfVKey: header.vrfVKey,
      vrfResult: header.vrfResult,
      bodySize: header.bodySize,
      bodyHash: header.bodyHash,
      opCert: header.opCert,
      protocolVersion: header.protocolVersion,
      kesSignature: header.kesSignature,
    };
  });
}

// ---------------------------------------------------------------------------
// MultiEraBlock — tagged union with .match, .guards, .isAnyOf
// ---------------------------------------------------------------------------

export const MultiEraBlock = Schema.TaggedUnion({
  byron: {
    raw: Schema.Uint8Array,
    multiEraHeader: MultiEraHeader,
  },
  postByron: {
    era: EraSchema,
    header: BlockHeader,
    multiEraHeader: MultiEraHeader,
    txBodies: Schema.Array(TxBody),
    witnessSetsCbor: Schema.Uint8Array,
    auxDataCbor: Schema.Uint8Array,
  },
});
export type MultiEraBlock = typeof MultiEraBlock.Type;

// ---------------------------------------------------------------------------
// Block decoder from raw CBOR bytes
// ---------------------------------------------------------------------------

export function decodeMultiEraBlock(
  blockCbor: Uint8Array,
): Effect.Effect<MultiEraBlock, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const cbor = parseSync(blockCbor);
    const topItems = yield* expectArray(cbor, "MultiEraBlock", 2);
    const eraNum = Number(yield* expectUint(topItems[0]!, "MultiEraBlock.era"));

    // Byron/EBB (era 0-1): decode header but keep raw bytes for body
    if (eraNum <= 1) {
      // Byron block body: [[header_tuple], body]
      // header_tuple for main: just the header array
      // For EBB: different block structure
      const blockBody = yield* expectArray(topItems[1]!, "ByronBlock.body");
      const headerCbor = blockBody[0]!;
      const multiEraHeader = yield* decodeMultiEraHeader(headerCbor, eraNum, eraNum);
      return { _tag: "byron" as const, raw: blockCbor, multiEraHeader };
    }

    // Shelley through Conway (era 2-7): parse block body
    const blockBody = yield* expectArray(topItems[1]!, "MultiEraBlock.body");

    // Block body: [header, txBodies[], witnessSets[], auxData, invalidTxs?]
    const header = yield* decodeBlockHeader(blockBody[0]!);
    const multiEraHeader = yield* decodeMultiEraHeader(blockBody[0]!, eraNum);
    const witnessSetsCbor = blockBody[2] ? encodeSync(blockBody[2]) : new Uint8Array(0);
    const auxDataCbor = blockBody[3] ? encodeSync(blockBody[3]) : new Uint8Array(0);

    // Decode each transaction body
    const txBodiesCbor = blockBody[1];
    const txBodies: TxBody[] =
      txBodiesCbor?._tag === CborKinds.Array
        ? yield* Effect.all(txBodiesCbor.items.map(decodeTxBody))
        : [];

    return {
      _tag: "postByron" as const,
      era: eraNum in Era ? eraNum : Era.Conway,
      header,
      multiEraHeader,
      txBodies,
      witnessSetsCbor,
      auxDataCbor,
    };
  });
}

// ---------------------------------------------------------------------------
// Predicates via .isAnyOf
// ---------------------------------------------------------------------------

export const isByronBlock = MultiEraBlock.isAnyOf(["byron"]);
export const isPostByronBlock = MultiEraBlock.isAnyOf(["postByron"]);
