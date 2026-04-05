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

## Source

Single file: `src/lib.rs` (~182 lines)
