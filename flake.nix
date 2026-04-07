{
  description = "Gerolamino: In-browser Cardano node";

  nixConfig = {
    extra-substituters = [ "https://cache.iog.io" ];
    extra-trusted-public-keys = [ "hydra.iohk.io:f/Ea+s+dFdN+3Y/G+FDgSq+a5NEWhJGzdjvKNGv0/EQ=" ];
  };

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

    determinate = {
      url = "https://flakehub.com/f/DeterminateSystems/determinate/3";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # IOG's Haskell.nix — handles IOG's tightly coupled dep cluster (CHaP, index-state)
    haskellNix = {
      url = "github:input-output-hk/haskell.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # IOG's LSM tree library
    lsm-tree-src = {
      url = "github:IntersectMBO/lsm-tree";
      flake = false;
    };

    # Ouroboros consensus — provides snapshot-converter for V1LMDB → V2LSM
    ouroboros-consensus = {
      url = "github:IntersectMBO/ouroboros-consensus";
    };

    # Cardano network configs (preprod, mainnet genesis files)
    # Using flake = false to avoid pulling in bitte/tullia/std dependency tree
    cardano-world = {
      url = "github:IntersectMBO/cardano-world";
      flake = false;
    };
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devenv.flakeModule
        inputs.treefmt-nix.flakeModule
        inputs.flake-root.flakeModule
        # inputs.haskell-flake.flakeModule  # not used — haskell.nix handles IOG deps
        ./nix
      ];

      # Project root as a Nix path — available in all modules via `config._module.args.root`
      _module.args.root = ./.;
      systems = [ "x86_64-linux" ];
      perSystem = { pkgs, system, config, ... }:
        let
          rustPkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [ inputs.rust-overlay.overlays.default ];
          };

          # Mithril client + verification keys (for snapshot download task)
          # Tests skipped: upstream reqwest HTTP tests fail in Nix sandbox (no CA certs)
          mithril-client = inputs.mithril.packages.${system}.mithril-client-cli.overrideAttrs (_: {
            doCheck = false;
          });
          mithrilSrc = inputs.mithril;
          mithrilEnv = {
            AGGREGATOR_ENDPOINT = "https://aggregator.release-preprod.api.mithril.network/aggregator";
            GENESIS_VERIFICATION_KEY = builtins.readFile
              "${mithrilSrc}/mithril-infra/configuration/release-preprod/genesis.vkey";
            ANCILLARY_VERIFICATION_KEY = builtins.readFile
              "${mithrilSrc}/mithril-infra/configuration/release-preprod/ancillary.vkey";
          };

          # Ouroboros consensus snapshot-converter (Mem/LMDB/LSM conversions)
          snapshot-converter = inputs.ouroboros-consensus.packages.${system}.snapshot-converter;

          # Preprod Cardano config + genesis files (for snapshot-converter)
          preprodConfigDir = "${inputs.cardano-world}/docs/environments/preprod";
        in
        {
          flake-root.projectRootFile = "flake.nix";
          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              oxfmt.enable = true;
              nixpkgs-fmt.enable = true;
              rustfmt.enable = true;
              rustfmt.package = rustPkgs.rust-bin.selectLatestNightlyWith
                (toolchain: toolchain.rustfmt);
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
                mithril-client
                snapshot-converter
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
                haskell = {
                  enable = true;
                  cabal.enable = true;
                  stack.enable = true;
                  lsp.enable = true;
                };
              };

              # --- Process Manager: process-compose with TUI ---
              process.manager.implementation = "process-compose";

              # --- Environment ---
              env = {
                LIBLMDB_PATH = "${pkgs.lib.getLib pkgs.lmdb}/lib/liblmdb.so";
                BOOTSTRAP_SERVER_URL = "http://decentralizationmaxi.io:3040";
              };

              # --- Tasks ---

              tasks."mithril:download-snapshot" = {
                description = "Download Mithril preprod snapshot and convert to V2LSM";
                status = ''[ -d "$DEVENV_STATE/snapshot/lsm" ]'';
                before = [ "devenv:enterShell" ];
                showOutput = true;
                env = mithrilEnv // {
                  PATH = pkgs.lib.makeBinPath [
                    mithril-client
                    snapshot-converter
                    pkgs.coreutils
                    pkgs.jq
                    pkgs.findutils
                  ];
                };
                exec = ''
                  DEST="$DEVENV_STATE/snapshot"
                  WORK="$(mktemp -d)"
                  trap 'rm -rf "$WORK"' EXIT

                  echo "==> Downloading Mithril preprod snapshot..."
                  mithril-client cardano-db snapshot list --json | jq '.[0]'
                  mithril-client cardano-db download latest --include-ancillary --download-dir "$WORK"

                  SNAP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
                  [ -z "$SNAP_DIR" ] && echo "ERROR: No snapshot found" >&2 && exit 1

                  # Find the ledger slot directory (e.g., ledger/119747816)
                  SLOT_DIR="$(find "$SNAP_DIR/ledger" -maxdepth 1 -type d -regex '.*/[0-9]+' | head -1)"
                  [ -z "$SLOT_DIR" ] && echo "ERROR: No ledger slot directory found" >&2 && exit 1
                  SLOT="$(basename "$SLOT_DIR")"

                  echo "==> Converting Mem → V2LSM for slot $SLOT..."
                  snapshot-converter \
                    --input-mem "$SLOT_DIR" \
                    --output-lsm-snapshot "$SNAP_DIR/lsm-snapshot/$SLOT" \
                    --output-lsm-database "$SNAP_DIR/lsm" \
                    --config "${preprodConfigDir}/config.json"

                  mkdir -p "$DEST"
                  rm -rf "''${DEST:?}"/*
                  cp -r "$SNAP_DIR"/* "$DEST/"
                  echo "==> V2LSM snapshot installed at $DEST/lsm"
                '';
              };

              tasks."mithril:convert-to-lsm" = {
                description = "Convert existing Mem snapshot to V2LSM (no download)";
                status = ''[ -d "$DEVENV_STATE/snapshot/lsm" ]'';
                showOutput = true;
                env = {
                  PATH = pkgs.lib.makeBinPath [
                    snapshot-converter
                    pkgs.coreutils
                    pkgs.findutils
                  ];
                };
                exec = ''
                  DEST="$DEVENV_STATE/snapshot"
                  SLOT_DIR="$(find "$DEST/ledger" -maxdepth 1 -type d -regex '.*/[0-9]+' | head -1)"
                  [ -z "$SLOT_DIR" ] && echo "ERROR: No ledger slot directory found in $DEST/ledger" >&2 && exit 1
                  SLOT="$(basename "$SLOT_DIR")"

                  echo "==> Converting Mem → V2LSM for slot $SLOT..."
                  rm -rf "$DEST/lsm" "$DEST/lsm-snapshot"
                  mkdir -p "$DEST/lsm-snapshot/$SLOT" "$DEST/lsm"
                  snapshot-converter \
                    --input-mem "$SLOT_DIR" \
                    --output-lsm-snapshot "$DEST/lsm-snapshot/$SLOT" \
                    --output-lsm-database "$DEST/lsm" \
                    --config "${preprodConfigDir}/config.json"

                  echo "==> V2LSM snapshot at $DEST/lsm"
                '';
              };

              # --- Processes (managed by process-compose TUI via `devenv up`) ---

              processes.bootstrap = {
                exec = ''
                  export SNAPSHOT_PATH="$DEVENV_STATE/snapshot"
                  exec bun run apps/bootstrap/src/cli.ts serve \
                    --snapshot-path "$SNAPSHOT_PATH"
                '';
                process-compose = {
                  availability = {
                    restart = "on_failure";
                    max_restarts = 3;
                  };
                  readiness_probe = {
                    http_get = {
                      host = "127.0.0.1";
                      port = 3040;
                      path = "/";
                      scheme = "http";
                    };
                    initial_delay_seconds = 5;
                    period_seconds = 10;
                    timeout_seconds = 3;
                    failure_threshold = 5;
                  };
                };
              };

              # --- Containers (OCI images with full devenv shell) ---
              # Build:  devenv container build bootstrap
              # Push:   devenv container copy bootstrap
              # Run:    devenv container run bootstrap

              containers.bootstrap = {
                name = "gerolamino-bootstrap";
                version = "latest";
                startupCommand = "bun run apps/bootstrap/src/cli.ts serve --snapshot-path /data";
                registry = "docker://ghcr.io/harmoniclabs/";
                maxLayers = 20;
                enableLayerDeduplication = true;
              };

              # --- Scripts ---

              scripts.download-snapshot = {
                exec = "devenv tasks run mithril:download-snapshot";
                description = "Download Mithril preprod snapshot";
              };
            };
          };
        };
    };
}
