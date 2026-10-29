# Install Gerolamino as a browser extension

Gerolamino is a local chain reader, not a wallet. It keeps no keys and cannot sign. It needs a Gerolamo peer
that serves N2N-over-WebSocket; Gerolamo itself is a full node, Gerolamino is the browser light node.

Supported browsers: Chrome 116+ or Brave (MV3, `offscreen` document). The extension is loaded unpacked today;
there is no Chrome Web Store listing in this repository.

## 1. Before you start

- Bun 1.1+ and git are installed.
- You have a relay URL: `ws://host:port/n2n` or `wss://host/n2n`. A Gerolamo peer must listen on that WebSocket
  and serve the matching network magic. Ports are flags on Gerolamo, never environment variables.
- If you do not have a relay yet, run Gerolamo locally first: [RUN_LOCAL_GEROLAMO.md](RUN_LOCAL_GEROLAMO.md).
  The default setup there gives `ws://127.0.0.1:3004/n2n`.
- Pick the network at the relay: `preview` (magic 2) or `preprod` (magic 1). Gerolamino settings offer those two;
  mainnet (magic 764824073) is deferred on the browser side.

## 2. Build the extension

```bash
git clone https://github.com/HarmonicLabs/gerolamino.git
cd gerolamino
bun install
bun run build
```

`bun run build` writes the unpacked MV3 extension to `dist/`. The build also regenerates `manifest.json` and
the icons; do not load `src/extension/` directly, it has no bundled JavaScript.

## 3. Load it in Chrome or Brave

1. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `dist/` directory of the Gerolamino checkout.
4. Pin Gerolamino to the toolbar if you want the popup one click away.
5. The extension id is assigned by the browser on load; do not hard-code it in a dApp.

## 4. Configure the relay

1. Click the Gerolamino icon, then open **Settings** in the popup.
2. Network: `preview` for the local Gerolamo preview setup.
3. Relay URL: `ws://127.0.0.1:3004/n2n` for Gerolamo on the same machine. Replace host and port for a remote
   relay, for example `ws://relay.example:3004/n2n` or `wss://relay.example/n2n`.
4. Start mode: `tip` on a first run. `chunk` starts from the relay's newest complete chunk, `mithril` from the
   certified Mithril point. A stored tip wins when resuming.
5. Save. Settings live in `chrome.storage.local`; only Gerolamino's own pages can read them.

Extra relays are optional, must use the same network, and are capped at four. They cross-check the main peer's
headers; Blockfrost queries fail over only.

## 5. Verify the first start

- Popup **Relay** shows the peer's tip; **N2N** shows the handshake version and whether light query is available.
- **Blocks stored** and **Ledger UTxO** grow after the first block is verified. **Trust** shows local UTxO
  coverage or a stale warning.
- The popup **Storage** card shows immutable chunks, volatile files and the ledger row.
- Health checks outside the browser (replace port with the Gerolamo `--port`; Docker compose uses `3030`):
  ```bash
  curl -s http://127.0.0.1:3037/health | jq .
  curl -s http://127.0.0.1:3037/api/v0/ | jq '{version, endpoints}'
  ```
  (replace the port with the Gerolamo `--port` value).

If it does not connect, check in this order: the URL starts with `ws://` or `wss://` and ends in `/n2n`; the
relay host is reachable; Gerolamo was started with `--n2n-ws` and the port matches; network magic is the same;
the firewall or TLS proxy is not blocking WebSocket upgrades. HTTP is not the relay: Gerolamo's HTTP API is
only for the mini-Blockfrost fallback.

## 6. Reload after a rebuild

```bash
bun run build
```

Open `chrome://extensions`, find Gerolamino, and click **Reload**. Stored chain, ledger and settings survive a
reload. To start clean, use the popup's wipe action; it removes immutable chunks, volatile files and the local
UTxO ledger for the selected network, then the node syncs again from the relay.

## 7. dApps and the Blockfrost adapter

A page sees `window.cardano.gerolamino` (`apiVersion: "1"`, `dappApiVersion: "0.1.0"`, `isWallet: false`).
The extension asks for approval per site and rate-limits queries. The Blockfrost SDK adapter is built as
`dist/gerolamino-blockfrost.js`; see [DAPP_API.md](DAPP_API.md) and
[BLOCKFROST_THROUGH_GEROLAMINO.md](BLOCKFROST_THROUGH_GEROLAMINO.md).

For local testing, `bun scripts/serve-demo.ts` serves the demo at `http://127.0.0.1:8787/`. The e2e harness
loads an unpacked build itself:

```bash
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://127.0.0.1:3004/n2n --start chunk
```

## 8. Limits

Gerolamino verifies headers and block bodies, stores the verified chain, and answers UTxO queries with local
coverage. It does not sign, does not hold keys, and does not perform full ledger-rule/consensus parity yet
(P0 UTxO projection, coverage-first answers; P1/P2/P3 in [LEDGER_SPEC.md](LEDGER_SPEC.md)).
