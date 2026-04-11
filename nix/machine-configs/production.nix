# Production NixOS configuration for decentralizationmaxi.io
# Runs cardano-node (preprod, V2LSM) + Gerolamo bootstrap server.
#
# Two-phase deployment:
#   1. Initial install (no haskell.nix deps — fast):
#      nix run github:nix-community/nixos-anywhere -- --flake .#production-base root@178.156.252.81
#   2. Subsequent updates (with bootstrap server — builds on server using IOG cache):
#      nix run .#deploy
#
# SSH: ssh root@178.156.252.81
{ inputs, ... }:
let
  # Shared NixOS module for both base and full configurations.
  # enableBootstrap controls whether the Podman bootstrap container is included.
  # When false, the system closure avoids the haskell.nix build chain entirely.
  productionModule = { enableBootstrap }: { config, pkgs, lib, self, ... }:
    let
      # Pre-built cardano-node 10.7.0 binary from GitHub releases
      cardanoNodeBin = pkgs.stdenv.mkDerivation {
        pname = "cardano-node";
        version = "10.7.0";
        src = pkgs.fetchurl {
          url = "https://github.com/IntersectMBO/cardano-node/releases/download/10.7.0/cardano-node-10.7.0-linux-amd64.tar.gz";
          hash = "sha256-v+ufCzSeh9c4dDqKr076Q0++Fv7U1e2HYTNsWL90s1k=";
        };
        sourceRoot = ".";
        nativeBuildInputs = [ pkgs.autoPatchelfHook ];
        buildInputs = [ pkgs.gmp pkgs.zlib pkgs.ncurses pkgs.libsodium pkgs.openssl ];
        installPhase = ''
          mkdir -p $out/bin
          install -m 755 bin/cardano-node $out/bin/
        '';
      };

      # Preprod topology (P2P format)
      topologyFile = pkgs.writeText "preprod-topology.json" (builtins.toJSON {
        bootstrapPeers = [
          { address = "preprod-node.play.dev.cardano.org"; port = 3001; }
        ];
        localRoots = [ ];
        publicRoots = [{
          accessPoints = [
            { address = "preprod-node.play.dev.cardano.org"; port = 3001; }
          ];
          advertise = false;
          valency = 1;
        }];
        useLedgerAfterSlot = -1;
      });
    in
    lib.mkMerge [
      # =====================================================================
      # Base system — always included (no haskell.nix deps)
      # =====================================================================
      {
        # --- Hardware (QEMU/KVM guest, AMD EPYC) ---
        boot.initrd.availableKernelModules = [ "uhci_hcd" "ehci_pci" "ahci" "virtio_pci" "virtio_scsi" "sd_mod" "sr_mod" ];
        boot.kernelModules = [ "kvm-amd" ];
        nixpkgs.hostPlatform = "x86_64-linux";

        # --- Boot (systemd-boot on EFI) ---
        boot.loader.systemd-boot = {
          enable = true;
          editor = false;
          configurationLimit = 20;
        };
        boot.loader.efi.canTouchEfiVariables = true;

        # --- ZFS ---
        networking.hostId = "a1b2c3d4";
        boot.supportedFilesystems = [ "zfs" ];

        # --- Networking ---
        networking = {
          hostName = "bootstrap";
          firewall = {
            enable = true;
            allowedTCPPorts = [ 22 3001 3040 ];
          };
        };

        # --- Time & Locale ---
        time.timeZone = "UTC";
        i18n.defaultLocale = "en_US.UTF-8";

        # --- SSH (port 22 direct) ---
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

        # --- Cardano Node (preprod, V2LSM) ---
        systemd.services.cardano-node = {
          description = "Cardano Node (preprod, V2LSM)";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          path = [ cardanoNodeBin ];
          script = ''
            CONFIG_DIR=/data/cardano-node/config
            MITHRIL_CONFIG=${inputs.mithril}/mithril-infra/assets/docker/cardano/config/10.6/preprod/cardano-node
            mkdir -p "$CONFIG_DIR"

            # Copy genesis files (referenced by relative path in config.json)
            cp "$MITHRIL_CONFIG/byron-genesis.json" "$CONFIG_DIR/"
            cp "$MITHRIL_CONFIG/shelley-genesis.json" "$CONFIG_DIR/"
            cp "$MITHRIL_CONFIG/alonzo-genesis.json" "$CONFIG_DIR/"
            cp "$MITHRIL_CONFIG/conway-genesis.json" "$CONFIG_DIR/"

            # GenesisMode gets stuck in PreSyncing on preprod (needs big ledger
            # peers it can't discover without being synced). Use PraosMode.
            ${pkgs.jq}/bin/jq '. + {"LedgerDB": {"Backend": "V2LSM"}, "ConsensusMode": "PraosMode"}' \
              "$MITHRIL_CONFIG/config.json" \
              > "$CONFIG_DIR/config.json"

            exec cardano-node run \
              --topology ${topologyFile} \
              --database-path /data/cardano-node/db \
              --socket-path /data/cardano-node/node.socket \
              --host-addr 0.0.0.0 \
              --port 3001 \
              --config "$CONFIG_DIR/config.json" \
              +RTS -N2 -I0 -A16m -RTS
          '';
          serviceConfig = {
            Restart = "on-failure";
            RestartSec = 30;
            LimitNOFILE = 65536;
          };
        };

        # --- Data Directory ---
        systemd.tmpfiles.rules = [
          "d /data 0755 root root -"
          "d /data/cardano-node 0755 root root -"
        ];

        # --- Nix Settings (IOG binary cache for haskell.nix builds) ---
        nix.settings = {
          substituters = [
            "https://cache.nixos.org"
            "https://cache.iog.io"
          ];
          trusted-public-keys = [
            "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
            "hydra.iohk.io:f/Ea+s+dFdN+3Y/G+FDgSq+a5NEWhJGzdjvKNGv0/EQ="
          ];
          max-jobs = 2;
          cores = 0;
          # Relaxed sandbox allows __noChroot derivations (needed for bun2nix#77
          # workaround — bun install needs network for .npm manifest cache).
          sandbox = "relaxed";
        };

        # --- System Packages ---
        environment.systemPackages = with pkgs; [ btop helix ];

        system.stateVersion = "26.05";
      }

      # =====================================================================
      # Bootstrap server — only when enableBootstrap = true
      # Triggers haskell.nix build chain (lsm-bridge → GHC 9.12.3).
      # Use IOG binary cache on the server for fast remote builds.
      # =====================================================================
      (lib.mkIf enableBootstrap {
        # --- Podman ---
        virtualisation.podman = {
          enable = true;
          autoPrune = {
            enable = true;
            dates = "weekly";
          };
        };

        # --- Bootstrap Server Container ---
        # nix2container's copyToPodman uses skopeo (not Docker archive stream),
        # so we manage the container via systemd directly instead of oci-containers.
        systemd.services."podman-bootstrap" =
          let
            copyToPodman = self.packages.${pkgs.system}.bootstrap-image.copyToPodman;
            bootstrapApp = self.packages.${pkgs.system}.bootstrap-app;
          in
          {
            description = "Bootstrap server (Podman)";
            wantedBy = [ "multi-user.target" ];
            after = [ "cardano-node.service" "podman.socket" ];
            requires = [ "cardano-node.service" ];
            unitConfig.ConditionPathIsDirectory = "/data/cardano-node/db/lsm";

            serviceConfig = {
              Type = "simple";
              TimeoutStartSec = "5min";
              TimeoutStopSec = "30s";
              Restart = "on-failure";
              RestartSec = 60;
              # Keep retrying — node may need hours to sync from genesis
              StartLimitBurst = 0;
              ExecStartPre = [
                "-${pkgs.podman}/bin/podman rm -f bootstrap"
                "${copyToPodman}/bin/copy-to-podman"
              ];
              ExecStart = lib.concatStringsSep " " [
                "${pkgs.podman}/bin/podman run --rm --name bootstrap"
                "-p 0.0.0.0:3040:3040"
                "-v /data/cardano-node/db:/node-db:ro"
                "-e PORT=3040"
                "-e NODE_DB_PATH=/node-db"
                "-e NETWORK=preprod"
                "-e UPSTREAM_URL=tcp://127.0.0.1:3001"
                "ghcr.io/harmoniclabs/bootstrap:latest"
                "${bootstrapApp}/bin/bootstrap --db-path /node-db --network preprod"
              ];
              ExecStop = "${pkgs.podman}/bin/podman stop -t 10 bootstrap";
            };
          };
      })
    ];

  mkSystem = args: inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    specialArgs = { inherit inputs; self = inputs.self; };
    modules = [
      inputs.disko.nixosModules.disko
      ./disko-production.nix
      # Determinate Nix module omitted — wasmtime build requires >15GB RAM,
      # OOMs on the 16GB VPS. Standard Nix daemon is sufficient.
      (productionModule args)
    ];
  };
in
{
  # Full config — includes bootstrap server (triggers haskell.nix).
  # Used by deploy-rs with remoteBuild = true.
  flake.nixosConfigurations.production = mkSystem { enableBootstrap = true; };

  # Base config — no bootstrap server, no haskell.nix deps.
  # Used for fast initial install via nixos-anywhere.
  flake.nixosConfigurations.production-base = mkSystem { enableBootstrap = false; };

  # --- deploy-rs ---
  flake.deploy.nodes.production = {
    hostname = "178.156.252.81";
    fastConnection = true;
    autoRollback = true;
    magicRollback = true;
    # 5 min timeout for activation (prevents indefinite hang)
    confirmTimeout = 300;

    profiles.system = {
      sshUser = "root";
      user = "root";
      # Build on the server — avoids copying huge haskell.nix closure over SSH.
      # Server uses IOG binary cache for GHC/lsm-tree deps.
      remoteBuild = true;
      path = inputs.deploy-rs.lib.x86_64-linux.activate.nixos
        inputs.self.nixosConfigurations.production;
    };
  };

  flake.checks = builtins.mapAttrs
    (_system: deployLib: deployLib.deployChecks inputs.self.deploy)
    inputs.deploy-rs.lib;
}
