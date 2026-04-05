# Agents - apps/bootstrap

Bootstrap server application. Effect-TS CLI with Bun runtime.

- Use `Effect.gen` with `yield*` for all async flows.
- LMDB is loaded lazily via `Config.string("LIBLMDB_PATH")`. Never hardcode paths.
- Errors use `Schema.TaggedErrorClass` (LmdbError, SnapshotError, etc.).
- SnapshotMeta uses `Schema.Class`, not plain interfaces.
- No lodash. Use native Array methods.
- All imports at top of file. No `import()` inside functions.
- The protocol client library is `packages/bootstrap/`. This is the server.
- Container image built via `nix build .#bootstrap-image` (streamLayeredImage).
- Mithril snapshot is mounted at runtime, NOT baked into the image.
