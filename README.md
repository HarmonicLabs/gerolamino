# Gerolamino

A standalone Cardano node that runs in the browser as a Chrome extension.

- **Pure TypeScript.** Runtime code uses only the HarmonicLabs libraries (`@harmoniclabs/*`): no WASM,
  no Haskell storage, no Effect, no other third-party packages. The build fails if a bundle pulls in anything else.
- **Chain in OPFS.** Blocks are stored in the browser's Origin Private File System as cardano-node
  immutable chunk files (`.chunk` / `.primary` / `.secondary`), under `gerolamino/<network>/immutable/`.
- **Peers over N2N-over-WebSocket.** The node-to-node mini-protocols (handshake, chain-sync,
  block-fetch, keep-alive, tx-submission) over a WebSocket bearer, the same bytes a TCP peer sends.
  Gerolamo relays serve it today; the bearer is meant to become a CIP so any node can.

Gerolamino is its own node: it does not import code from Gerolamo.

```
bun install
bun run build      # dist/ is the unpacked extension (chrome://extensions → Load unpacked)
bun test
bun run typecheck
bun run smoke -- --seconds 60 --start chunk    # the node core under Bun against the preview relay
bun run e2e                                    # headless Chrome for Testing with the extension, over CDP
```

## What the node verifies

For every header from the relay: the header hash and the link to its parent; the operational certificate,
the KES signature and the VRF proof against the epoch nonce (Praos and TPraos); leader eligibility against
the pool's stake; then the block body's hash and size against the header. Only blocks that pass are stored.
The epoch nonce, pool stake and immutable chunks come over the same WebSocket through Gerolamo's light-query
mini-protocol (mux protocol 7). Ledger rules are not applied yet.

## Extension

- `background.js` (service worker) keeps the offscreen document alive (created on install and start-up,
  recreated when it closes, checked by a 30 s alarm) and relays messages between the popup and it.
- `offscreen.html` runs the node: connect, handshake (initiator-only, because a browser cannot serve), chain-sync,
  block-fetch, verification, OPFS writes, keep-alive, reconnect with backoff, tx submission, stats.
- `popup.html` shows the status, the settings (relay URL, network, start mode) and a box to submit a signed
  transaction. Settings live in `chrome.storage.local`; defaults: `preview`, `ws://192.168.1.173:3004/n2n`.

Start modes apply when the store for the network is empty; otherwise the node resumes from the stored tip.
`tip` starts at the relay's tip. `chunk` starts at the end of the relay's newest complete immutable chunk.
`mithril` starts at a Mithril-certified point, verified in the browser by `src/mithril/`, which the build
bundles as `mithril.js` when present and the node loads on demand.

## Layout

- `src/node/` the node core (no DOM, no Bun APIs): `browserNode.ts`, `runner.ts`, `handshake.ts`,
  `headerVerify.ts`, `vrf.ts`, `vrfInputs.ts`, `leaderMath.ts`, `lightQuery.ts`, `txSubmit.ts`,
  `chunkFormat.ts`, `chunkWriter.ts`, `opfsSink.ts`, `opfsWorker.ts`, `cbor.ts`, `networks.ts`, `mithrilLoader.ts`.
- `src/extension/` the MV3 extension: manifest, background, offscreen, popup, settings, messages.
- `scripts/` build, smoke run, Chrome e2e (with a small CDP client in `scripts/lib/cdp.ts`).
- `test/` unit tests. Tests that need cardano-node's preview chunk files are skipped when those files are absent;
  set `GEROLAMINO_PREVIEW_IMMUTABLE` to an `immutable/` directory to run them.

## Docs

- [`docs/STATUS.md`](docs/STATUS.md): why Gerolamino was rebuilt, what works, measured results, what is missing,
  problems found in the HarmonicLabs libraries, roadmap.
- [`docs/WEBSOCKET_BEARER.md`](docs/WEBSOCKET_BEARER.md): what Gerolamino needs from a peer over N2N-over-WebSocket,
  the basis for a CIP.
