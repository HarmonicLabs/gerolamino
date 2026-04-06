# Production NixOS configuration for decentralizationmaxi.io
# Runs the Gerolamo bootstrap server in a Podman container.
#
# Deploy: nix run .#deploy
# SSH:    ssh -p 2222 root@decentralizationmaxi.io
#
# Note: SSH port 2222 is handled by the VM hosting platform (port forwarding).
# The NixOS SSH daemon listens on default port 22 internally.
{ inputs, ... }: {
  flake.nixosConfigurations.production = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    specialArgs = { inherit inputs; self = inputs.self; };
    modules = [
      ./hardware-configuration.nix
      inputs.determinate.nixosModules.default
      ({ config, pkgs, lib, self, ... }:
        let
          snapshotDir = "/var/lib/gerolamino/snapshot";

          # Mithril verification keys from flake-pinned source
          mithrilSrc = inputs.mithril;
          genesisVkey = builtins.readFile
            "${mithrilSrc}/mithril-infra/configuration/release-preprod/genesis.vkey";
          ancillaryVkey = builtins.readFile
            "${mithrilSrc}/mithril-infra/configuration/release-preprod/ancillary.vkey";
          aggregatorEndpoint =
            "https://aggregator.release-preprod.api.mithril.network/aggregator";

          # Override mithril-client to skip tests (upstream tests fail in sandbox
          # due to missing CA certs for reqwest HTTP tests)
          mithril-client = inputs.mithril.packages.x86_64-linux.mithril-client-cli.overrideAttrs (old: {
            doCheck = false;
          });
        in
        {

          # --- Boot (systemd-boot on EFI) ---
          boot.loader.systemd-boot = {
            enable = true;
            editor = false;
            configurationLimit = 20;
          };
          boot.loader.efi.canTouchEfiVariables = true;

          # --- Networking ---
          networking = {
            hostName = "bootstrap";
            firewall = {
              enable = true;
              allowedTCPPorts = [ 22 3040 ];
            };
          };

          # --- Time & Locale ---
          time.timeZone = "UTC";
          i18n.defaultLocale = "en_US.UTF-8";

          # --- SSH (default port 22 — VM host maps 2222→22) ---
          services.openssh = {
            enable = true;
            settings = {
              PermitRootLogin = "prohibit-password";
              PasswordAuthentication = false;
              KbdInteractiveAuthentication = false;
              X11Forwarding = false;
              MaxAuthTries = 3;
            };
          };

          users.users.root.openssh.authorizedKeys.keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPgKXHWP3afDB8/kmT4EbLDHfePQCc4LdBTi1jg1RuO2 hariamoor@framework"
          ];

          # --- Fail2Ban ---
          services.fail2ban = {
            enable = true;
            maxretry = 3;
            bantime = "1h";
          };

          # --- Podman ---
          virtualisation.podman = {
            enable = true;
            autoPrune = {
              enable = true;
              dates = "weekly";
            };
          };

          # --- Bootstrap Server Container ---
          virtualisation.oci-containers = {
            backend = "podman";
            containers.bootstrap = {
              image = "ghcr.io/harmoniclabs/bootstrap:latest";
              # nix2container image loaded into podman via copyToPodman
              imageStream = self.packages.x86_64-linux.bootstrap-image.copyToPodman;
              ports = [ "0.0.0.0:3040:3040" ];
              volumes = [ "${snapshotDir}:/data:ro" ];
              environment = {
                PORT = "3040";
                SNAPSHOT_PATH = "/data";
                UPSTREAM_URL = "tcp://preprod-node.play.dev.cardano.org:3001";
              };
            };
          };

          # Don't start the bootstrap container until snapshot data exists.
          # The download-mithril-snapshot timer will trigger the download,
          # then the bootstrap container will start after the first download completes.
          systemd.services.podman-bootstrap = {
            after = [ "download-mithril-snapshot.service" ];
            unitConfig = {
              # Only start if snapshot has ledger data
              ConditionPathIsDirectory = "${snapshotDir}/ledger";
            };
          };

          # --- Mithril Snapshot Download ---
          # Pre-built mithril-client-cli is part of the NixOS closure (tests skipped).
          # This service downloads the latest preprod snapshot, converts to LMDB,
          # and restarts the bootstrap container.
          systemd.services.download-mithril-snapshot = {
            description = "Download latest Mithril preprod snapshot";
            after = [ "network-online.target" ];
            wants = [ "network-online.target" ];
            path = [ mithril-client pkgs.coreutils pkgs.jq pkgs.findutils ];
            environment = {
              AGGREGATOR_ENDPOINT = aggregatorEndpoint;
              GENESIS_VERIFICATION_KEY = genesisVkey;
              ANCILLARY_VERIFICATION_KEY = ancillaryVkey;
            };
            serviceConfig = {
              Type = "oneshot";
              TimeoutStartSec = "2h";
              ExecStart = pkgs.writeShellScript "download-snapshot" ''
                set -euo pipefail
                WORK="$(mktemp -d)"
                trap 'rm -rf "$WORK"' EXIT

                echo "==> Downloading latest Cardano DB snapshot..."
                mithril-client cardano-db download latest --download-dir "$WORK"

                SNAP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
                if [ -z "$SNAP_DIR" ]; then
                  echo "ERROR: No snapshot directory found" >&2
                  exit 1
                fi

                LEDGER_DIR="$(find "$SNAP_DIR/ledger" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
                if [ -d "$LEDGER_DIR" ]; then
                  echo "==> Converting snapshot to LMDB format..."
                  mithril-client tools utxo-hd snapshot-converter \
                    --input-dir "$LEDGER_DIR" \
                    --output-dir "$LEDGER_DIR"
                fi

                echo "==> Installing snapshot to ${snapshotDir}..."
                mkdir -p "${snapshotDir}"
                rm -rf "${snapshotDir}"/*
                cp -r "$SNAP_DIR"/* "${snapshotDir}/"

                echo "==> Done. Restarting bootstrap container..."
                systemctl restart podman-bootstrap.service || true
              '';
            };
          };

          # Run snapshot download daily at 04:00 UTC.
          # OnActiveSec=0 triggers immediately on first activation (fresh deploy).
          # Persistent=true catches up on missed daily runs (e.g., reboot).
          systemd.timers.download-mithril-snapshot = {
            description = "Daily Mithril snapshot download";
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnActiveSec = "0";
              OnCalendar = "*-*-* 04:00:00";
              Persistent = true;
              RandomizedDelaySec = "30min";
            };
          };

          # --- Swap (prevents OOM during Mithril snapshot download) ---
          swapDevices = [{
            device = "/var/lib/swapfile";
            size = 8192; # 8GB
          }];

          # --- Snapshot Data Directory ---
          systemd.tmpfiles.rules = [
            "d /var/lib/gerolamino 0755 root root -"
            "d ${snapshotDir} 0755 root root -"
          ];

          # Nix daemon, GC, experimental-features, and store optimization
          # are all managed by Determinate Nix (inputs.determinate.nixosModules.default).

          # --- System Packages ---
          environment.systemPackages = with pkgs; [ btop helix ];

          system.stateVersion = "26.05";
        })
    ];
  };

  # --- deploy-rs ---
  flake.deploy.nodes.production = {
    hostname = "decentralizationmaxi.io";
    sshOpts = [ "-p" "2222" ];
    fastConnection = false;
    autoRollback = true;
    magicRollback = true;

    profiles.system = {
      sshUser = "root";
      user = "root";
      path = inputs.deploy-rs.lib.x86_64-linux.activate.nixos
        inputs.self.nixosConfigurations.production;
    };
  };

  flake.checks = builtins.mapAttrs
    (_system: deployLib: deployLib.deployChecks inputs.self.deploy)
    inputs.deploy-rs.lib;
}
