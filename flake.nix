{
  description = "Gerolamino: In-browser Cardano node";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    devenv = {
      url = "github:cachix/devenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    crane.url = "github:ipetkov/crane";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    mithril = {
      url = "github:input-output-hk/mithril";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # IOG's libsodium fork with VRF (crypto_vrf_ietfdraft13)
    libsodium-iog = {
      url = "github:input-output-hk/libsodium";
      flake = false;
    };

    mk-shell-bin.url = "github:rrbutani/nix-mk-shell-bin";

    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    deploy-rs = {
      url = "github:serokell/deploy-rs";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    flake-root.url = "github:srid/flake-root";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devenv.flakeModule
        inputs.treefmt-nix.flakeModule
        inputs.flake-root.flakeModule
        ./nix
      ];

      # Project root as a Nix path — available in all modules via `config._module.args.root`
      _module.args.root = ./.;
      systems = [ "x86_64-linux" ];
      perSystem = { pkgs, system, config, ... }: {
        flake-root.projectRootFile = "flake.nix";
        treefmt = {
          projectRootFile = "flake.nix";
          programs = {
            oxfmt.enable = true;
            nixpkgs-fmt.enable = true;
          };
        };

        devenv = {
          shells.default = {
            devenv.root =
              let
                envRoot = builtins.getEnv "PWD";
              in
              if envRoot != "" then envRoot else builtins.toString ./.;
            packages = [
              pkgs.lmdb
              pkgs.sqlite
              pkgs.poppler-utils
              pkgs.wasm-pack
              pkgs.binaryen
              config.flake-root.package
            ];

            languages = {
              nix = {
                enable = true;
                lsp.enable = true;
              };
              zig = {
                enable = true;
                lsp.enable = true;
              };
              rust = {
                enable = true;
                channel = "nightly";
                targets = [ "wasm32-unknown-unknown" ];
                lsp.enable = true;
              };
              typescript = {
                enable = true;
                lsp.enable = true;
              };
              javascript = {
                enable = true;
                npm.enable = true;
                bun.enable = true;
              };
            };
          };
        };
      };
    };
}
