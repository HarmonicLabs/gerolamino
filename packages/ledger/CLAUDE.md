# ledger

Cardano ledger model: addresses, values, transactions, blocks, scripts,
governance, certificates, protocol parameters, and consensus state.
Feature-complete with 100% Mithril snapshot decode coverage.

## Structure

```
src/
  index.ts
  lib/
    core/          <- primitives, hashes, credentials
    address/       <- Cardano address types and encoding
    value/         <- multi-asset values
    tx/            <- transaction types (all eras)
    script/        <- Plutus/native scripts
    block/         <- multi-era block decoding
    governance/    <- governance actions, voting
    pool/          <- stake pool operations
    certs/         <- certificates (delegation, registration, etc.)
    protocol-params/ <- protocol parameter types
    state/         <- ledger state types
  __tests__/       <- unit tests + benchmarks (bench-*.ts)
```

## Dependencies

- `codecs` (workspace) - CBOR parsing
- `wasm-utils` (workspace) - crypto primitives (blake2b, ed25519, KES, bech32)
- `@harmoniclabs/crypto` - additional crypto
- `effect` ^4.0.0-beta.47

## Key Patterns

- Types use `Schema.TaggedClass` with methods (not branded types)
- Multi-era block decoding via `decodeMultiEraBlock()`
- Hash types across eras share Schema-based constructors
- All decoders handle Byron through Conway eras

## FP discipline (ledger-wide invariants)

### Decoder naming

Every decoder is a top-level function:

```
decode<Subject>(cbor: CborValue): Effect.Effect<Subject, SchemaIssue.Issue>
```

Co-locate in the same file. Export only when a sibling module needs it.

### Banned patterns

- **Nested `Effect.gen`**. One-level gens allowed inside an exported decoder
  body OR inside `.pipe(Effect.flatMap(...))`. Never `yield* Effect.gen(...)`
  or `Effect.all(xs.map(x => Effect.gen(...)))`. Hoist inner gens to named
  helpers; or compose applicatively via `Effect.all([a, b] as const).pipe(
Effect.map(([a, b]) => ...))`.
- **Mutable accumulators** (`let x = ...`, `.push(...)`, `new Map(...)`,
  `new Set(...)`, `new Array(...)`) in decoder / ledger-arithmetic code.
  Replace with `Array.from(iter, mapper)`, `.reduce(...)`, `HashMap`,
  `HashSet`. _Exception_: procedural byte-assembly (building a `Uint8Array`
  byte-by-byte, bignum-from-bytes shifts). Comment each surviving site.
- **`_tag === / !==` dispatch on Schema tagged unions**. Use the union's
  `.match({...})`, `.guards[Kind]`, or `.isAnyOf(Kind)`.
- **Object-literal Schema-value construction** (`{ _tag: CborKinds.X, ... }`
  or `CborValueSchema.make({ _tag: CborKinds.X, ... })`). Use the `cborX`
  helpers in `core/cbor-utils.ts` (`cborBytes`, `cborText`, `cborMap`,
  `cborTagged`, `uint`, `negInt`, `arr`, `cborNull`) — they wrap
  `CborValueSchema.cases.X.make(...)` as the single source of truth.
- **Hex-as-identity** (`key.toHex() → Map key → Uint8Array.fromHex(key)`
  round-trip). Use `Data.Class<{ bytes: Uint8Array }>` + `HashMap` —
  structural identity, zero string overhead.
- **`for...of` over typed iterables** when `.map` / `.filter` / `.reduce` /
  `Array.from` composes cleanly. _Exception_: byte math (same as above).
- **Deeply-nested ternaries** (>2 levels). Use `.match`, `Match.value(...)`,
  or split into named intermediates.
- **Internal `Option` round-trips** (wrap/unwrap immediately). Keep
  `Option` at the schema boundary, not plumbed through helpers that always
  get `Some`.

## Testing

```sh
bunx --bun vitest run packages/ledger
bunx --bun vitest bench packages/ledger    # multi-era benchmarks
```

The full-snapshot E2E test streams ~4.5M blocks and decodes every one.
Requires a local Mithril snapshot.
