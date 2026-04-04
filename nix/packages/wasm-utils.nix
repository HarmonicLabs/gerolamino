{ inputs, ... }: {
  perSystem = { system, lib, ... }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.rust-overlay.overlays.default ];
      };

      rustToolchain = pkgs.rust-bin.nightly.latest.default.override {
        targets = [ "wasm32-unknown-unknown" ];
      };

      craneLib = (inputs.crane.mkLib pkgs).overrideToolchain (_: rustToolchain);

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

      src = lib.fileset.toSource {
        root = ../packages/wasm-utils;
        fileset = lib.fileset.unions [
          ../packages/wasm-utils/Cargo.toml
          ../packages/wasm-utils/src
          ../packages/wasm-utils/pallas-crypto-patched
          ../packages/wasm-utils/.cargo
        ];
      };

      commonArgs = {
        inherit src;
        pname = "wasm-utils";
        version = "0.1.0";
        strictDeps = true;
        CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
        doCheck = false;
        # getrandom wasm_js backend config
        CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS = "--cfg getrandom_backend=\"wasm_js\"";
      };

      cargoArtifacts = craneLib.buildDepsOnly commonArgs;

      wasmUtilsRaw = craneLib.buildPackage (commonArgs // {
        inherit cargoArtifacts;
      });
    in
    {
      packages.wasm-utils = pkgs.stdenv.mkDerivation {
        pname = "wasm-utils";
        version = "0.1.0";
        dontUnpack = true;
        nativeBuildInputs = [ wasm-bindgen-cli pkgs.binaryen ];
        buildPhase = ''
          # Run wasm-bindgen to generate JS glue (--target web for no circular deps)
          wasm-bindgen ${wasmUtilsRaw}/lib/wasm_utils.wasm \
            --target web \
            --out-dir $out

          # Optimize WASM binary
          wasm-opt $out/wasm_utils_bg.wasm -o $out/wasm_utils_bg.wasm -Oz --enable-bulk-memory || true
        '';
        dontInstall = true;
      };
    };
}
