# Bun runtime (re-exported from bun-overlay through our `nixpkgs.follows`
# wiring so the binary is rpath-patched against our nixpkgs's glibc).
#
# Why this re-export exists: `nix run github:0xbigboss/bun-overlay#bun ...`
# pulls Bun against bun-overlay's PINNED nixpkgs (`nixos-23.11`, glibc 2.38),
# which is incompatible with our Haskell/WASM toolchain closure — GHC-linked
# shared objects import `GLIBC_2.42` symbols that 2.38 doesn't provide.
#
# Going through `inputs'.bun-overlay.packages.bun` here re-evaluates the
# overlay against our nixos-unstable nixpkgs (via the
# `inputs.bun-overlay.inputs.nixpkgs.follows = "nixpkgs"` line in flake.nix),
# so the resulting Bun is rpath-patched against the same glibc that GHC built
# our shared libraries against. `nix run .#bun -- run ./apps/tui/src/index.ts
# start --headless` then loads WASM lsm-tree artefacts against the same glibc.
{ ... }: {
  perSystem = { inputs', ... }: {
    packages.bun = inputs'.bun-overlay.packages.bun;
  };
}
