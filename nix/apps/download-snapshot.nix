# Mithril snapshot download and LMDB conversion app.
# Downloads the latest preprod Cardano DB snapshot and converts it
# to the LMDB format required by the bootstrap server.
#
# Usage:  nix run .#download-snapshot -- /var/lib/gerolamino/snapshot
{ inputs, ... }: {
  perSystem = { system, lib, pkgs, ... }:
    let
      mithril-client = inputs.mithril.packages.${system}.mithril-client-cli;

      # Read verification keys from the Mithril source tree (pinned by flake.lock)
      mithrilSrc = inputs.mithril;
      genesisVkey = builtins.readFile
        "${mithrilSrc}/mithril-infra/configuration/release-preprod/genesis.vkey";
      ancillaryVkey = builtins.readFile
        "${mithrilSrc}/mithril-infra/configuration/release-preprod/ancillary.vkey";

      aggregatorEndpoint =
        "https://aggregator.release-preprod.api.mithril.network/aggregator";
    in
    {
      apps.download-snapshot = {
        type = "app";
        program = pkgs.writeShellApplication {
          name = "download-snapshot";
          runtimeInputs = [ mithril-client pkgs.coreutils pkgs.jq ];
          text = ''
            DEST="''${1:-/var/lib/gerolamino/snapshot}"
            WORK="$(mktemp -d)"
            trap 'rm -rf "$WORK"' EXIT

            export AGGREGATOR_ENDPOINT="${aggregatorEndpoint}"
            export GENESIS_VERIFICATION_KEY="${genesisVkey}"
            export ANCILLARY_VERIFICATION_KEY="${ancillaryVkey}"

            echo "==> Listing available Cardano DB snapshots..."
            mithril-client cardano-db snapshot list --json | jq '.[0]'

            echo "==> Downloading latest Cardano DB snapshot to $WORK..."
            mithril-client cardano-db download latest --download-dir "$WORK"

            SNAP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
            if [ -z "$SNAP_DIR" ]; then
              echo "ERROR: No snapshot directory found in $WORK" >&2
              exit 1
            fi

            echo "==> Downloaded snapshot at $SNAP_DIR"

            LEDGER_DIR="$(find "$SNAP_DIR/ledger" -mindepth 1 -maxdepth 1 -type d | head -1)"
            if [ -d "$LEDGER_DIR" ]; then
              echo "==> Converting snapshot to LMDB format..."
              mithril-client tools utxo-hd snapshot-converter \
                --input-dir "$LEDGER_DIR" \
                --output-dir "$LEDGER_DIR"
              echo "==> LMDB conversion complete"
            fi

            echo "==> Installing snapshot to $DEST..."
            mkdir -p "$DEST"
            rm -rf "''${DEST:?}"/*
            cp -r "$SNAP_DIR"/* "$DEST/"

            echo "==> Done. Snapshot installed at $DEST"
            ls -la "$DEST"
          '';
        };
      };
    };
}
