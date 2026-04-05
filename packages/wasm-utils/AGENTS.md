# Agents - wasm-utils

Rust nightly WASM crate. Build with `nix build .#wasm-utils`, not cargo.

- Requires nightly Rust for WASM getrandom backend.
- pallas-crypto is patched for WASM (no file I/O). See `pallas-crypto-patched/`.
- Changes to crypto functions affect ledger block/tx verification.
- Output goes to `pkg/` (web target convention).
- KES verification is critical for block header validation.
