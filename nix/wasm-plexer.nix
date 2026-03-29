{ inputs, ... }: {
  perSystem = { system, lib, ... }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.rust-overlay.overlays.default ];
      };

      rustToolchain = pkgs.rust-bin.stable.latest.default.override {
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
        root = ../packages/wasm-plexer;
        fileset = craneLib.fileset.commonCargoSources ../packages/wasm-plexer;
      };

      commonArgs = {
        inherit src;
        pname = "wasm-plexer";
        version = "0.0.1";
        strictDeps = true;
        CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
        doCheck = false;
      };

      cargoArtifacts = craneLib.buildDepsOnly commonArgs;

      wasmPlexerRaw = craneLib.buildPackage (commonArgs // {
        inherit cargoArtifacts;
      });
    in
    {
      packages.wasm-plexer = pkgs.stdenv.mkDerivation {
        pname = "wasm-plexer";
        version = "0.0.1";
        dontUnpack = true;
        nativeBuildInputs = [ wasm-bindgen-cli ];
        buildPhase = ''
          wasm-bindgen ${wasmPlexerRaw}/lib/wasm_plexer.wasm \
            --target bundler \
            --out-dir $out
        '';
        dontInstall = true;
      };
    };
}
