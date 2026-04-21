import { Effect, Option, Schema, SchemaIssue } from "effect";
import { cborCodec, CborKinds, type CborSchemaType, CborValue as CborValueSchema } from "codecs";
import { Network } from "../core/primitives.ts";
import { Credential, CredentialKind } from "../core/credentials.ts";

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
});
export type BaseAddr = typeof BaseAddr.Type;

// Enterprise address: payment credential only (no staking)
export const EnterpriseAddr = Schema.Struct({
  net: Schema.Enum(Network),
  pay: Credential,
});
export type EnterpriseAddr = typeof EnterpriseAddr.Type;

// Reward address: stake credential only (for withdrawals)
export const RwdAddr = Schema.Struct({
  net: Schema.Enum(Network),
  stake: Credential,
});
export type RwdAddr = typeof RwdAddr.Type;

// Bootstrap (Byron) address: opaque bytes
export const BootstrapAddr = Schema.Struct({
  bytes: Schema.Uint8Array,
});
export type BootstrapAddr = typeof BootstrapAddr.Type;

// Full address union
export const Addr = Schema.Union([
  Schema.TaggedStruct(AddrKind.Base, { ...BaseAddr.fields }),
  Schema.TaggedStruct(AddrKind.Enterprise, { ...EnterpriseAddr.fields }),
  Schema.TaggedStruct(AddrKind.Reward, { ...RwdAddr.fields }),
  Schema.TaggedStruct(AddrKind.Bootstrap, { ...BootstrapAddr.fields }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type Addr = typeof Addr.Type;

// ────────────────────────────────────────────────────────────────────────────
// Address binary encoding helpers
// Shelley addresses: header byte encodes type + network + credential kinds
// Header byte layout:
//   Bits 7-4: address type
//   Bits 3-0: network id (for Shelley) or additional type info
// ────────────────────────────────────────────────────────────────────────────

const credKindBit = Credential.match({
  [CredentialKind.KeyHash]: () => 0,
  [CredentialKind.Script]: () => 1,
});

const credKindFromBit = (bit: number): CredentialKind =>
  bit === 0 ? CredentialKind.KeyHash : CredentialKind.Script;

// ────────────────────────────────────────────────────────────────────────────
// Address CBOR decode/encode helpers (reused by TxOut codec)
// CBOR: bytes (packed Shelley/Byron address)
// ────────────────────────────────────────────────────────────────────────────

export function decodeAddr(cbor: CborSchemaType): Effect.Effect<Addr, SchemaIssue.Issue> {
  if (!CborValueSchema.guards[CborKinds.Bytes](cbor))
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Addr: expected CBOR bytes" }),
    );

  const bytes = cbor.bytes;
  if (bytes.length < 1)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Addr: empty bytes" }),
    );

  const header = bytes[0]!;
  const addrType = (header >> 4) & 0x0f;
  const networkId = header & 0x0f;
  const net = networkId === 1 ? Network.Mainnet : Network.Testnet;

  switch (addrType) {
    // Base address types: 0b0000..0b0011 — bit 0 = pay cred kind, bit 1 = stake cred kind.
    case 0:
    case 1:
    case 2:
    case 3: {
      if (bytes.length < 57)
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: "Addr: base address too short",
          }),
        );
      const payKind = credKindFromBit(addrType & 1);
      const stakeKind = credKindFromBit((addrType >> 1) & 1);
      return Effect.succeed(
        Addr.cases[AddrKind.Base].make({
          net,
          pay: Credential.make({ _tag: payKind, hash: bytes.slice(1, 29) }),
          stake: Credential.make({ _tag: stakeKind, hash: bytes.slice(29, 57) }),
        }),
      );
    }

    // Enterprise address types: 0b0110..0b0111.
    case 6:
    case 7: {
      if (bytes.length < 29)
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: "Addr: enterprise address too short",
          }),
        );
      const payKind = credKindFromBit(addrType & 1);
      return Effect.succeed(
        Addr.cases[AddrKind.Enterprise].make({
          net,
          pay: Credential.make({ _tag: payKind, hash: bytes.slice(1, 29) }),
        }),
      );
    }

    // Reward address types: 0b1110..0b1111.
    case 14:
    case 15: {
      if (bytes.length < 29)
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: "Addr: reward address too short",
          }),
        );
      const stakeKind = credKindFromBit(addrType & 1);
      return Effect.succeed(
        Addr.cases[AddrKind.Reward].make({
          net,
          stake: Credential.make({ _tag: stakeKind, hash: bytes.slice(1, 29) }),
        }),
      );
    }

    // Bootstrap (Byron): type 8.
    case 8:
      return Effect.succeed(Addr.cases[AddrKind.Bootstrap].make({ bytes }));

    default:
      return Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: `Addr: unknown address type ${addrType}`,
        }),
      );
  }
}

export const encodeAddr = Addr.match({
  [AddrKind.Base]: (a) => {
    const payBit = credKindBit(a.pay);
    const stakeBit = credKindBit(a.stake);
    const addrType = (stakeBit << 1) | payBit;
    const networkId = a.net === Network.Mainnet ? 1 : 0;
    const header = (addrType << 4) | networkId;
    const result = new Uint8Array(57);
    result[0] = header;
    result.set(a.pay.hash, 1);
    result.set(a.stake.hash, 29);
    return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: result }));
  },
  [AddrKind.Enterprise]: (a) => {
    const payBit = credKindBit(a.pay);
    const addrType = 6 | payBit;
    const networkId = a.net === Network.Mainnet ? 1 : 0;
    const header = (addrType << 4) | networkId;
    const result = new Uint8Array(29);
    result[0] = header;
    result.set(a.pay.hash, 1);
    return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: result }));
  },
  [AddrKind.Reward]: (a) => {
    const stakeBit = credKindBit(a.stake);
    const addrType = 14 | stakeBit;
    const networkId = a.net === Network.Mainnet ? 1 : 0;
    const header = (addrType << 4) | networkId;
    const result = new Uint8Array(29);
    result[0] = header;
    result.set(a.stake.hash, 1);
    return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: result }));
  },
  [AddrKind.Bootstrap]: (a) =>
    Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: a.bytes })),
});

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode for RwdAddr specifically (used by withdrawals, certs)
// ────────────────────────────────────────────────────────────────────────────

export function decodeRwdAddr(cbor: CborSchemaType): Effect.Effect<RwdAddr, SchemaIssue.Issue> {
  if (!CborValueSchema.guards[CborKinds.Bytes](cbor))
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RwdAddr: expected CBOR bytes" }),
    );
  const bytes = cbor.bytes;
  if (bytes.length < 29)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RwdAddr: too short" }),
    );
  const header = bytes[0]!;
  const addrType = (header >> 4) & 0x0f;
  if (addrType !== 14 && addrType !== 15)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: `RwdAddr: expected reward address type, got ${addrType}`,
      }),
    );
  const networkId = header & 0x0f;
  const net = networkId === 1 ? Network.Mainnet : Network.Testnet;
  const stakeKind = credKindFromBit(addrType & 1);
  return Effect.succeed(
    RwdAddr.make({
      net,
      stake: Credential.make({ _tag: stakeKind, hash: bytes.slice(1, 29) }),
    }),
  );
}

export function encodeRwdAddr(addr: RwdAddr): Effect.Effect<CborSchemaType, SchemaIssue.Issue> {
  const stakeBit = credKindBit(addr.stake);
  const addrType = 14 | stakeBit;
  const networkId = addr.net === Network.Mainnet ? 1 : 0;
  const header = (addrType << 4) | networkId;
  const result = new Uint8Array(29);
  result[0] = header;
  result.set(addr.stake.hash, 1);
  return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: result }));
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codecs
// ────────────────────────────────────────────────────────────────────────────

export const AddrBytes = cborCodec(Addr, decodeAddr, encodeAddr);

export const RwdAddrBytes = cborCodec(RwdAddr, decodeRwdAddr, encodeRwdAddr);
