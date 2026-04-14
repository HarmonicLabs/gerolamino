# apps/bootstrap

Bootstrap HTTP server. Serves Mithril snapshot data over REST. Uses Effect CLI
framework with Bun runtime and LMDB for block storage.

## Structure

```
src/
  cli.ts           <- Effect CLI entry point (Commands, Flags)
  server.ts        <- HTTP server (Bun.serve)
  openapi.ts       <- REST API schema
  loader.ts        <- snapshot loading (SnapshotMeta as Schema.Class)
  chunk-reader.ts  <- streaming block chunks from LMDB
  proxy.ts         <- upstream Cardano node proxy
  lmdb.ts          <- LMDB FFI integration (lazy init via Config.string)
  lmdb-kv.ts       <- key-value operations on LMDB databases
  errors.ts        <- Schema.TaggedErrorClass error types
  __tests__/
    integration.test.ts       <- full server integration
    chunk-reader.test.ts      <- chunk parsing
    lmdb-kv.test.ts           <- database operations
    full-stream-decode.test.ts <- E2E: stream + decode all ~4.5M blocks
```

## Dependencies

- `@effect/platform-bun` - Bun runtime layer (`BunRuntime.runMain`, `BunServices.layer`)
- `bootstrap` (workspace) - protocol client
- `cbor-schema` (workspace) - CBOR handling
- `ledger` (workspace) - block decoding
- `effect` ^4.0.0-beta.47

## Key Patterns

- **LMDB**: Loaded lazily via `initLmdb` effect reading `Config.string("LIBLMDB_PATH")`
- **FFI**: Bun FFI for native LMDB C library (`bun:ffi`)
- **CLI**: `Command.make()` + `Flag.string()` / `Flag.directory()` from `effect/unstable/cli`
- **Snapshot**: Dynamic slot discovery from LMDB directory listing (not hardcoded)

## Running

```sh
LIBLMDB_PATH=/path/to/liblmdb.so SNAPSHOT_PATH=/path/to/snapshot bun run apps/bootstrap/src/cli.ts serve
```

## Testing

```sh
bunx --bun vitest run apps/bootstrap
```

The full-stream-decode test requires a local Mithril snapshot (~16GB).

## Deployment

Containerized via `nix build .#bootstrap-image` (OCI image). Runs in Podman
on the production NixOS server. Mithril snapshot mounted as `/data` volume.
Port 3040.
