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

- `cbor-schema` (workspace) - CBOR parsing
- `wasm-utils` (workspace) - crypto primitives (blake2b, ed25519, KES, bech32)
- `@harmoniclabs/crypto` - additional crypto
- `effect` ^4.0.0-beta.47

## Key Patterns

- Types use `Schema.TaggedClass` with methods (not branded types)
- Multi-era block decoding via `decodeMultiEraBlock()`
- Hash types across eras share Schema-based constructors
- All decoders handle Byron through Conway eras

## Testing

```sh
bunx --bun vitest run packages/ledger
bunx --bun vitest bench packages/ledger    # multi-era benchmarks
```

The full-snapshot E2E test streams ~4.5M blocks and decodes every one.
Requires a local Mithril snapshot.
