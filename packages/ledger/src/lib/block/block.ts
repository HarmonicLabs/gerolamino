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
export type VrfCert = Schema.Schema.Type<typeof VrfCert>;

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
export type OpCert = Schema.Schema.Type<typeof OpCert>;

// ---------------------------------------------------------------------------
// ProtocolVersion
// ---------------------------------------------------------------------------

export const ProtocolVersion = Schema.Struct({
  major: Schema.BigInt,
  minor: Schema.BigInt,
});
export type ProtocolVersion = Schema.Schema.Type<typeof ProtocolVersion>;

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
export type BlockHeader = Schema.Schema.Type<typeof BlockHeader>;

function decodeBlockHeader(cbor: CborSchemaType): Effect.Effect<BlockHeader, SchemaIssue.Issue> {
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
// MultiEraBlock — tagged union with .match, .guards, .isAnyOf
// ---------------------------------------------------------------------------

export const MultiEraBlock = Schema.TaggedUnion({
  byron: {
    raw: Schema.Uint8Array,
  },
  postByron: {
    era: EraSchema,
    header: BlockHeader,
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

    // Byron/EBB (era 0-1): return opaque bytes
    if (eraNum <= 1) {
      return { _tag: "byron" as const, raw: blockCbor };
    }

    // Shelley through Conway (era 2-7): parse block body
    const blockBody = yield* expectArray(topItems[1]!, "MultiEraBlock.body");

    // Block body: [header, txBodies[], witnessSets[], auxData, invalidTxs?]
    const header = yield* decodeBlockHeader(blockBody[0]!);
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
