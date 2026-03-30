{
  description = "Gerolamo: In-browser Cardano node";

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
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devenv.flakeModule
        inputs.treefmt-nix.flakeModule
        ./nix
      ];
      systems = [ "x86_64-linux" ];
      perSystem = { config, self', inputs', pkgs, system, lib, ... }: {
        treefmt = {
          projectRootFile = "flake.nix";
          programs = {
            oxfmt.enable = true;
            nixpkgs-fmt.enable = true;
          };
        };

        devenv = {
          shells.default = {
            packages = with pkgs; [
              lmdb
              sqlite
              poppler-utils
              wasm-pack
              inputs.mithril.packages.${system}.mithril-client-cli
            ];

            languages = {
              rust = {
                enable = true;
                channel = "stable";
                targets = [ "wasm32-unknown-unknown" ];
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
