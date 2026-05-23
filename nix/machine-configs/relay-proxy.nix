# Relay-only NixOS host — websockify WS↔TCP proxy for chrome-ext genesis sync.
#
# Proxies `0.0.0.0:3040` → `preprod-node.world.dev.cardano.org:3001` (IOG
# preprod N2N). No local cardano-node; the chrome-ext offscreen connects to
# `ws://<this-host>:3040/relay`.
#
# Provision: nixos-anywhere (kexec + disko + install) then deploy-rs.
# Deploy: `nix run github:serokell/deploy-rs -- .#relay-proxy`
{ inputs, ... }:
let
  relayProxyModule = { config, pkgs, lib, ... }: {
    # Hetzner CPX is BIOS-only — systemd-boot cannot set a boot entry here.
    boot.loader.grub = {
      enable = true;
      efiSupport = false;
      devices = [ ];
      mirroredBoots = lib.mkOverride 0 [
        {
          # BIOS + single ext4 root — no separate /boot partition.
          path = "/";
          devices = [
            "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_118886326"
          ];
        }
      ];
    };

    boot.initrd.availableKernelModules = [
      "virtio_pci"
      "virtio_blk"
      "virtio_scsi"
      "virtio_net"
      "sd_mod"
    ];
    boot.kernelParams = [
      "rootdelay=15"
    ];
    boot.kernelModules = [ "kvm-intel" ];

    hardware.enableRedistributableFirmware = lib.mkDefault true;

    # 2–4 GiB Hetzner CPX: avoid early-boot OOM during NixOS activation.
    zramSwap.enable = true;

    networking = {
      hostName = "relay-proxy";
      useDHCP = lib.mkDefault true;
      firewall = {
        enable = true;
        allowedTCPPorts = [ 22 3040 ];
      };
    };

    time.timeZone = "UTC";
    i18n.defaultLocale = "en_US.UTF-8";

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

    services.fail2ban = {
      enable = true;
      maxretry = 3;
      bantime = "1h";
    };

    # chrome-ext offscreen: `${serverUrl}/relay` → websockify ignores path.
    systemd.services.websockify-relay = {
      description = "websockify WS↔TCP proxy (chrome-ext → IOG preprod relay)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart =
          "${pkgs.python3Packages.websockify}/bin/websockify --heartbeat=30 0.0.0.0:3040 preprod-node.world.dev.cardano.org:3001";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    nix.settings = {
      substituters = [ "https://cache.nixos.org" ];
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      ];
      max-jobs = 2;
      cores = 0;
    };

    environment.systemPackages = with pkgs; [ btop helix ];

    system.stateVersion = "26.05";
  };
in
{
  flake.nixosConfigurations.relay-proxy = inputs.nixpkgs.lib.nixosSystem {
    specialArgs = { inherit inputs; self = inputs.self; };
    modules = [
      ({ ... }: { nixpkgs.hostPlatform = "x86_64-linux"; })
      inputs.disko.nixosModules.disko
      ./disko-relay-proxy.nix
      relayProxyModule
    ];
  };

  flake.deploy.nodes.relay-proxy = {
    hostname = "87.99.129.190";
    fastConnection = true;
    autoRollback = true;
    magicRollback = true;
    confirmTimeout = 300;

    profiles.system = {
      sshUser = "root";
      user = "root";
      remoteBuild = true;
      path = inputs.deploy-rs.lib.x86_64-linux.activate.nixos
        inputs.self.nixosConfigurations.relay-proxy;
    };
  };

  flake.apps = {
    "deploy-relay-proxy" = {
      type = "app";
      description = "deploy-rs activate for relay-proxy (87.99.129.190)";
      program = toString (
        inputs.nixpkgs.legacyPackages.x86_64-linux.writeShellScript "deploy-relay-proxy" ''
          exec ${inputs.deploy-rs.packages.x86_64-linux.default}/bin/deploy .#relay-proxy "$@"
        ''
      );
    };
  };

  flake.checks = builtins.mapAttrs
    (_system: deployLib: deployLib.deployChecks inputs.self.deploy)
    inputs.deploy-rs.lib;
}
