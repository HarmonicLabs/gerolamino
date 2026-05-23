# Agents - wasm-plexer

Rust WASM crate + thin Effect v4 TS glue. Build with `nix build .#wasm-plexer`,
not cargo/wasm-pack.

- Frame format: BigEndian u32 time, u16 protocol ID, u16 payload length.
- Agency flag encoded in protocol ID high bit.
- Changes here affect all miniprotocol network communication.
- Output goes to `result/` (bundler target convention).

## Effect v4 (TS only)

- Services: `MuxFraming`, `FrameBuffer` via `Context.Service` + `Layer`.
- Errors: `FramingOpError` (`Schema.TaggedErrorClass`); wasm errors decoded
  with `Schema.isSchemaError` / `Schema.decodeUnknownOption` — no `as Type`.
- Tests: `@effect/vitest` `layer()` + `it.effect.prop`; assert failures with
  `Effect.exit` + `Exit.isFailure` + `Cause.findErrorOption`.

## Loader paths for miniprotocols

- **Bun / vitest**: `import "wasm-plexer"` → `src/index.ts` (`wasm-init.ts` TLA).
- **chrome-ext**: WXT alias `^wasm-plexer$` → `browser.js`; call `init()` at SW boot.
- Never use subpath imports (`wasm-plexer/index.ts`) in browser builds — they
  bypass the alias and break WASM init.
