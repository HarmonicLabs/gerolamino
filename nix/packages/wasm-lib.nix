# Shared Rust WASM build infrastructure.
# Provides `buildWasmPackage` as a perSystem module arg.
{ inputs, root, ... }: {
  perSystem = { system, lib, config, ... }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.rust-overlay.overlays.default ];
      };

      wasm-bindgen-cli-src = pkgs.fetchCrate {
        pname = "wasm-bindgen-cli";
        version = "0.2.115";
        hash = "sha256-wRynyZKYEMoIhX64n4DkGG2iepU6rE5qdBjT1LkUgtE=";
      };

      wasm-bindgen-cli = pkgs.buildWasmBindgenCli {
        src = wasm-bindgen-cli-src;
        cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
          inherit (wasm-bindgen-cli-src) pname version;
          src = wasm-bindgen-cli-src;
          hash = "sha256-+7hgX56dOo/GErpf/unRprv72Kkars5dOFew+NfZZMY=";
        };
      };

      buildWasmPackage =
        { pname
        , version
        , rustChannel ? "stable"
        , src
        , bindgenTarget
        , optimize ? false
        , extraArgs ? { }
        }:
        let
          # Exact version pins so `nix build .#{wasm-utils,wasm-plexer} --check`
          # stays bit-for-bit reproducible regardless of when rust-overlay is
          # updated. Bump deliberately (never float on `.latest`). Last bumped
          # 2026-04-20 — nightly toolchain date matches stable release 1.95.0.
          toolchain = (if rustChannel == "nightly"
          then pkgs.rust-bin.nightly."2026-04-20".default
          else pkgs.rust-bin.stable."1.95.0".default).override {
            targets = [ "wasm32-unknown-unknown" ];
          };

          craneLib = (inputs.crane.mkLib pkgs).overrideToolchain (_: toolchain);

          snakeName = builtins.replaceStrings [ "-" ] [ "_" ] pname;

          commonArgs = {
            inherit src pname version;
            strictDeps = true;
            CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
            doCheck = false;
          } // extraArgs;

          cargoArtifacts = craneLib.buildDepsOnly commonArgs;

          rawWasm = craneLib.buildPackage (commonArgs // {
            inherit cargoArtifacts;
          });
        in
        pkgs.stdenv.mkDerivation {
          inherit pname version;
          dontUnpack = true;
          nativeBuildInputs = [ wasm-bindgen-cli ] ++ lib.optionals optimize [ pkgs.binaryen ];
          buildPhase = ''
            wasm-bindgen ${rawWasm}/lib/${snakeName}.wasm \
              --target ${bindgenTarget} \
              --out-dir $out
          '' + lib.optionalString optimize ''
            wasm-opt $out/${snakeName}_bg.wasm \
              -o $out/${snakeName}_bg.wasm \
              -Oz --enable-bulk-memory || true
          '';
          dontInstall = true;
        };
    in
    {
      _module.args.buildWasmPackage = buildWasmPackage;

      # Build WASM derivations and point the source-tree consumer paths
      # (`packages/wasm-utils/pkg`, `packages/wasm-plexer/result`) at the
      # resulting /nix/store outputs via `nix build -o <path>`.
      #
      # Using `-o <path>` means each invocation re-evaluates the derivation
      # and updates the symlink atomically — no stale pointers after a WASM
      # source edit. Consuming TS code imports through these paths
      # (see tsconfig.base.json aliases + package.json `main`).
      #
      # Usage: nix run .#link-wasm   (or just `link-wasm` inside devenv shell)
      packages.link-wasm = pkgs.writeShellScriptBin "link-wasm" ''
        set -eu
        cd "$(${lib.getExe config.flake-root.package})"
        # Clear any stale target (directory from an older cp-based build, or
        # a symlink pointing at a garbage-collected /nix/store path) so
        # `nix build -o` lands a fresh symlink. Both paths are fully
        # gitignored (`*` in their .gitignore), so nothing tracked is lost.
        rm -rf packages/wasm-utils/pkg packages/wasm-plexer/result
        nix build -o packages/wasm-utils/pkg .#wasm-utils
        nix build -o packages/wasm-plexer/result .#wasm-plexer
        echo "==> WASM outputs linked into source tree"
      '';
    };
}
