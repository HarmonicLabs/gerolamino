# cbor-schema

CBOR encoding/decoding schema definitions using Effect-TS. Foundation package
with no internal workspace dependencies.

## Structure

```
src/
  index.ts       <- re-exports
  schema.ts      <- CborSchema AST (discriminated union of CBOR types)
  parse.ts       <- CBOR bytes -> CborSchema decoder
  encode.ts      <- CborSchema -> CBOR bytes encoder
  __tests__/     <- encode, parse, identity (round-trip) tests
```

## Key Types

- `CborSchema` / `CborSchemaType` - discriminated union representing CBOR AST
- `CborDecodeError` - `Schema.TaggedErrorClass` for decode failures

## Dependencies

- `effect` ^4.0.0-beta.47

## Testing

```sh
bunx --bun vitest run packages/cbor-schema
```
