import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"
import { Bytes28, Bytes32, Bytes64 } from "./hashes.ts"
import { decodeValue, encodeValue, Value } from "./value.ts"
import { decodeAddr, encodeAddr, Addr, decodeRwdAddr, encodeRwdAddr } from "./address.ts"
import { decodeDCert, encodeDCert, DCert } from "./certs.ts"
import { decodeTimelock, encodeTimelock, ScriptKind, type TimelockType } from "./script.ts"
import { CredentialKind, Credential, decodeCredential, encodeCredential } from "./credentials.ts"
import {
  decodeVoter, encodeVoter, decodeGovActionId, encodeGovActionId,
  decodeVotingProcedure, encodeVotingProcedure,
  type Voter, type GovActionId, type VotingProcedure, type ProposalProcedure,
  decodeAnchor, encodeAnchor, GovAction,
} from "./governance.ts"

// ────────────────────────────────────────────────────────────────────────────
// TxIn — [txId, index]
// ────────────────────────────────────────────────────────────────────────────

export const TxIn = Schema.Struct({
  txId: Bytes32,
  index: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
})
export type TxIn = Schema.Schema.Type<typeof TxIn>

export function decodeTxIn(cbor: CborSchemaType): Effect.Effect<TxIn, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxIn: expected 2-element array" }))
  const txId = cbor.items[0]
  if (txId?._tag !== CborKinds.Bytes || txId.bytes.length !== 32)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxIn: expected 32-byte txId" }))
  const idx = cbor.items[1]
  if (idx?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxIn: expected uint index" }))
  return Effect.succeed({ txId: txId.bytes, index: idx.num })
}

export function encodeTxIn(txIn: TxIn): CborSchemaType {
  return { _tag: CborKinds.Array, items: [
    { _tag: CborKinds.Bytes, bytes: txIn.txId },
    { _tag: CborKinds.UInt, num: txIn.index },
  ]}
}

// ────────────────────────────────────────────────────────────────────────────
// DatumOption — [0, dataHash] | [1, Tag(24, inlineDatum)]
// ────────────────────────────────────────────────────────────────────────────

export enum DatumOptionKind {
  DatumHash = 0,
  InlineDatum = 1,
}

export const DatumOption = Schema.Union([
  Schema.TaggedStruct(DatumOptionKind.DatumHash, { hash: Bytes32 }),
  Schema.TaggedStruct(DatumOptionKind.InlineDatum, { datum: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type DatumOption = Schema.Schema.Type<typeof DatumOption>

function decodeDatumOption(cbor: CborSchemaType): Effect.Effect<DatumOption, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DatumOption: expected 2-element array" }))
  const tag = cbor.items[0]
  if (tag?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DatumOption: expected uint tag" }))
  switch (Number(tag.num)) {
    case 0: {
      const hash = cbor.items[1]
      if (hash?._tag !== CborKinds.Bytes || hash.bytes.length !== 32)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DatumOption: expected 32-byte hash" }))
      return Effect.succeed({ _tag: DatumOptionKind.DatumHash as const, hash: hash.bytes } as DatumOption)
    }
    case 1: {
      const datum = cbor.items[1]
      // Inline datum is wrapped in Tag(24, bytes) — CBOR-encoded CBOR
      if (datum?._tag === CborKinds.Tag && datum.tag === 24n && datum.data._tag === CborKinds.Bytes) {
        return Effect.succeed({ _tag: DatumOptionKind.InlineDatum as const, datum: datum.data.bytes } as DatumOption)
      }
      // Some encoders put raw bytes
      if (datum?._tag === CborKinds.Bytes)
        return Effect.succeed({ _tag: DatumOptionKind.InlineDatum as const, datum: datum.bytes } as DatumOption)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DatumOption: expected Tag(24, bytes) or bytes for inline datum" }))
    }
    default:
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DatumOption: unknown tag ${tag.num}` }))
  }
}

function encodeDatumOption(opt: DatumOption): CborSchemaType {
  return DatumOption.match(opt, {
    [DatumOptionKind.DatumHash]: (d) => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 0n }, { _tag: CborKinds.Bytes, bytes: d.hash }],
    }) as CborSchemaType,
    [DatumOptionKind.InlineDatum]: (d) => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 1n },
        { _tag: CborKinds.Tag, tag: 24n, data: { _tag: CborKinds.Bytes, bytes: d.datum } },
      ],
    }) as CborSchemaType,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// TxOut — CBOR map: {0: addr, 1: value, ?2: datumOption, ?3: scriptRef}
// ────────────────────────────────────────────────────────────────────────────

export const TxOut = Schema.Struct({
  address: Schema.Uint8Array, // raw address bytes
  value: Value,
  datumOption: Schema.optional(DatumOption),
  scriptRef: Schema.optional(Schema.Uint8Array), // Tag(24, scriptBytes)
})
export type TxOut = Schema.Schema.Type<typeof TxOut>

export function decodeTxOut(cbor: CborSchemaType): Effect.Effect<TxOut, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Map)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxOut: expected CBOR map" }))

  const get = (key: number) =>
    cbor.entries.find((e) => e.k._tag === CborKinds.UInt && Number(e.k.num) === key)?.v

  const addrCbor = get(0)
  if (addrCbor?._tag !== CborKinds.Bytes)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxOut: missing/invalid address (key 0)" }))

  const valueCbor = get(1)
  if (!valueCbor)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxOut: missing value (key 1)" }))

  const datumCbor = get(2)
  const scriptCbor = get(3)

  return Effect.all({
    address: Effect.succeed(addrCbor.bytes),
    value: decodeValue(valueCbor),
    datumOption: datumCbor ? decodeDatumOption(datumCbor).pipe(Effect.map((d) => d as DatumOption | undefined)) : Effect.succeed(undefined),
    scriptRef: Effect.succeed(
      scriptCbor?._tag === CborKinds.Tag && scriptCbor.tag === 24n && scriptCbor.data._tag === CborKinds.Bytes
        ? scriptCbor.data.bytes
        : undefined,
    ),
  })
}

export function encodeTxOut(txOut: TxOut): CborSchemaType {
  const entry = (key: number, v: CborSchemaType | undefined) =>
    v !== undefined ? [{ k: { _tag: CborKinds.UInt, num: BigInt(key) } as CborSchemaType, v }] : []

  return {
    _tag: CborKinds.Map,
    entries: [
      ...entry(0, { _tag: CborKinds.Bytes, bytes: txOut.address }),
      ...entry(1, encodeValue(txOut.value)),
      ...entry(2, txOut.datumOption !== undefined ? encodeDatumOption(txOut.datumOption) : undefined),
      ...entry(3, txOut.scriptRef !== undefined
        ? { _tag: CborKinds.Tag, tag: 24n, data: { _tag: CborKinds.Bytes, bytes: txOut.scriptRef } }
        : undefined),
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TxRedeemer
// CBOR: [tag, index, data, exunits]
// ────────────────────────────────────────────────────────────────────────────

export enum TxRedeemerTag {
  Spend = 0,
  Mint = 1,
  Cert = 2,
  Reward = 3,
  Voting = 4,
  Proposing = 5,
}

export const TxRedeemer = Schema.Struct({
  tag: Schema.Enum(TxRedeemerTag),
  index: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  data: Schema.Uint8Array,
  exUnits: Schema.Struct({ mem: Schema.BigInt, steps: Schema.BigInt }),
})
export type TxRedeemer = Schema.Schema.Type<typeof TxRedeemer>

// ────────────────────────────────────────────────────────────────────────────
// VKeyWitness — [vkey, signature]
// ────────────────────────────────────────────────────────────────────────────

export const VKeyWitness = Schema.Struct({
  vkey: Bytes32,
  signature: Bytes64,
})
export type VKeyWitness = Schema.Schema.Type<typeof VKeyWitness>

// ────────────────────────────────────────────────────────────────────────────
// BootstrapWitness — [vkey, signature, chainCode, attributes]
// ────────────────────────────────────────────────────────────────────────────

export const BootstrapWitness = Schema.Struct({
  vkey: Bytes32,
  signature: Bytes64,
  chainCode: Bytes32,
  attributes: Schema.Uint8Array,
})
export type BootstrapWitness = Schema.Schema.Type<typeof BootstrapWitness>

// ────────────────────────────────────────────────────────────────────────────
// TxWitnessSet — sparse CBOR map {0?..7?}
// ────────────────────────────────────────────────────────────────────────────

export const TxWitnessSet = Schema.Struct({
  vkeyWitnesses: Schema.optional(Schema.Array(VKeyWitness)),
  nativeScripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
  bootstrapWitnesses: Schema.optional(Schema.Array(BootstrapWitness)),
  plutusV1Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
  plutusData: Schema.optional(Schema.Array(Schema.Uint8Array)),
  redeemers: Schema.optional(Schema.Array(TxRedeemer)),
  plutusV2Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
  plutusV3Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
})
export type TxWitnessSet = Schema.Schema.Type<typeof TxWitnessSet>

// ────────────────────────────────────────────────────────────────────────────
// TxBody — sparse CBOR map with keys 0-22
// ────────────────────────────────────────────────────────────────────────────

export const TxBody = Schema.Struct({
  inputs: Schema.Array(TxIn),                                          // key 0 (required)
  outputs: Schema.Array(TxOut),                                        // key 1 (required)
  fee: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),  // key 2 (required)
  ttl: Schema.optional(Schema.BigInt),                                 // key 3
  certs: Schema.optional(Schema.Array(DCert)),                         // key 4
  withdrawals: Schema.optional(Schema.Array(Schema.Struct({            // key 5
    rewardAccount: Schema.Uint8Array,
    coin: Schema.BigInt,
  }))),
  auxDataHash: Schema.optional(Bytes32),                               // key 7
  validityStart: Schema.optional(Schema.BigInt),                       // key 8
  mint: Schema.optional(Schema.Array(Schema.Struct({                   // key 9
    policy: Bytes28,
    assets: Schema.Array(Schema.Struct({ name: Schema.Uint8Array, quantity: Schema.BigInt })),
  }))),
  scriptDataHash: Schema.optional(Bytes32),                            // key 11
  collateral: Schema.optional(Schema.Array(TxIn)),                     // key 13
  requiredSigners: Schema.optional(Schema.Array(Bytes28)),             // key 14
  networkId: Schema.optional(Schema.BigInt),                           // key 15
  collateralReturn: Schema.optional(TxOut),                            // key 16
  totalCollateral: Schema.optional(Schema.BigInt),                     // key 17
  referenceInputs: Schema.optional(Schema.Array(TxIn)),                // key 18
  votingProcedures: Schema.optional(Schema.Uint8Array),                // key 19 (opaque for now)
  proposalProcedures: Schema.optional(Schema.Uint8Array),              // key 20 (opaque for now)
  currentTreasury: Schema.optional(Schema.BigInt),                     // key 21
  donation: Schema.optional(Schema.BigInt),                            // key 22
})
export type TxBody = Schema.Schema.Type<typeof TxBody>

// ────────────────────────────────────────────────────────────────────────────
// Tx — [body, witnesses, isValid, auxData?]
// ────────────────────────────────────────────────────────────────────────────

export const Tx = Schema.Struct({
  body: TxBody,
  witnesses: TxWitnessSet,
  isValid: Schema.Boolean,
  auxiliaryData: Schema.optional(Schema.Uint8Array),
})
export type Tx = Schema.Schema.Type<typeof Tx>

// ────────────────────────────────────────────────────────────────────────────
// TxBody CBOR codec helpers
// ────────────────────────────────────────────────────────────────────────────

function decodeMultiAssetEntries(cbor: CborSchemaType) {
  if (cbor._tag !== CborKinds.Map) return []
  return cbor.entries.map((e) => {
    if (e.k._tag !== CborKinds.Bytes) throw new Error("mint: expected bytes policyId")
    if (e.v._tag !== CborKinds.Map) throw new Error("mint: expected map of assets")
    return {
      policy: e.k.bytes,
      assets: e.v.entries.map((a) => {
        if (a.k._tag !== CborKinds.Bytes) throw new Error("mint: expected bytes assetName")
        if (a.v._tag !== CborKinds.UInt && a.v._tag !== CborKinds.NegInt) throw new Error("mint: expected int quantity")
        return { name: a.k.bytes, quantity: a.v.num }
      }),
    }
  })
}

export function decodeTxBody(cbor: CborSchemaType): Effect.Effect<TxBody, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Map)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxBody: expected CBOR map" }))

  const get = (key: number) =>
    cbor.entries.find((e) => e.k._tag === CborKinds.UInt && Number(e.k.num) === key)?.v

  // Required: inputs (key 0)
  const inputsCbor = get(0)
  if (!inputsCbor || inputsCbor._tag !== CborKinds.Array)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxBody: missing inputs (key 0)" }))

  // Required: outputs (key 1)
  const outputsCbor = get(1)
  if (!outputsCbor || outputsCbor._tag !== CborKinds.Array)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxBody: missing outputs (key 1)" }))

  // Required: fee (key 2)
  const feeCbor = get(2)
  if (!feeCbor || feeCbor._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxBody: missing fee (key 2)" }))

  // Optional fields
  const ttlCbor = get(3)
  const certsCbor = get(4)
  const wdrlCbor = get(5)
  const auxHashCbor = get(7)
  const validityStartCbor = get(8)
  const mintCbor = get(9)
  const scriptDataHashCbor = get(11)
  const collateralCbor = get(13)
  const reqSignersCbor = get(14)
  const networkIdCbor = get(15)
  const collReturnCbor = get(16)
  const totCollCbor = get(17)
  const refInputsCbor = get(18)
  const votingCbor = get(19)
  const proposalsCbor = get(20)
  const treasuryCbor = get(21)
  const donationCbor = get(22)

  return Effect.all({
    inputs: Effect.all(inputsCbor.items.map(decodeTxIn)),
    outputs: Effect.all(outputsCbor.items.map(decodeTxOut)),
    fee: Effect.succeed(feeCbor.num),
  }).pipe(Effect.map(({ inputs, outputs, fee }) => ({
    inputs,
    outputs,
    fee,
    ttl: ttlCbor?._tag === CborKinds.UInt ? ttlCbor.num : undefined,
    auxDataHash: auxHashCbor?._tag === CborKinds.Bytes && auxHashCbor.bytes.length === 32 ? auxHashCbor.bytes : undefined,
    validityStart: validityStartCbor?._tag === CborKinds.UInt ? validityStartCbor.num : undefined,
    mint: mintCbor ? decodeMultiAssetEntries(mintCbor) : undefined,
    scriptDataHash: scriptDataHashCbor?._tag === CborKinds.Bytes && scriptDataHashCbor.bytes.length === 32 ? scriptDataHashCbor.bytes : undefined,
    collateral: collateralCbor?._tag === CborKinds.Array
      ? collateralCbor.items.map((i) => {
          if (i._tag !== CborKinds.Array || i.items.length !== 2) throw new Error("collateral TxIn parse error")
          const txId = i.items[0]
          const idx = i.items[1]
          if (txId?._tag !== CborKinds.Bytes || idx?._tag !== CborKinds.UInt) throw new Error("collateral TxIn parse error")
          return { txId: txId.bytes, index: idx.num }
        })
      : undefined,
    requiredSigners: reqSignersCbor?._tag === CborKinds.Array
      ? reqSignersCbor.items.map((i) => {
          if (i._tag !== CborKinds.Bytes || i.bytes.length !== 28) throw new Error("requiredSigner parse error")
          return i.bytes
        })
      : undefined,
    networkId: networkIdCbor?._tag === CborKinds.UInt ? networkIdCbor.num : undefined,
    totalCollateral: totCollCbor?._tag === CborKinds.UInt ? totCollCbor.num : undefined,
    referenceInputs: refInputsCbor?._tag === CborKinds.Array
      ? refInputsCbor.items.map((i) => {
          if (i._tag !== CborKinds.Array || i.items.length !== 2) throw new Error("refInput TxIn parse error")
          const txId = i.items[0]
          const idx = i.items[1]
          if (txId?._tag !== CborKinds.Bytes || idx?._tag !== CborKinds.UInt) throw new Error("refInput TxIn parse error")
          return { txId: txId.bytes, index: idx.num }
        })
      : undefined,
    currentTreasury: treasuryCbor?._tag === CborKinds.UInt ? treasuryCbor.num : undefined,
    donation: donationCbor?._tag === CborKinds.UInt ? donationCbor.num : undefined,
  })))
}

export function encodeTxBody(body: TxBody): CborSchemaType {
  const uint = (n: bigint): CborSchemaType => ({ _tag: CborKinds.UInt, num: n })
  const entry = (key: number, v: CborSchemaType | undefined) =>
    v !== undefined ? [{ k: { _tag: CborKinds.UInt, num: BigInt(key) } as CborSchemaType, v }] : []

  const encodeMint = (mint: TxBody["mint"]): CborSchemaType | undefined => {
    if (!mint || mint.length === 0) return undefined
    return {
      _tag: CborKinds.Map,
      entries: mint.map((m) => ({
        k: { _tag: CborKinds.Bytes, bytes: m.policy } as CborSchemaType,
        v: {
          _tag: CborKinds.Map,
          entries: m.assets.map((a) => ({
            k: { _tag: CborKinds.Bytes, bytes: a.name } as CborSchemaType,
            v: (a.quantity >= 0n
              ? { _tag: CborKinds.UInt, num: a.quantity }
              : { _tag: CborKinds.NegInt, num: a.quantity }) as CborSchemaType,
          })),
        } as CborSchemaType,
      })),
    }
  }

  return {
    _tag: CborKinds.Map,
    entries: [
      ...entry(0, { _tag: CborKinds.Array, items: body.inputs.map(encodeTxIn) }),
      ...entry(1, { _tag: CborKinds.Array, items: body.outputs.map(encodeTxOut) }),
      ...entry(2, uint(body.fee)),
      ...entry(3, body.ttl !== undefined ? uint(body.ttl) : undefined),
      ...entry(4, body.certs && body.certs.length > 0 ? { _tag: CborKinds.Array, items: body.certs.map(encodeDCert) } : undefined),
      ...entry(7, body.auxDataHash !== undefined ? { _tag: CborKinds.Bytes, bytes: body.auxDataHash } : undefined),
      ...entry(8, body.validityStart !== undefined ? uint(body.validityStart) : undefined),
      ...entry(9, encodeMint(body.mint)),
      ...entry(11, body.scriptDataHash !== undefined ? { _tag: CborKinds.Bytes, bytes: body.scriptDataHash } : undefined),
      ...entry(13, body.collateral && body.collateral.length > 0 ? { _tag: CborKinds.Array, items: body.collateral.map(encodeTxIn) } : undefined),
      ...entry(14, body.requiredSigners && body.requiredSigners.length > 0
        ? { _tag: CborKinds.Array, items: body.requiredSigners.map((s) => ({ _tag: CborKinds.Bytes, bytes: s }) as CborSchemaType) }
        : undefined),
      ...entry(15, body.networkId !== undefined ? uint(body.networkId) : undefined),
      ...entry(16, body.collateralReturn !== undefined ? encodeTxOut(body.collateralReturn) : undefined),
      ...entry(17, body.totalCollateral !== undefined ? uint(body.totalCollateral) : undefined),
      ...entry(18, body.referenceInputs && body.referenceInputs.length > 0 ? { _tag: CborKinds.Array, items: body.referenceInputs.map(encodeTxIn) } : undefined),
      ...entry(21, body.currentTreasury !== undefined ? uint(body.currentTreasury) : undefined),
      ...entry(22, body.donation !== undefined ? uint(body.donation) : undefined),
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codecs
// ────────────────────────────────────────────────────────────────────────────

export const TxInBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxIn, {
    decode: SchemaGetter.transformOrFail(decodeTxIn),
    encode: SchemaGetter.transform(encodeTxIn),
  }),
)

export const TxOutBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxOut, {
    decode: SchemaGetter.transformOrFail(decodeTxOut),
    encode: SchemaGetter.transform(encodeTxOut),
  }),
)

export const TxBodyBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxBody, {
    decode: SchemaGetter.transformOrFail(decodeTxBody),
    encode: SchemaGetter.transform(encodeTxBody),
  }),
)
