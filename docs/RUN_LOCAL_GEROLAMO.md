# Run Gerolamo locally as Gerolamino's relay

Gerolamino's default relay is now `ws://127.0.0.1:3004/n2n`: Gerolamo on the same machine. For a remote
relay, replace host and port; use `wss://` when TLS is terminated in front of the WebSocket port.

Gerolamo reads no environment variables. Every setting is a CLI flag or a `config.json` key. A flag wins over
the network config; see Gerolamo's `docs/CONFIG.md` for the full list.

## Prerequisites

- Bun 1.1+, git, and a writable data directory.
- Preview is the current pilot network (magic 2). Preprod is magic 1. Mainnet is magic 764824073, but the
  Gerolamino extension currently offers preview and preprod only.
- Gerolamo needs disk and time for its first snapshot or genesis sync; the preview pilot is the tested path.

## Option A: Docker (recommended for a self-contained relay)

```bash
git clone https://github.com/HarmonicLabs/gerolamo.git
cd gerolamo
```

Gerolamo's bundled `docker-compose.yml` starts a preview relay from a Mithril snapshot. Gerolamo flags are
passed in the compose `command:` list, and node flags go after `--`. Add WebSocket to the existing command:

```yaml
    command:
      - --network
      - preview
      - --port
      - "3030"
      - --bootstrap
      - mithril
      - --role
      - relay
      - --max-rss-gb
      - "8"
      - --
      - --n2n-ws
      - --n2n-ws-port
      - "3004"
```

Expose the HTTP API and WebSocket port on the host:

```yaml
    ports:
      - "127.0.0.1:3030:3030"
      - "127.0.0.1:3004:3004"
```

For relay access from another machine, bind `0.0.0.0` and open the ports deliberately:

```yaml
      - "3004:3004"
```

Docker's first start downloads and verifies the Mithril snapshot; later starts resume from the mounted
`./data/preview` directory. Start and verify:

```bash
docker compose up -d --build
docker compose logs -f gerolamo       # first bootstrap takes a while; wait for /health
curl -s http://127.0.0.1:3030/health | jq .
curl -s http://127.0.0.1:3030/api/v0/ | jq '{version, endpoints}'
```

Gerolamino relay URL: `ws://127.0.0.1:3004/n2n`. Mini-Blockfrost fallback for Bun/backend code:
`http://127.0.0.1:3030/api/v0/*`.

## Option B: Bun directly (developer setup)

```bash
git clone https://github.com/HarmonicLabs/gerolamo.git
cd gerolamo
bun install
DATA="$PWD/data/preview"; mkdir -p "$DATA"
```

Bootstrap the ledger and block store once (Mithril snapshot; later starts resume):

```bash
bun src/index.ts mithril-bootstrap --network preview \
  --download-dir "$DATA/snapshots" \
  --block-store "$DATA/db" \
  --ledger-state --ledger "$DATA/ledger" \
  --db "$DATA/preview.db"
```

Create `"$DATA/local-config.json"` next to the data (absolute paths work best):

```json
{
    "role": "relay",
    "ledgerStore": "lmdb",
    "ledgerSqlWrites": false,
    "ledgerDir": "/absolute/path/to/data/preview/ledger",
    "blockStoreDir": "/absolute/path/to/data/preview/db",
    "relayStore": "chunks",
    "n2n": { "enabled": true, "host": "127.0.0.1", "port": 3001 }
}
```

Start the node with its HTTP port and WebSocket bearer:

```bash
bun src/index.ts start-gerolamo --network preview \
  --port 3037 \
  --db-path "$DATA/preview.db" \
  --config "$DATA/local-config.json" \
  --n2n-ws \
  --n2n-ws-port 3004 \
  --n2n-ws-host 127.0.0.1
```

Optional TCP node-to-node listens on `n2n.port` (3001 in the example) for ordinary Gerolamo peers; the
WebSocket listener is the one Gerolamino uses. For a LAN relay, set `--n2n-ws-host 0.0.0.0` and use the
machine's address in the extension. Keep one writer per database; choose a unique HTTP/WS port per instance.

Verify:

```bash
curl -s http://127.0.0.1:3037/health | jq .
curl -s http://127.0.0.1:3037/api/v0/ | jq '{version, endpoints}'
ss -ltnp | grep -E ':3037|:3004'
```

Gerolamino then uses:

```text
Relay URL: ws://127.0.0.1:3004/n2n
Mini-Blockfrost fallback: http://127.0.0.1:3037/api/v0/*   (Gerolamo HTTP, not the relay)
Network: preview
```

## Port map in the docs

| Purpose | Gerolamo setting | Example |
|---|---|---|
| HTTP API, dashboard, mini-Blockfrost | `--port` | `3037` |
| N2N-over-WebSocket | `--n2n-ws-port` | `3004` |
| Ordinary N2N TCP | `--n2n-port` | `3001` |
| N2C unix socket (optional) | `--n2c-socket` | `./node.socket` |

`--n2n-ws` must be enabled for Gerolamino. The WebSocket path is `/n2n`; Gerolamo also accepts `/relay` and `/`.
Only `ws://` or `wss://` URLs are valid in the extension.

## Remote access and TLS

For a relay elsewhere, use its DNS name or address, not a hard-coded address from an example:

```text
ws://<relay-host>:<n2n-ws-port>/n2n
wss://<relay-host>/n2n
```

Terminate TLS at a reverse proxy in front of the Gerolamo WebSocket port and keep the relay on the matching
network magic. A public deployment should rate-limit, monitor `/metrics`, and keep the node current.

## Troubleshooting

- `ws://` URL fails: confirm Gerolamo was started with `--n2n-ws` and `--n2n-ws-port`; check `ss` and `/health`.
- Wrong network: preview is 2, preprod is 1; the extension setting and the Gerolamo `--network` must agree.
- `127.0.0.1` fails from another machine: it means loopback on that machine; use the LAN/host name.
- HTTP endpoint fails but relay works: the mini-Blockfrost is on the node's `--port`, not the WebSocket port.
- First sync is slow: Docker/Bun uses the Mithril snapshot; a fresh preview genesis sync is expected to take
  much longer. Check Gerolamo logs and `/metrics` rather than assuming the relay is broken.
