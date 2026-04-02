import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborKinds, type CborSchemaType } from "cbor-schema"
import { Bytes28, Bytes32, isByteMaxLength } from "./hashes.ts"
import { Rational } from "./primitives.ts"
import { decodeRwdAddr, encodeRwdAddr, type RwdAddr } from "./address.ts"

// ────────────────────────────────────────────────────────────────────────────
// Relay — how to reach a stake pool
// CBOR: [0, port?, ipv4?, ipv6?] | [1, port, dnsName] | [2, dnsName]
// ────────────────────────────────────────────────────────────────────────────

export enum RelayKind {
  SingleHostAddr = 0,
  SingleHostName = 1,
  MultiHostName = 2,
}

export const Relay = Schema.Union([
  Schema.TaggedStruct(RelayKind.SingleHostAddr, {
    port: Schema.optional(Schema.Number),
    ipv4: Schema.optional(Schema.Uint8Array),
    ipv6: Schema.optional(Schema.Uint8Array),
  }),
  Schema.TaggedStruct(RelayKind.SingleHostName, {
    port: Schema.optional(Schema.Number),
    dnsName: Schema.String,
  }),
  Schema.TaggedStruct(RelayKind.MultiHostName, {
    dnsName: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type Relay = Schema.Schema.Type<typeof Relay>

// ────────────────────────────────────────────────────────────────────────────
// Pool Metadata
// CBOR: [url, metadataHash]
// ────────────────────────────────────────────────────────────────────────────

export const PoolMetadata = Schema.Struct({
  url: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
  hash: Bytes32,
})
export type PoolMetadata = Schema.Schema.Type<typeof PoolMetadata>

// ────────────────────────────────────────────────────────────────────────────
// PoolParams — stake pool registration parameters
// CBOR: [operator, vrfKeyhash, pledge, cost, margin, rewardAccount,
//        poolOwners, relays, poolMetadata]
// ────────────────────────────────────────────────────────────────────────────

export const PoolParams = Schema.Struct({
  operator: Bytes28,
  vrfKeyHash: Bytes32,
  pledge: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  cost: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  margin: Rational,
  rewardAccount: Schema.Uint8Array, // raw reward address bytes
  owners: Schema.Array(Bytes28),
  relays: Schema.Array(Relay),
  metadata: Schema.optional(PoolMetadata),
})
export type PoolParams = Schema.Schema.Type<typeof PoolParams>

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode helpers
// ────────────────────────────────────────────────────────────────────────────

function decodeCborNull(cbor: CborSchemaType): boolean {
  return cbor._tag === CborKinds.Simple && cbor.value === null
}

function decodeRelay(cbor: CborSchemaType): Effect.Effect<Relay, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length < 1)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Relay: expected non-empty array" }))
  const tag = cbor.items[0]
  if (tag?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Relay: expected uint tag" }))
  switch (Number(tag.num)) {
    case 0: {
      const port = cbor.items[1]?._tag === CborKinds.UInt ? Number(cbor.items[1].num) : undefined
      const ipv4 = cbor.items[2]?._tag === CborKinds.Bytes ? cbor.items[2].bytes : undefined
      const ipv6 = cbor.items[3]?._tag === CborKinds.Bytes ? cbor.items[3].bytes : undefined
      return Effect.succeed({ _tag: RelayKind.SingleHostAddr as const, port, ipv4, ipv6 })
    }
    case 1: {
      const port = cbor.items[1]?._tag === CborKinds.UInt ? Number(cbor.items[1].num) : undefined
      const dns = cbor.items[2]
      if (dns?._tag !== CborKinds.Text)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Relay SingleHostName: expected text dnsName" }))
      return Effect.succeed({ _tag: RelayKind.SingleHostName as const, port, dnsName: dns.text })
    }
    case 2: {
      const dns = cbor.items[1]
      if (dns?._tag !== CborKinds.Text)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Relay MultiHostName: expected text dnsName" }))
      return Effect.succeed({ _tag: RelayKind.MultiHostName as const, dnsName: dns.text })
    }
    default:
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Relay: unknown tag ${tag.num}` }))
  }
}

function encodeRelay(relay: Relay): CborSchemaType {
  const uint = (n: number): CborSchemaType => ({ _tag: CborKinds.UInt, num: BigInt(n) })
  const nullVal: CborSchemaType = { _tag: CborKinds.Simple, value: null }
  return Relay.match(relay, {
    [RelayKind.SingleHostAddr]: (r) => ({
      _tag: CborKinds.Array,
      items: [
        uint(0),
        r.port !== undefined ? uint(r.port) : nullVal,
        r.ipv4 !== undefined ? { _tag: CborKinds.Bytes, bytes: r.ipv4 } as CborSchemaType : nullVal,
        r.ipv6 !== undefined ? { _tag: CborKinds.Bytes, bytes: r.ipv6 } as CborSchemaType : nullVal,
      ],
    }) as CborSchemaType,
    [RelayKind.SingleHostName]: (r) => ({
      _tag: CborKinds.Array,
      items: [
        uint(1),
        r.port !== undefined ? uint(r.port) : nullVal,
        { _tag: CborKinds.Text, text: r.dnsName } as CborSchemaType,
      ],
    }) as CborSchemaType,
    [RelayKind.MultiHostName]: (r) => ({
      _tag: CborKinds.Array,
      items: [
        uint(2),
        { _tag: CborKinds.Text, text: r.dnsName } as CborSchemaType,
      ],
    }) as CborSchemaType,
  })
}

export function decodePoolParams(cbor: CborSchemaType): Effect.Effect<PoolParams, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length < 9)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: expected 9-element array" }))

  const [opCbor, vrfCbor, pledgeCbor, costCbor, marginCbor, rwdCbor, ownersCbor, relaysCbor, metaCbor] = cbor.items

  if (opCbor?._tag !== CborKinds.Bytes || opCbor.bytes.length !== 28)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid operator" }))
  if (vrfCbor?._tag !== CborKinds.Bytes || vrfCbor.bytes.length !== 32)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid vrfKeyHash" }))
  if (pledgeCbor?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid pledge" }))
  if (costCbor?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid cost" }))
  if (marginCbor?._tag !== CborKinds.Tag || marginCbor.tag !== 30n)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid margin (expected Tag(30))" }))
  if (marginCbor.data._tag !== CborKinds.Array || marginCbor.data.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid margin array" }))
  const marginNum = marginCbor.data.items[0]
  const marginDen = marginCbor.data.items[1]
  if (marginNum?._tag !== CborKinds.UInt || marginDen?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid margin components" }))
  if (rwdCbor?._tag !== CborKinds.Bytes)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid rewardAccount" }))
  if (ownersCbor?._tag !== CborKinds.Array)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid owners" }))
  if (relaysCbor?._tag !== CborKinds.Array)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid relays" }))

  const owners = ownersCbor.items.map((o) => {
    if (o._tag !== CborKinds.Bytes || o.bytes.length !== 28) throw new Error("PoolParams: invalid owner hash")
    return o.bytes
  })

  return Effect.all(relaysCbor.items.map(decodeRelay)).pipe(
    Effect.map((relays) => {
      const metadata = metaCbor && !decodeCborNull(metaCbor) && metaCbor._tag === CborKinds.Array
        ? {
          url: (metaCbor.items[0] as Extract<CborSchemaType, { _tag: CborKinds.Text }>).text,
          hash: (metaCbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Bytes }>).bytes,
        }
        : undefined

      return {
        operator: opCbor.bytes,
        vrfKeyHash: vrfCbor.bytes,
        pledge: pledgeCbor.num,
        cost: costCbor.num,
        margin: { numerator: marginNum.num, denominator: marginDen.num },
        rewardAccount: rwdCbor.bytes,
        owners,
        relays,
        metadata,
      }
    }),
  )
}

export function encodePoolParams(pp: PoolParams): CborSchemaType {
  const uint = (n: bigint): CborSchemaType => ({ _tag: CborKinds.UInt, num: n })
  const nullVal: CborSchemaType = { _tag: CborKinds.Simple, value: null }

  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.Bytes, bytes: pp.operator },
      { _tag: CborKinds.Bytes, bytes: pp.vrfKeyHash },
      uint(pp.pledge),
      uint(pp.cost),
      {
        _tag: CborKinds.Tag,
        tag: 30n,
        data: {
          _tag: CborKinds.Array,
          items: [uint(pp.margin.numerator), uint(pp.margin.denominator)],
        },
      },
      { _tag: CborKinds.Bytes, bytes: pp.rewardAccount },
      { _tag: CborKinds.Array, items: pp.owners.map((o) => ({ _tag: CborKinds.Bytes, bytes: o }) as CborSchemaType) },
      { _tag: CborKinds.Array, items: pp.relays.map(encodeRelay) },
      pp.metadata !== undefined
        ? {
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.Text, text: pp.metadata.url } as CborSchemaType,
            { _tag: CborKinds.Bytes, bytes: pp.metadata.hash } as CborSchemaType,
          ],
        }
        : nullVal,
    ],
  }
}
