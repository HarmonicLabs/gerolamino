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
          toolchain = (if rustChannel == "nightly"
          then pkgs.rust-bin.nightly.latest.default
          else pkgs.rust-bin.stable.latest.default).override {
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

      # Script to symlink Nix-built WASM outputs into the source tree
      # for NPM-style imports (package.json main → ./pkg/ or ./result/).
      # Usage: nix run .#link-wasm   (or just `link-wasm` inside devenv shell)
      packages.link-wasm = pkgs.writeShellScriptBin "link-wasm" ''
        ROOT="$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null || echo .)"
        ln -sfn "${config.packages.wasm-utils}" "$ROOT/packages/wasm-utils/pkg"
        ln -sfn "${config.packages.wasm-plexer}" "$ROOT/packages/wasm-plexer/result"
        echo "==> WASM packages linked"
      '';
    };
}
