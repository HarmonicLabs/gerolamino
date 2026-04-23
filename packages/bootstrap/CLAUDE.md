# bootstrap (package)

Lightweight bootstrap protocol client for downloading Mithril snapshots.

## Structure

```
src/
  index.ts        <- re-exports
  protocol.ts     <- Schema.TaggedStruct + toTaggedUnion("_tag") wire schema
  codec.ts        <- TLV frame encoder/decoder
  client.ts       <- Effect-based WebSocket client (Socket.makeWebSocket)
  snapshot.ts     <- local Mithril snapshot reader (disk-based fallback)
  errors.ts       <- Schema.TaggedErrorClass error types
  __tests__/      <- protocol.test.ts
```

## Dependencies

- `effect` ^4.0.0-beta.47
- `codecs` (workspace) — shared byte primitives only (`concat` re-exported as `concatBytes`)

## Notes

This is the protocol client library. The server application is in
`apps/bootstrap/`. Dependencies intentionally minimal — only the codecs byte
primitives + effect.

## Testing

```sh
bunx --bun vitest run packages/bootstrap
```
