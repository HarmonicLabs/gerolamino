import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"
import { Network } from "./primitives.ts"
import { Credential, CredentialKind, decodeCredential, encodeCredential } from "./credentials.ts"
import { Bytes28 } from "./hashes.ts"

// ────────────────────────────────────────────────────────────────────────────
// Address types (Conway era)
// Binary format: header byte + credential bytes
// Header nibbles: [type(4 bits)][payload info(4 bits)]
// ────────────────────────────────────────────────────────────────────────────

export enum AddrKind {
  Base = 0,
  Enterprise = 6,
  Reward = 14,
  Bootstrap = 8,
}

// Base address: payment + optional stake credential
export const BaseAddr = Schema.Struct({
  net: Schema.Enum(Network),
  pay: Credential,
  stake: Credential,
})
export type BaseAddr = Schema.Schema.Type<typeof BaseAddr>

// Enterprise address: payment credential only (no staking)
export const EnterpriseAddr = Schema.Struct({
  net: Schema.Enum(Network),
  pay: Credential,
})
export type EnterpriseAddr = Schema.Schema.Type<typeof EnterpriseAddr>

// Reward address: stake credential only (for withdrawals)
export const RwdAddr = Schema.Struct({
  net: Schema.Enum(Network),
  stake: Credential,
})
export type RwdAddr = Schema.Schema.Type<typeof RwdAddr>

// Bootstrap (Byron) address: opaque bytes
export const BootstrapAddr = Schema.Struct({
  bytes: Schema.Uint8Array,
})
export type BootstrapAddr = Schema.Schema.Type<typeof BootstrapAddr>

// Full address union
export const Addr = Schema.Union([
  Schema.TaggedStruct(AddrKind.Base, { ...BaseAddr.fields }),
  Schema.TaggedStruct(AddrKind.Enterprise, { ...EnterpriseAddr.fields }),
  Schema.TaggedStruct(AddrKind.Reward, { ...RwdAddr.fields }),
  Schema.TaggedStruct(AddrKind.Bootstrap, { ...BootstrapAddr.fields }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type Addr = Schema.Schema.Type<typeof Addr>

// ────────────────────────────────────────────────────────────────────────────
// Address binary encoding helpers
// Shelley addresses: header byte encodes type + network + credential kinds
// Header byte layout:
//   Bits 7-4: address type
//   Bits 3-0: network id (for Shelley) or additional type info
// ────────────────────────────────────────────────────────────────────────────

function credKindBit(cred: Credential): number {
  return cred._tag === CredentialKind.Script ? 1 : 0
}

function makeCredential(kind: CredentialKind, hash: Uint8Array): Credential {
  return { _tag: kind, hash }
}

// ────────────────────────────────────────────────────────────────────────────
// Address CBOR decode/encode helpers (reused by TxOut codec)
// CBOR: bytes (packed Shelley/Byron address)
// ────────────────────────────────────────────────────────────────────────────

export function decodeAddr(cbor: CborSchemaType): Effect.Effect<Addr, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Bytes)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Addr: expected CBOR bytes" }))

  const bytes = cbor.bytes
  if (bytes.length < 1)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Addr: empty bytes" }))

  const header = bytes[0]!
  const addrType = (header >> 4) & 0x0f
  const networkId = header & 0x0f
  const net = networkId === 1 ? Network.Mainnet : Network.Testnet

  // Base address types: 0b0000..0b0011 (bits 7-4 = 0-3)
  // payment cred kind = bit 4, stake cred kind = bit 5
  if (addrType <= 3) {
    if (bytes.length < 57)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Addr: base address too short" }))
    const payKind = (addrType & 1) === 0 ? CredentialKind.KeyHash : CredentialKind.Script
    const stakeKind = (addrType & 2) === 0 ? CredentialKind.KeyHash : CredentialKind.Script
    return Effect.succeed({
      _tag: AddrKind.Base as const,
      net,
      pay: makeCredential(payKind, bytes.slice(1, 29)),
      stake: makeCredential(stakeKind, bytes.slice(29, 57)),
    })
  }

  // Enterprise address types: 0b0110..0b0111 (bits 7-4 = 6-7)
  if (addrType === 6 || addrType === 7) {
    if (bytes.length < 29)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Addr: enterprise address too short" }))
    const payKind = (addrType & 1) === 0 ? CredentialKind.KeyHash : CredentialKind.Script
    return Effect.succeed({
      _tag: AddrKind.Enterprise as const,
      net,
      pay: makeCredential(payKind, bytes.slice(1, 29)),
    })
  }

  // Reward address types: 0b1110..0b1111 (bits 7-4 = 14-15)
  if (addrType === 14 || addrType === 15) {
    if (bytes.length < 29)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Addr: reward address too short" }))
    const stakeKind = (addrType & 1) === 0 ? CredentialKind.KeyHash : CredentialKind.Script
    return Effect.succeed({
      _tag: AddrKind.Reward as const,
      net,
      stake: makeCredential(stakeKind, bytes.slice(1, 29)),
    })
  }

  // Bootstrap (Byron) address: type 8
  if (addrType === 8) {
    return Effect.succeed({
      _tag: AddrKind.Bootstrap as const,
      bytes,
    })
  }

  return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Addr: unknown address type ${addrType}` }))
}

export const encodeAddr = Addr.match({
  [AddrKind.Base]: (a): CborSchemaType => {
    const payBit = credKindBit(a.pay)
    const stakeBit = credKindBit(a.stake)
    const addrType = (stakeBit << 1) | payBit
    const networkId = a.net === Network.Mainnet ? 1 : 0
    const header = (addrType << 4) | networkId
    const result = new Uint8Array(57)
    result[0] = header
    result.set(a.pay.hash, 1)
    result.set(a.stake.hash, 29)
    return { _tag: CborKinds.Bytes, bytes: result }
  },
  [AddrKind.Enterprise]: (a): CborSchemaType => {
    const payBit = credKindBit(a.pay)
    const addrType = 6 | payBit
    const networkId = a.net === Network.Mainnet ? 1 : 0
    const header = (addrType << 4) | networkId
    const result = new Uint8Array(29)
    result[0] = header
    result.set(a.pay.hash, 1)
    return { _tag: CborKinds.Bytes, bytes: result }
  },
  [AddrKind.Reward]: (a): CborSchemaType => {
    const stakeBit = credKindBit(a.stake)
    const addrType = 14 | stakeBit
    const networkId = a.net === Network.Mainnet ? 1 : 0
    const header = (addrType << 4) | networkId
    const result = new Uint8Array(29)
    result[0] = header
    result.set(a.stake.hash, 1)
    return { _tag: CborKinds.Bytes, bytes: result }
  },
  [AddrKind.Bootstrap]: (a): CborSchemaType => {
    return { _tag: CborKinds.Bytes, bytes: a.bytes }
  },
})

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode for RwdAddr specifically (used by withdrawals, certs)
// ────────────────────────────────────────────────────────────────────────────

export function decodeRwdAddr(cbor: CborSchemaType): Effect.Effect<RwdAddr, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Bytes)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RwdAddr: expected CBOR bytes" }))
  const bytes = cbor.bytes
  if (bytes.length < 29)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RwdAddr: too short" }))
  const header = bytes[0]!
  const addrType = (header >> 4) & 0x0f
  if (addrType !== 14 && addrType !== 15)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `RwdAddr: expected reward address type, got ${addrType}` }))
  const networkId = header & 0x0f
  const net = networkId === 1 ? Network.Mainnet : Network.Testnet
  const stakeKind = (addrType & 1) === 0 ? CredentialKind.KeyHash : CredentialKind.Script
  return Effect.succeed({
    net,
    stake: makeCredential(stakeKind, bytes.slice(1, 29)),
  })
}

export function encodeRwdAddr(addr: RwdAddr): CborSchemaType {
  const stakeBit = credKindBit(addr.stake)
  const addrType = 14 | stakeBit
  const networkId = addr.net === Network.Mainnet ? 1 : 0
  const header = (addrType << 4) | networkId
  const result = new Uint8Array(29)
  result[0] = header
  result.set(addr.stake.hash, 1)
  return { _tag: CborKinds.Bytes, bytes: result }
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codecs
// ────────────────────────────────────────────────────────────────────────────

export const AddrBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Addr, {
    decode: SchemaGetter.transformOrFail(decodeAddr),
    encode: SchemaGetter.transform(encodeAddr),
  }),
)

export const RwdAddrBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(RwdAddr, {
    decode: SchemaGetter.transformOrFail(decodeRwdAddr),
    encode: SchemaGetter.transform(encodeRwdAddr),
  }),
)
