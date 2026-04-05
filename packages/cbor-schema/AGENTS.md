# Agents - cbor-schema

Foundation package. Changes here affect all downstream packages (ledger,
miniprotocols, apps/bootstrap).

- All types use Effect Schema. No `as Type` casts.
- Round-trip (encode -> parse -> encode) must be identity for all valid CBOR.
- Run identity tests after any change: `bunx --bun vitest run packages/cbor-schema`
- This package has zero workspace dependencies. Keep it that way.
