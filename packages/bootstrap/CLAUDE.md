# bootstrap (package)

Lightweight bootstrap protocol client for downloading Mithril snapshots.

## Structure

```
src/
  index.ts        <- re-exports
  protocol.ts     <- protocol definitions
  client.ts       <- Effect-based connect client
  client-raw.ts   <- raw client implementation
  errors.ts       <- Schema.TaggedErrorClass error types
  __tests__/      <- protocol.test.ts
```

## Dependencies

- `effect` ^4.0.0-beta.43 (minimal, no other workspace deps)

## Notes

This is the protocol client library. The server application is in
`apps/bootstrap/`. This package has intentionally minimal dependencies.

## Testing

```sh
bunx --bun vitest run packages/bootstrap
```
