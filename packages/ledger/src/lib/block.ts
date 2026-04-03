/**
 * Multi-era block decoder.
 * Parses the Cardano wire format [era, blockData] into typed MultiEraBlock.
 *
 * Byron (era 0-1): opaque bytes (different block structure, not decoded)
 * Shelley through Conway (era 2-7): [header, txBodies[], witnessSets[], auxData, invalidTxs?]
 */
import { Effect, Schema, SchemaIssue } from "effect"
import { CborKinds, type CborSchemaType, encodeSync, parseSync } from "cbor-schema"
import { Era, EraSchema } from "./era.ts"
import { decodeTxBody, decodeTxOut, type TxBody } from "./tx.ts"

// ---------------------------------------------------------------------------
// MultiEraBlock — tagged union with .match, .guards, .isAnyOf
// ---------------------------------------------------------------------------

export const MultiEraBlock = Schema.TaggedUnion({
  byron: {
    raw: Schema.Uint8Array,
  },
  postByron: {
    era: EraSchema,
    headerCbor: Schema.Uint8Array,
    txBodies: Schema.Array(Schema.Any),
    witnessSetsCbor: Schema.Uint8Array,
    auxDataCbor: Schema.Uint8Array,
  },
})
export type MultiEraBlock = typeof MultiEraBlock.Type

// ---------------------------------------------------------------------------
// Block decoder from raw CBOR bytes
// ---------------------------------------------------------------------------

export function decodeMultiEraBlock(blockCbor: Uint8Array): MultiEraBlock {
  const cbor = parseSync(blockCbor)

  if (cbor._tag !== CborKinds.Array || cbor.items.length < 2) {
    throw new Error("MultiEraBlock: expected CBOR array with at least 2 elements")
  }

  const eraItem = cbor.items[0]
  if (eraItem?._tag !== CborKinds.UInt) {
    throw new Error("MultiEraBlock: expected era number as first element")
  }

  const eraNum = Number(eraItem.num)

  // Byron/EBB (era 0-1): return opaque bytes
  if (eraNum <= 1) {
    return { _tag: "byron", raw: blockCbor }
  }

  // Shelley through Conway (era 2-7): parse block body
  const blockData = cbor.items[1]
  if (blockData?._tag !== CborKinds.Array) {
    throw new Error("MultiEraBlock: expected block body array")
  }

  // Block body: [header, txBodies[], witnessSets[], auxData, invalidTxs?]
  const headerCbor = blockData.items[0] ? encodeSync(blockData.items[0]) : new Uint8Array(0)
  const witnessSetsCbor = blockData.items[2] ? encodeSync(blockData.items[2]) : new Uint8Array(0)
  const auxDataCbor = blockData.items[3] ? encodeSync(blockData.items[3]) : new Uint8Array(0)

  // Decode each transaction body
  const txBodiesCbor = blockData.items[1]
  const txBodies: TxBody[] = []
  if (txBodiesCbor?._tag === CborKinds.Array) {
    for (const txCbor of txBodiesCbor.items) {
      const txBody = Effect.runSync(decodeTxBody(txCbor))
      txBodies.push(txBody)
    }
  }

  return {
    _tag: "postByron",
    era: eraNum as Era,
    headerCbor,
    txBodies,
    witnessSetsCbor,
    auxDataCbor,
  }
}

// ---------------------------------------------------------------------------
// Predicates via .isAnyOf
// ---------------------------------------------------------------------------

export const isByronBlock = MultiEraBlock.isAnyOf(["byron"])
export const isPostByronBlock = MultiEraBlock.isAnyOf(["postByron"])
