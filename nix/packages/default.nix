# Package derivation imports.
# Each package has its own module file for maintainability.
{
  imports = [
    ./wasm-plexer.nix
    ./wasm-utils.nix
    ./libsodium-vrf-wasm.nix
    ./miniprotocols.nix
    ./cbor-schema.nix
  ];
}
