/**
 * Multi-era TxOut and TxBody decoding tests.
 * Tests Array (Shelley) and Map (Babbage/Conway) formats, Tag(258) set handling.
 */
import { describe, it, assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { parseSync, encodeSync, CborKinds, type CborSchemaType } from "cbor-schema"
import { decodeTxOut, decodeTxBody, encodeTxOut, TxOutBytes, TxBodyBytes } from "../lib/tx.ts"
import { getCborSet, uint, cborBytes, arr } from "../lib/cbor-utils.ts"
import { Era } from "../lib/era.ts"

// ---------------------------------------------------------------------------
// CBOR helpers for building test fixtures
// ---------------------------------------------------------------------------

const testAddr = new Uint8Array(29).fill(0x01) // Enterprise address (29 bytes)
const testHash32 = new Uint8Array(32).fill(0xab)
const testHash28 = new Uint8Array(28).fill(0xcd)

function cborUint(n: bigint): CborSchemaType {
  return { _tag: CborKinds.UInt, num: n }
}

function cborMap(entries: ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }>): CborSchemaType {
  return { _tag: CborKinds.Map, entries: [...entries] }
}

// ---------------------------------------------------------------------------
// getCborSet tests
// ---------------------------------------------------------------------------

describe("getCborSet", () => {
  it("unwraps bare Array", () => {
    const items = [cborUint(1n), cborUint(2n)]
    const cbor: CborSchemaType = { _tag: CborKinds.Array, items }
    const result = getCborSet(cbor)
    assert.isDefined(result)
    assert.strictEqual(result!.length, 2)
  })

  it("unwraps Tag(258, Array)", () => {
    const items = [cborUint(1n), cborUint(2n)]
    const inner: CborSchemaType = { _tag: CborKinds.Array, items }
    const cbor: CborSchemaType = { _tag: CborKinds.Tag, tag: 258n, data: inner }
    const result = getCborSet(cbor)
    assert.isDefined(result)
    assert.strictEqual(result!.length, 2)
  })

  it("returns undefined for non-array, non-tag", () => {
    assert.isUndefined(getCborSet(cborUint(42n)))
  })
})

// ---------------------------------------------------------------------------
// Multi-era TxOut decode tests
// ---------------------------------------------------------------------------

describe("Multi-era TxOut decoding", () => {
  it.effect("decodes Shelley format: Array[addr, coin]", () =>
    Effect.gen(function*() {
      // Shelley: [addrBytes, coinUInt]
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [cborBytes(testAddr), cborUint(5000000n)],
      }
      const txOut = yield* decodeTxOut(cbor)
      assert.deepStrictEqual(txOut.address, testAddr)
      assert.strictEqual(txOut.value.coin, 5000000n)
      assert.isUndefined(txOut.datumOption)
      assert.isUndefined(txOut.scriptRef)
    }),
  )

  it.effect("decodes Mary format: Array[addr, [coin, multiAsset]]", () =>
    Effect.gen(function*() {
      // Mary: [addrBytes, [coin, {policyId: {assetName: qty}}]]
      const multiAssetMap: CborSchemaType = {
        _tag: CborKinds.Map,
        entries: [{
          k: cborBytes(testHash28),
          v: { _tag: CborKinds.Map, entries: [{
            k: cborBytes(new Uint8Array([0x41, 0x42])), // "AB"
            v: cborUint(100n),
          }] },
        }],
      }
      const valueCbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [cborUint(2000000n), multiAssetMap],
      }
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [cborBytes(testAddr), valueCbor],
      }
      const txOut = yield* decodeTxOut(cbor)
      assert.strictEqual(txOut.value.coin, 2000000n)
      assert.isDefined(txOut.value.multiAsset)
      assert.strictEqual(txOut.value.multiAsset!.length, 1)
    }),
  )

  it.effect("decodes Alonzo format: Array[addr, value, datumHash]", () =>
    Effect.gen(function*() {
      // Alonzo: [addrBytes, coinUInt, datumHash]
      // DatumOption for a hash is [0, hash32]
      const datumHash: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [cborUint(0n), cborBytes(testHash32)],
      }
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [cborBytes(testAddr), cborUint(3000000n), datumHash],
      }
      const txOut = yield* decodeTxOut(cbor)
      assert.strictEqual(txOut.value.coin, 3000000n)
      assert.isDefined(txOut.datumOption)
    }),
  )

  it.effect("decodes Babbage/Conway format: Map{0,1,2,3}", () =>
    Effect.gen(function*() {
      const cbor = cborMap([
        { k: cborUint(0n), v: cborBytes(testAddr) },
        { k: cborUint(1n), v: cborUint(4000000n) },
      ])
      const txOut = yield* decodeTxOut(cbor)
      assert.strictEqual(txOut.value.coin, 4000000n)
      assert.isUndefined(txOut.datumOption)
    }),
  )

  it.effect("round-trips Shelley TxOut through encode/decode", () =>
    Effect.gen(function*() {
      // Decode from Shelley array format
      const shelleyCbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [cborBytes(testAddr), cborUint(1000000n)],
      }
      const txOut = yield* decodeTxOut(shelleyCbor)

      // Encode always produces Babbage Map format
      const encoded = encodeTxOut(txOut)
      assert.strictEqual(encoded._tag, CborKinds.Map)

      // Decode the Map format back
      const txOut2 = yield* decodeTxOut(encoded)
      assert.deepStrictEqual(txOut2.address, txOut.address)
      assert.strictEqual(txOut2.value.coin, txOut.value.coin)
    }),
  )
})

// ---------------------------------------------------------------------------
// Multi-era TxBody decode tests
// ---------------------------------------------------------------------------

describe("Multi-era TxBody decoding", () => {
  const makeTxIn = (hash: Uint8Array, idx: bigint): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [cborBytes(hash), cborUint(idx)],
  })

  const makeTxOut = (addr: Uint8Array, coin: bigint): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [cborBytes(addr), cborUint(coin)],
  })

  it.effect("decodes Shelley TxBody (bare array inputs, key 3=ttl)", () =>
    Effect.gen(function*() {
      const cbor = cborMap([
        { k: cborUint(0n), v: { _tag: CborKinds.Array, items: [makeTxIn(testHash32, 0n)] } },
        { k: cborUint(1n), v: { _tag: CborKinds.Array, items: [makeTxOut(testAddr, 2000000n)] } },
        { k: cborUint(2n), v: cborUint(200000n) },
        { k: cborUint(3n), v: cborUint(90000n) },
      ])
      const body = yield* decodeTxBody(cbor)
      assert.strictEqual(body.inputs.length, 1)
      assert.strictEqual(body.outputs.length, 1)
      assert.strictEqual(body.fee, 200000n)
      assert.strictEqual(body.ttl, 90000n)
    }),
  )

  it.effect("decodes Conway TxBody (Tag(258) inputs)", () =>
    Effect.gen(function*() {
      // Conway wraps inputs in Tag(258)
      const tag258Inputs: CborSchemaType = {
        _tag: CborKinds.Tag,
        tag: 258n,
        data: { _tag: CborKinds.Array, items: [makeTxIn(testHash32, 1n)] },
      }
      const cbor = cborMap([
        { k: cborUint(0n), v: tag258Inputs },
        { k: cborUint(1n), v: { _tag: CborKinds.Array, items: [makeTxOut(testAddr, 3000000n)] } },
        { k: cborUint(2n), v: cborUint(180000n) },
      ])
      const body = yield* decodeTxBody(cbor)
      assert.strictEqual(body.inputs.length, 1)
      assert.strictEqual(body.inputs[0]!.index, 1n)
      assert.strictEqual(body.fee, 180000n)
    }),
  )

  it.effect("decodes TxBody with key 6 (update proposal)", () =>
    Effect.gen(function*() {
      const updatePayload: CborSchemaType = { _tag: CborKinds.Array, items: [cborUint(42n)] }
      const cbor = cborMap([
        { k: cborUint(0n), v: { _tag: CborKinds.Array, items: [makeTxIn(testHash32, 0n)] } },
        { k: cborUint(1n), v: { _tag: CborKinds.Array, items: [makeTxOut(testAddr, 1000000n)] } },
        { k: cborUint(2n), v: cborUint(170000n) },
        { k: cborUint(6n), v: updatePayload },
      ])
      const body = yield* decodeTxBody(cbor)
      assert.isDefined(body.update)
      assert.isTrue(body.update!.length > 0)
    }),
  )
})

// ---------------------------------------------------------------------------
// Era tests
// ---------------------------------------------------------------------------

describe("Era", () => {
  it("enum values match CBOR block discriminants", () => {
    assert.strictEqual(Era.Byron, 0)
    assert.strictEqual(Era.Shelley, 1)
    assert.strictEqual(Era.Conway, 6)
  })
})
