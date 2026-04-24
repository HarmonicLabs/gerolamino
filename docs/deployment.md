# Deployment

Operational runbook for the production NixOS machine. The machine runs
three systemd services: `cardano-node` (preprod, V2LSM), plus
`mithril-aggregator` + `mithril-signer` (self-hosted single-signer test
cluster). Scope is deliberately narrow — our Mithril cluster exists to
produce snapshots whose metadata matches what our 10.7.x cardano-node
writes, not to serve external clients at scale.

See `nix/machine-configs/{production,mithril-services}.nix` for the
declarative configuration.

## Deploy

```sh
nix run .#deploy
```

Uses deploy-rs with `magicRollback` (auto-revert on 5 min of failed
activation). Builds remotely on the target host — cardano-node +
Mithril binaries come from caches (`cache.nixos.org` + `cache.iog.io`),
so the server does not compile haskell.nix closures locally.

## First-boot provisioning

Three manual steps are required on the first deploy. Omit them on
subsequent deploys — systemd's ExecStartPre is idempotent and skips
already-provisioned state.

### 1. Aggregator genesis key handoff

The aggregator auto-generates its genesis keypair on first
`ExecStartPre`:

```
/data/mithril/aggregator/genesis.vkey  (public)
/data/mithril/aggregator/genesis.skey  (private — stays on host)
```

Copy the public half back to the repo so CI + local fixture downloads
can verify against our own root of trust:

```sh
scp -P 2222 root@decentralizationmaxi.io:/data/mithril/aggregator/genesis.vkey \
    nix/mithril-genesis/self-hosted.vkey
git add nix/mithril-genesis/self-hosted.vkey
git commit -m "mithril: commit self-hosted aggregator genesis vkey"
```

The committed placeholder in that path refuses all
`nix run .#download-mithril-lsm-snapshot` invocations until replaced —
this is intentional. Signatures verified against a placeholder would
be meaningless.

### 2. KES secret key + operational certificate

The signer needs a KES keypair + op cert tying it to a cardano-node
stake pool identity. For the single-signer test cluster we generate
these once and reuse them for the KES period (≈90 days on preprod).

On the production host:

```sh
# Generate cold keys (kept off-box in real deployments; for the test
# cluster we keep them on disk since there's no slashing risk).
cardano-cli conway node key-gen \
    --cold-verification-key-file /data/mithril/signer/cold.vkey \
    --cold-signing-key-file     /data/mithril/signer/cold.skey \
    --operational-certificate-issue-counter-file /data/mithril/signer/cold.counter

# KES keypair for the current KES period.
cardano-cli conway node key-gen-KES \
    --verification-key-file /data/mithril/signer/kes.vkey \
    --signing-key-file      /data/mithril/signer/kes.skey

# Query the current KES period from the node.
kes_period=$(cardano-cli conway query kes-period-info \
    --op-cert-file /dev/null --socket-path /data/cardano-node/node.socket \
    --testnet-magic 1 2>/dev/null \
    | grep -oP 'Current KES period.*\K\d+' || echo 0)

# Issue the operational certificate.
cardano-cli conway node issue-op-cert \
    --kes-verification-key-file /data/mithril/signer/kes.vkey \
    --cold-signing-key-file     /data/mithril/signer/cold.skey \
    --operational-certificate-issue-counter-file /data/mithril/signer/cold.counter \
    --kes-period "$kes_period" \
    --out-file /data/mithril/signer/op.cert

chmod 600 /data/mithril/signer/{cold,kes}.skey
chmod 644 /data/mithril/signer/op.cert

systemctl restart mithril-signer
```

### 3. KES rotation (every ~90 days on preprod)

```sh
# Generate new KES key + issue op cert with incremented counter.
cardano-cli conway node key-gen-KES \
    --verification-key-file /data/mithril/signer/kes.vkey \
    --signing-key-file      /data/mithril/signer/kes.skey

kes_period=$(cardano-cli conway query kes-period-info \
    --op-cert-file /data/mithril/signer/op.cert \
    --socket-path /data/cardano-node/node.socket \
    --testnet-magic 1 \
    | grep -oP 'Current KES period.*\K\d+')

cardano-cli conway node issue-op-cert \
    --kes-verification-key-file /data/mithril/signer/kes.vkey \
    --cold-signing-key-file     /data/mithril/signer/cold.skey \
    --operational-certificate-issue-counter-file /data/mithril/signer/cold.counter \
    --kes-period "$kes_period" \
    --out-file /data/mithril/signer/op.cert

systemctl restart mithril-signer
```

The counter file auto-increments; do not edit it by hand.

## Health checks

```sh
# cardano-node syncing
journalctl -u cardano-node -n 50 | grep -E "tip slot|Chain extended"

# Mithril aggregator serving
curl -s http://localhost:8080/aggregator/epoch-settings | jq .

# Mithril signer registered + signing
journalctl -u mithril-signer -n 50 | grep -E "SIGNATURE|REGISTER"

# Snapshot production
curl -s http://localhost:8080/aggregator/artifact/snapshots | jq '.[0]'
```

First snapshot appears ≈1 epoch (5 hours on preprod) after `cardano-node`
reaches tip + `mithril-signer` registers.

## Fixture download workflow

Once the genesis vkey is committed:

```sh
nix run .#download-mithril-lsm-snapshot -- preprod /tmp/fixture
```

Downloads the latest signed snapshot from our aggregator, verifies the
Mithril signature against the committed genesis key, and applies the
single-step V2LSM conversion. Output under `/tmp/fixture/lsm/` is
consumable by `apps/bootstrap` and the consensus test harness.

Override the aggregator endpoint via `MITHRIL_AGGREGATOR_ENDPOINT` for
CI or alternate deployments.

---

## Hardware migration (Phase 0g): `178.156.252.81` → `decentralizationmaxi.io`

One-time sequence for moving the production identity from the old Hetzner
VPS (port 22, Arch Linux) to the physical host at `decentralizationmaxi.io`
(port 2222). Executed from a laptop with SSH keys for both hosts; neither
host requires hands at the keyboard, but keep an IPMI/console URL handy
for the new host in case of kexec panic (rare on x86_64).

Pre-flight (on laptop):

```sh
# 1. Stop the old VPS's cardano-node to freeze the on-disk DB
ssh root@178.156.252.81 systemctl stop cardano-node

# 2. Hardware probe the new host — commit output to docs/hardware-probe-decentralizationmaxi.txt
ssh -p 2222 root@decentralizationmaxi.io \
    'lsblk -o NAME,SIZE,MODEL,SERIAL,TYPE,MOUNTPOINT;
     ls -la /dev/disk/by-id/;
     [ -d /sys/firmware/efi ] && echo UEFI || echo BIOS;
     lscpu | head -5; free -m' \
  > docs/hardware-probe-decentralizationmaxi.txt
git add docs/hardware-probe-decentralizationmaxi.txt

# 3. Update nix/machine-configs/disko-production.nix with the probed
#    /dev/disk/by-id/nvme-* path + kernel modules for the new CPU vendor.
#    Already updated in repo for standard single-NVMe x86_64 physical hosts;
#    verify against the probe before continuing.
```

Two-pass `nixos-anywhere` install — pass 1 kexecs and generates a facter
report, pass 2 partitions + installs:

```sh
# Pass 1: kexec only + generate facter report (Arch still intact on disk)
nix run github:nix-community/nixos-anywhere -- \
    --flake .#production \
    --target-host root@decentralizationmaxi.io \
    -p 2222 \
    --phases kexec \
    --generate-hardware-config nixos-facter ./nix/machine-configs/facter.json
git add nix/machine-configs/facter.json
git commit -m "nix/machine-configs: facter report from first kexec of new prod host"

# Eval the closure locally to catch hardware-specific config breakage
# before we let disko wipe the disks.
nix build .#nixosConfigurations.production.config.system.build.toplevel

# Pass 2: disko + install, no reboot (port 22 now — post-kexec SSH default)
nix run github:nix-community/nixos-anywhere -- \
    --flake .#production \
    --target-host root@decentralizationmaxi.io \
    -p 22 \
    --phases disko,install \
    --copy-host-keys
```

Migrate the `cardano-node` V2LSM database from the old VPS directly into
the new host's ZFS pool before the first cardano-node boot — preserves
chain tip so the new host doesn't re-sync from genesis (~24h on preprod):

```sh
# ZFS send/recv (preferred — atomic + recordsize-preserving)
ssh root@178.156.252.81 \
    "zfs snapshot zroot/data@migration && zfs send -v zroot/data@migration" \
  | ssh -p 22 root@decentralizationmaxi.io "zfs recv -F zroot/data"
```

If ZFS send fails or the new host's pool layout doesn't match, fall back
to `rsync` (requires SSH agent-forward from laptop):

```sh
ssh -A root@178.156.252.81 \
    "rsync -avP -e 'ssh -p 22' /data/cardano-node/db/ \
     root@decentralizationmaxi.io:/data/cardano-node/db/"
```

Integrity-check before starting cardano-node on the new host (catches
silent corruption in the transfer):

```sh
ssh -p 22 root@decentralizationmaxi.io \
    "db-analyser --db-path /data/cardano-node/db --lsm \
                 --config /data/cardano-node/config/config.json"
```

Reboot into NixOS; port moves from 22 → 2222 at this step:

```sh
ssh -p 22 root@decentralizationmaxi.io reboot
# Wait ~60s
ssh -p 2222 root@decentralizationmaxi.io systemctl status cardano-node
```

First `deploy-rs` activation (deploy-schema check is green on the repo;
`nix run .#deploy` targets the new hostname + port 2222 per `flake.nix`):

```sh
nix run .#deploy
```

Provision Mithril keys per the three first-boot steps above. Wait for
the aggregator to produce one signed snapshot (~5 hours on preprod).

Soak for 24h with the old VPS stopped but NOT yet terminated — if
anything surfaces, `ssh root@178.156.252.81 systemctl start cardano-node`
restores the pre-migration identity. After the soak:

```sh
# Record last-state from the old host, then decommission via Hetzner Robot
ssh root@178.156.252.81 'journalctl -b -0 --no-pager' > docs/final-178-journal.txt
git add docs/final-178-journal.txt
git commit -m "docs: final journal from 178.156.252.81 pre-decommission"
# Hetzner Robot → terminate the VPS. Irreversible.
```

Residual risks to watch (see `~/code/reference/nixos-anywhere/` for
mechanism details):

- **kexec kernel panic on new host**: rare on physical x86_64, but needs
  IPMI/console access to recover. Only relevant if the pre-kexec Arch is
  already gone — confirm kexec boots successfully before running pass 2.
- **Re-running `--phases disko,install` accidentally**: disko always
  wipes. Use `--phases install` alone if disko already succeeded.
- **`magicRollback` doesn't save a kernel panic during activation**:
  software-only rollback can't recover from a hard crash. If the new
  host hangs on first boot post-activation, IPMI cycle + re-run deploy.
