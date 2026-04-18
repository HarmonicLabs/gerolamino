# codecs

Binary-codec foundation for the monorepo. Two format families live here:

- **CBOR** (`src/cbor/`) — RFC 8949 self-describing encoding. Used by every
  Cardano on-chain / network-protocol payload.
- **MemPack** (`src/mempack/`) — positional, native-endian encoding used by
  Cardano ledger state (UTxO, LSM-tree keys/values). Port of Haskell
  `Data.MemPack` typeclass.

No internal workspace dependencies.

## Structure

```
src/
  index.ts                    <- package-level barrel (re-exports cbor/ + mempack/)
  cbor/
    index.ts                  <- barrel
    CborValue.ts              <- tagged-union IR, _tag = RFC 8949 major type
    CborError.ts              <- CborDecodeError, CborEncodeError
    codec/                    <- bytes <-> CborValue (parse, encode, CborBytes)
    primitives/               <- CborValue constructors + narrowers
    derive/                   <- Layer 2 Schema-native derivation: toCodecCbor/
                                 toCodecCborBytes walker + six composite Links
                                 (taggedUnion, sparseMap, cborTagged, cborInCbor
                                 + cborInCborPreserving, strictMaybe, positionalArray)
    __tests__/                <- parse / identity / encode example tests
  mempack/
    index.ts                  <- barrel
    MemPackCodec.ts           <- { typeName, packedByteCount, packInto, unpack }
    MemPackError.ts           <- MemPackDecodeError, MemPackEncodeError
    primitives/               <- words, ints, bool, bytes, text, VarLen, Length, Tag
    cardano/                  <- Babbage TxOut + UTxO key decoders
    derive/                   <- toCodecMemPackBytes (manual-lift; walker TBD)
    __tests__/                <- primitives / cardano / derive tests
```

Every subdirectory has an `index.ts` barrel. Downstream code imports from
`codecs`, `codecs/cbor`, or `codecs/mempack` — never from individual files.

## Key Types

- `CborValue` — 8-variant tagged union (`_tag` = RFC 8949 major type 0..7).
  Dispatch via `.match()` / `.guards` / `.isAnyOf`.
- `MemPackCodec<T>` — `{ typeName, packedByteCount, packInto, unpack }`.
  Pure interface; composites concatenate byte ranges by offset threading.
- `CborDecodeError` / `CborEncodeError` / `MemPackDecodeError` /
  `MemPackEncodeError` — all `Schema.TaggedErrorClass` with a `cause` field.

## Dependencies

- `effect` ^4.0.0-beta.47

## ES2025 + TypeScript

This package opts into `target: esnext` / `lib: ["esnext"]` (the monorepo
baseline is es2024). Feature usage:

- `DataView.getFloat16` / `setFloat16` — native IEEE 754 binary16 I/O.
- `new ArrayBuffer(cap, { maxByteLength })` + `.resize()` +
  `.transferToFixedLength(n)` — growable CBOR encode buffer with zero-copy
  handoff, no manual `new Uint8Array(newCap)` + copy loops.
- `String.prototype.isWellFormed` — guard UTF-16 payloads before emitting
  CBOR Text (RFC 8949 §3.1).
- `Uint8Array.toHex` / `fromHex` — hex-string interchange for tests /
  fixtures.

Stock `tsc` 5.9 + `@typescript/native-preview` (tsgo, native Go rewrite)
both type-check the package.

## Testing

```sh
bunx --bun vitest run packages/codecs
```

Test layout mirrors source directory layout. When asserting byte equality on
`Uint8Array`, use `.toStrictEqual(...)`, not `.toEqual(...)` — Bun's
non-strict `deepEquals` treats sparse / `undefined`-carrying objects as equal
and that is not what you want for binary payloads.
