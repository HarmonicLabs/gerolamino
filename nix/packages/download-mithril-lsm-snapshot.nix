# Flake app: download a Mithril snapshot from our self-hosted aggregator
# (see ../machine-configs/mithril-services.nix) and convert it in-place
# to V2LSM so `apps/bootstrap` + consensus tests can consume it as a
# reproducible preprod fixture.
#
# Usage:
#   nix run .#download-mithril-lsm-snapshot -- [network] [output-dir]
#
# Defaults: network=preprod, output-dir=./mithril-fixture. Override
# the aggregator via $MITHRIL_AGGREGATOR_ENDPOINT — points at our
# production box on `decentralizationmaxi.io:8080` once Phase 0g-vii
# cuts over.
#
# Replaces the (historical) scp-from-production baseline — the
# aggregator runs the same cardano-node 10.7.x we do, so the snapshot
# metadata carries `tablesCodecVersion` and the single-step
# `tools utxo-hd snapshot-converter --utxo-hd-flavor LSM` call
# succeeds without the `--from-version` dance that failed against
# upstream aggregator snapshots (pre-10.7 tables layout).
{ inputs, root, ... }: {
  perSystem = { pkgs, inputs', ... }:
    let
      mithrilClient = inputs'.mithril.packages.mithril-client-cli;
      cardanoNodeBin = pkgs.callPackage ../machine-configs/cardano-node-bin.nix { };
      genesisVkey = root + "/nix/mithril-genesis/self-hosted.vkey";
    in
    {
      apps.download-mithril-lsm-snapshot = {
        type = "app";
        program = toString (pkgs.writeShellScript "download-mithril-lsm-snapshot" ''
          set -eu

          network="''${1:-preprod}"
          output="''${2:-./mithril-fixture}"
          aggregator="''${MITHRIL_AGGREGATOR_ENDPOINT:-http://decentralizationmaxi.io:8080/aggregator}"
          genesis_vkey_path="''${GENESIS_VERIFICATION_KEY_PATH:-${genesisVkey}}"

          # Refuse to run against the committed placeholder — the
          # post-deploy handoff has to happen for our genesis verification
          # to be meaningful. docs/deployment.md covers the handoff.
          if grep -q '^PLACEHOLDER$' "$genesis_vkey_path" 2>/dev/null; then
            echo "error: nix/mithril-genesis/self-hosted.vkey is still a placeholder." >&2
            echo "       Replace it with the aggregator's genesis.vkey after first deploy." >&2
            echo "       See docs/deployment.md." >&2
            exit 1
          fi

          mkdir -p "$output"

          cardano_version=$(${cardanoNodeBin}/bin/cardano-node --version \
            | head -1 | awk '{print $2}')

          echo "==> Downloading latest Cardano DB snapshot for $network"
          echo "    aggregator:          $aggregator"
          echo "    cardano-node:        $cardano_version"
          echo "    output:              $output"

          ${mithrilClient}/bin/mithril-client \
            --aggregator-endpoint "$aggregator" \
            --genesis-verification-key "$(cat "$genesis_vkey_path")" \
            cardano-db download latest \
            --download-dir "$output" \
            --include-ancillary

          echo "==> Converting snapshot to V2LSM (UtxoHDFlavor=LSM)"
          ${mithrilClient}/bin/mithril-client tools utxo-hd snapshot-converter \
            --db-directory "$output" \
            --cardano-node-version "$cardano_version" \
            --utxo-hd-flavor LSM \
            --commit

          echo "==> LSM fixture ready at $output/lsm/"
        '');
      };
    };
}
