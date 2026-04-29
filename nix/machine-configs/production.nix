# Production NixOS configuration for decentralizationmaxi.io.
#
# Services: cardano-node (preprod, V2LSM, 10.7.1) + self-hosted Mithril
# aggregator + signer (see ./mithril-services.nix — a single-signer test
# cluster that produces snapshots whose metadata matches what our
# 10.7.x cardano-node writes, since upstream aggregators run 10.5.1).
#
# The Podman bootstrap server previously managed from this config has
# been removed — the bootstrap server now runs locally against a
# fetched Mithril fixture during dev iteration (see apps/bootstrap,
# and `nix run .#download-mithril-lsm-snapshot` for the fixture-producer
# flake app). Re-introducing a production deployment is a follow-up
# once the TypeScript code stabilizes.
#
# Deploy: `nix run github:serokell/deploy-rs -- .#production` (builds
# remotely on the host — the flake does not export an `apps.deploy`
# wrapper, so invoke the upstream runner directly).
{ inputs, ... }:
let
  productionModule = { config, pkgs, lib, ... }:
    let
      # Pre-built cardano-node 10.7.1 binary — see cardano-node-bin.nix
      # for the full story on why this is fetchurl rather than
      # `inputs.cardano-node.packages.*`.
      cardanoNodeBin = pkgs.callPackage ./cardano-node-bin.nix { };

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
    {
      # --- Hardware (QEMU/KVM guest, Intel Xeon Skylake-SP) ---
      # Virtio SCSI + Virtio net (Red Hat paravirt devices); no USB/SATA
      # hot-plug paths needed on a headless server. `common-cpu-intel-cpu-only`
      # (imported below at the nixosSystem level) handles microcode.
      boot.initrd.availableKernelModules = [
        "virtio_pci"
        "virtio_scsi"
        "virtio_blk"
        "virtio_net"
        "ahci"
        "sd_mod"
      ];
      boot.kernelModules = [ "kvm-intel" ];
      hardware.enableRedistributableFirmware = true;
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
          # Both SSH ports open — each host's external firewall picks
          # which one is reachable. Hetzner VPS (178.156.252.81) allows
          # :22; decentralizationmaxi.io VPS allows :2222. Keeping both
          # in the NixOS firewall + sshd config means the same system
          # image works on either host.
          # 3001 = cardano-node N2N; 3040 = websockify relay
          # (WS↔TCP proxy → cardano-node:3001 for the chrome-ext SW
          # whose default `BOOTSTRAP_URL` is `ws://178.156.252.81:3040`);
          # 8080 = Mithril aggregator REST.
          allowedTCPPorts = [ 22 2222 3001 3040 8080 ];
        };
      };

      # --- Time & Locale ---
      time.timeZone = "UTC";
      i18n.defaultLocale = "en_US.UTF-8";

      # --- SSH — listen on both :22 and :2222 so the image is portable
      # across hosts with differing provider firewalls. ---
      services.openssh = {
        enable = true;
        ports = [ 22 2222 ];
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
          MITHRIL_CONFIG=${inputs.mithril}/mithril-infra/assets/docker/cardano/config/10.7/preprod/cardano-node
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

      # --- Websockify relay (chrome-ext sync entry point) ---
      #
      # Bridges WebSocket on 0.0.0.0:3040 → TCP on 127.0.0.1:3001 (the
      # cardano-node N2N port). The chrome-ext SW connects to
      # `ws://178.156.252.81:3040/relay` by default (see
      # `packages/chrome-ext/entrypoints/background/bootstrap-sync.ts`);
      # websockify ignores the path, performs the WS upgrade, and proxies
      # raw bytes to cardano-node — exactly what the relay-only path of
      # `apps/bootstrap` was already doing. This restores chrome-ext sync
      # without re-introducing the full Effect-based bootstrap server.
      systemd.services.websockify-relay = {
        description = "websockify WS↔TCP proxy for chrome-ext relay sync";
        wantedBy = [ "multi-user.target" ];
        after = [ "cardano-node.service" "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          ExecStart = "${pkgs.python3Packages.websockify}/bin/websockify --heartbeat=30 0.0.0.0:3040 127.0.0.1:3001";
          Restart = "on-failure";
          RestartSec = 5;
          DynamicUser = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          NoNewPrivileges = true;
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
    };
in
{
  flake.nixosConfigurations.production = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    specialArgs = { inherit inputs; self = inputs.self; };
    modules = [
      inputs.disko.nixosModules.disko
      inputs.nixos-hardware.nixosModules.common-cpu-intel-cpu-only
      inputs.nixos-hardware.nixosModules.common-pc-ssd
      ./disko-production.nix
      ./mithril-services.nix
      productionModule
    ];
  };

  # --- deploy-rs ---
  #
  # Target: Hetzner VPS at `178.156.252.81`, SSH on port 22. The
  # physical-host migration (`decentralizationmaxi.io:2222`) is
  # Phase-0g-pending — its first nixos-anywhere attempt wedged because
  # the provider firewall blocks :22 externally and the post-kexec
  # installer came up on the default :22; retry needs
  # `--post-kexec-ssh-port 2222` plus a hypervisor-console reboot of
  # the wedged box. Until then deploys target the existing NixOS
  # instance at 178.156.252.81 — hostId `a1b2c3d4` already matches, so
  # the ZFS pool imports cleanly across generations.
  #
  # `remoteBuild = true` builds the new generation on the target so we
  # don't copy the cardano-node closure over the WAN link (the server
  # has IOG binary-cache access). `magicRollback` + 5-min
  # `confirmTimeout` reverts on any post-activation network failure.
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
      # Build on the server — avoids copying the cardano-node closure over SSH.
      # Server uses IOG binary cache.
      remoteBuild = true;
      path = inputs.deploy-rs.lib.x86_64-linux.activate.nixos
        inputs.self.nixosConfigurations.production;
    };
  };

  flake.checks = builtins.mapAttrs
    (_system: deployLib: deployLib.deployChecks inputs.self.deploy)
    inputs.deploy-rs.lib;
}
