# wasm-plexer

Ouroboros mini-protocol multiplexer compiled to WASM from Rust.

## What it Does

Handles framing for the Ouroboros multiplexer wire format:

- `wrap_multiplexer_message()` - wraps payloads with headers (time, protocol ID, agency, length)
- `unwrap_multiplexer_message()` - parses frames and extracts metadata
- `MultiplexerBuffer` - stateful buffer for accumulating chunks and yielding complete frames

## Build

```sh
nix build .#wasm-plexer
```

Do NOT use `cargo build` or `wasm-pack` directly. The Nix build handles
crane, wasm-bindgen, and output placement.

- Rust edition: 2024 (stable toolchain)
- wasm-bindgen target: `bundler`
- Output: `result/` directory (JS bindings + WASM binary)
- Optimization: `opt-level = "s"` (small code size)

## Dependencies

- `wasm-bindgen` 0.2.84 - Rust-JS bindings
- `byteorder` 1.4 - BigEndian binary serialization
- `js-sys`, `web-sys` - JS/DOM interop

## Integration

Consumed by `packages/miniprotocols` via workspace dependency.
In Nix builds, output is injected at `packages/wasm-plexer/result/` during
`postUnpack`.

### Loader paths (Bun vs browser)

wasm-bindgen `target=bundler` emits `wasm_plexer.js` that assumes the host
bundler substitutes a live `WebAssembly.Instance.exports` for the `.wasm`
import. Neither Bun nor Chrome MV3 service workers do that automatically, so
this package ships two TS loaders:

| Host | Entry | Init model | Who uses it |
|------|-------|------------|-------------|
| **Bun** (vitest, TUI, miniprotocols tests) | `src/index.ts` → `src/wasm-init.ts` | Top-level await: `Bun.file` + `WebAssembly.instantiate` wires `__wbg_set_wasm` before any export runs | tsconfig alias `wasm-plexer` → `src/index.ts` |
| **Browser** (chrome-ext SW / offscreen) | `browser.js` | Explicit `init()` — idempotent `fetch` + `WebAssembly.instantiate`; **no TLA** (MV3 SW registration blocks on pending TLA) | `wxt.config.ts` alias `^wasm-plexer$` → `browser.js` |

**`packages/miniprotocols` consumers**: import the bare specifier only:

```typescript
import { wrap_multiplexer_message, MultiplexerBuffer } from "wasm-plexer";
```

Under Bun/vitest the tsconfig alias resolves to `src/index.ts` (WASM already
initialized). Under chrome-ext WXT the alias swaps in `browser.js`; the SW
must `await init()` once at boot before any miniprotocols code runs (see
`packages/chrome-ext/entrypoints/offscreen/bootstrap-sync.ts`). Subpath imports
like `wasm-plexer/index.ts` or `wasm-plexer/src/...` **bypass** the WXT alias
and pull `wasm-init.ts` (Bun TLA) into the browser bundle — that breaks at
runtime.

Preferred Effect API for new code: `MuxFraming` + `FrameBuffer` services
(`src/service.ts`) with `FramingOpError` (`Schema.TaggedErrorClass`). Raw
wasm-bindgen exports remain for `miniprotocols/multiplexer/` back-compat.

## TypeScript layout

```
src/
  index.ts       — barrel; re-exports services + raw wasm API
  wasm-init.ts   — Bun loader (TLA)
  service.ts     — MuxFraming + FrameBuffer Context.Service layers
  errors.ts      — FramingOpError, fromWasmError
  schemas.ts     — WrappedFrame Schema.Struct
  __tests__/     — @effect/vitest property tests (FastCheck)
browser.js       — browser loader (fetch + init())
```

## Source

Single file: `src/lib.rs` (~182 lines)
