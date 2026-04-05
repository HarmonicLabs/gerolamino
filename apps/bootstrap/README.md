# Bootstrap Server

Streams a Mithril Cardano snapshot to in-browser nodes via WebSocket, then proxies Ouroboros miniprotocol traffic to an upstream Cardano node.

## Why Nix?

The bootstrap server uses LMDB to read the Cardano ledger state from the Mithril snapshot. LMDB is accessed via Bun's FFI (`bun:ffi`), which requires the native `liblmdb.so` shared library at runtime. Nix provides this library reproducibly and pins its exact version, eliminating "works on my machine" issues across development, CI, and production.

## Running locally (with Nix devshell)

```bash
# Enter the devshell (provides lmdb, bun, etc.)
nix develop

# Set the LMDB library path and start the server
LIBLMDB_PATH="$(nix eval --raw nixpkgs#lmdb.outPath)/lib/liblmdb.so" \
  bun run apps/bootstrap/src/cli.ts serve --snapshot-path ./apps/bootstrap/db
```

## Building the container image

The bootstrap server is packaged as an OCI container image using `pkgs.dockerTools.streamLayeredImage`. The image includes Bun, `liblmdb.so`, and all workspace dependencies pre-installed.

```bash
# Build the image (outputs a stream script, not a tarball)
nix build .#bootstrap-image

# Load into Podman
./result | podman load

# Run with the Mithril snapshot mounted as a volume
podman run --rm -p 3040:3040 \
  -v /path/to/mithril/snapshot:/data:ro \
  -e UPSTREAM_URL=tcp://preprod-node.play.dev.cardano.org:3001 \
  ghcr.io/harmoniclabs/bootstrap:latest
```

The Mithril snapshot (~16 GB) is NOT baked into the image. Mount it at `/data`.

## Downloading the Mithril snapshot

```bash
# Download the latest preprod snapshot and convert to LMDB format
nix run .#download-snapshot -- /var/lib/gerolamino/snapshot
```

This uses the `mithril-client` CLI with the correct aggregator endpoint, genesis verification key, and ancillary verification key (all pinned via the Mithril flake input). It also runs `mithril-client tools utxo-hd snapshot-converter` to produce the LMDB format.

## Building just the app (without container)

```bash
nix build .#bootstrap-app
./result/bin/bootstrap --snapshot-path /path/to/snapshot
```

## API

| Endpoint     | Method | Description                                           |
| ------------ | ------ | ----------------------------------------------------- |
| `/info`      | GET    | Snapshot metadata (protocol magic, slot, chunk count) |
| `/bootstrap` | GET    | WebSocket upgrade; streams TLV-framed snapshot data   |

### WebSocket protocol

Binary TLV frames: `[tag: u8][length: u32 BE][payload: u8[length]]`

Stream order: Init -> LedgerState -> LedgerMeta -> LmdbEntries... -> Blocks... -> Complete

## Environment variables

| Variable        | Default                                        | Description                                               |
| --------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `LIBLMDB_PATH`  | (required)                                     | Path to `liblmdb.so`. Set automatically in the Nix build. |
| `PORT`          | `3040`                                         | HTTP/WebSocket listen port                                |
| `SNAPSHOT_PATH` | `db`                                           | Path to the Mithril snapshot directory                    |
| `UPSTREAM_URL`  | `tcp://preprod-node.play.dev.cardano.org:3001` | Upstream Cardano node for miniprotocol proxying           |
