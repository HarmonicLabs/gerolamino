# Agents - wasm-plexer

Rust WASM crate. Build with `nix build .#wasm-plexer`, not cargo/wasm-pack.

- Frame format: BigEndian u32 time, u16 protocol ID, u16 payload length.
- Agency flag encoded in protocol ID high bit.
- Changes here affect all miniprotocol network communication.
- Output goes to `result/` (bundler target convention).
