# Relay proxy (`87.99.129.190`)

Minimal NixOS host for chrome-ext genesis sync: **websockify** on `0.0.0.0:3040`
→ `preprod-node.world.dev.cardano.org:3001`. No local `cardano-node`.

Config: `nix/machine-configs/{relay-proxy,disko-relay-proxy}.nix`.

## First install (nixos-anywhere)

**Warning:** disko repartitions and wipes `sda` (~40 GiB). The 250 GiB Hetzner
volume `sdb` is untouched. Layout is **BIOS + GRUB** (1 MiB EF02 + ext4 `/`).
Hetzner CPX has no EFI variables (`efibootmgr` fails); systemd-boot cannot
boot on this instance class.

**Build on the local machine**, not `--build-on remote`: the kexec installer’s
Nix daemon does not trust `cache.iog.io`, so remote builds fail with
`lacks a signature by a trusted key`.

### From Hetzner rescue (recommended when the disk install is broken)

```sh
# Boot into rescue, then reset
nix run nixpkgs#hcloud -- server enable-rescue cardano-ws-proxy --type linux64 \
  --ssh-key hariamoor@framework
nix run nixpkgs#hcloud -- server reset cardano-ws-proxy
# wait for SSH (hostname `rescue`)

nix build .#nixosConfigurations.relay-proxy.config.system.build.diskoScript \
          .#nixosConfigurations.relay-proxy.config.system.build.toplevel

# Full pipeline: kexec → disko → install → reboot
nix run github:nix-community/nixos-anywhere -- \
  --flake .#relay-proxy \
  --target-host root@87.99.129.190 \
  --phases kexec,disko,install,reboot \
  --kexec-extra-flags "--kexec-syscall" \
  --copy-host-keys \
  --build-on local
```

If kexec already ran but install failed (still on `nixos-installer`), resume
without rebuilding on the target:

```sh
nix run github:nix-community/nixos-anywhere -- \
  --target-host root@87.99.129.190 \
  --phases disko,install,reboot \
  --store-paths "$(nix build -L .#nixosConfigurations.relay-proxy.config.system.build.diskoScript --print-out-paths)" \
              "$(nix build -L .#nixosConfigurations.relay-proxy.config.system.build.toplevel --print-out-paths)" \
  --copy-host-keys \
  --no-disko-deps \
  --build-on local
```

Confirm rescue is **disabled** before expecting a normal boot (`rescue_enabled:
false` in `hcloud server describe`). After reboot:

```sh
ssh root@87.99.129.190 'hostname; systemctl status websockify-relay'
```

### Optional pass 1 — facter report only (from Ubuntu)

```sh
nix run github:nix-community/nixos-anywhere -- \
  --flake .#relay-proxy \
  --target-host root@87.99.129.190 \
  --phases kexec \
  --kexec-extra-flags "--kexec-syscall" \
  --generate-hardware-config nixos-facter ./nix/machine-configs/facter-relay-proxy.json
```

On **2 GiB** Hetzner VMs, add swap before kexec (`fallocate -l 2G /swapfile &&
mkswap && swapon`) and use `--kexec-syscall` — kernel 7.0 returns
`Address not available` with the default `kexec_file_load`.

## Ongoing deploy (deploy-rs)

```sh
nix run github:serokell/deploy-rs -- .#relay-proxy
# or
nix run .#deploy-relay-proxy
```

`magicRollback` + 300s `confirmTimeout` match production.

## Client URL

Chrome extension offscreen sync:

```text
ws://87.99.129.190:3040/relay
```

(`websockify` ignores the path; `/relay` matches the miniprotocol route name.)

## Health

```sh
ssh root@87.99.129.190 'systemctl status websockify-relay; journalctl -u websockify-relay -n 20'
# optional: curl -I http://127.0.0.1:3040/  (websockify HTTP probe)
```
