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
      ({ config, pkgs, lib, self, ... }: {

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
            imageStream = self.packages.x86_64-linux.bootstrap-image;
            ports = [ "0.0.0.0:3040:3040" ];
            volumes = [ "/var/lib/gerolamino/snapshot:/data:ro" ];
            environment = {
              PORT = "3040";
              SNAPSHOT_PATH = "/data";
              UPSTREAM_URL = "tcp://preprod-node.play.dev.cardano.org:3001";
            };
          };
        };

        # --- Snapshot Data Directory ---
        systemd.tmpfiles.rules = [
          "d /var/lib/gerolamino 0755 root root -"
          "d /var/lib/gerolamino/snapshot 0755 root root -"
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
