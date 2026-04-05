# wasm-utils

Cardano cryptographic primitives and address operations compiled to WASM from
Rust (nightly).

## Exported Functions

**Hashing**: `blake2b_256()`, `blake2b_224()`, `blake2b_256_tagged()` (domain separation)
**Ed25519**: `ed25519_secret_key_from_seed()`, `ed25519_public_key()`, `ed25519_sign()`, `ed25519_verify()`
**HD Wallets**: `ed25519_extended_public_key()`, `ed25519_extended_sign()`
**Addresses**: `address_to_bech32()`, `address_from_bech32()`, `address_to_hex()`, `address_from_hex()`, `address_network()`, `address_has_script()`, `address_type_id()`
**KES**: `kes_sum6_verify()` - Sum6 depth-6 key-evolving signatures

## Build

```sh
nix build .#wasm-utils
```

Do NOT use `cargo build` or `wasm-pack` directly.

- Rust edition: 2021 (nightly toolchain required)
- wasm-bindgen target: `web`
- Optimization: `opt-level = "z"` + LTO + `wasm-opt -Oz`
- WASM RNG: `--cfg getrandom_backend="wasm_js"` (`.cargo/config.toml`)
- Output: `pkg/` directory

## Patched Dependencies

`pallas-crypto-patched/` contains a fork of pallas-crypto with:

- `#[cfg(not(target_arch = "wasm32"))]` guards on file I/O functions
- KES `open_any()`, `open_both()`, `open_three()` disabled for WASM
- Core KES verification logic remains platform-agnostic

## Dependencies

- `pallas-crypto` (patched) - blake2b, ed25519, KES via cryptoxide
- `pallas-addresses` - Cardano address encoding
- `pallas-codec` - CBOR codec
- `hex` 0.4 - hex string conversion
- `getrandom` 0.2 + 0.3 (dual versions for dependency tree compat)

## Integration

Consumed by `packages/ledger`. In Nix builds, output injected at
`packages/wasm-utils/pkg/` during `postUnpack`.

## VRF (Optional)

`build-vrf.sh` compiles IOG's libsodium VRF to standalone WASM using `zig cc`.
Also available as Nix package: `nix build .#libsodium-vrf-wasm`.

## Source

Main: `src/lib.rs` (~236 lines)
