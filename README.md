# Gerolamino

A standalone Cardano node that runs in the browser as a Chrome extension. Pure TypeScript on the
HarmonicLabs libraries, chain stored in OPFS, peers over N2N-over-WebSocket.

> **Agents: start with [AGENTS.md](AGENTS.md).** It has the gates, the live endpoints, the API
> contract and the storage invariants; this README is the human entry point.

## Quick start

```
bun install
bun run typecheck                  # tsc --noEmit -p .
bun test                           # unit tests (network-gated cases skip without chunk files)
bun run build                      # dist/ is the unpacked extension; load it with docs/INSTALL_EXTENSION.md
bun run smoke -- --seconds 60 --start chunk    # the node core under Bun against the preview relay
bun run e2e                                    # headless Chrome/Brave with the extension, over CDP
```

Live browser run against a Gerolamo relay (the default is the local one from `docs/RUN_LOCAL_GEROLAMO.md`):

```
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://127.0.0.1:3004/n2n --start chunk
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://127.0.0.1:3004/n2n --start mithril --trust
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://127.0.0.1:3004/n2n --dapp
```

Replace the relay URL with your Gerolamo host and `--n2n-ws-port` when it is not the same machine.

The e2e script wipes the store through the extension's own `wipe-store` message, so every run starts
clean. It needs a Chrome for Testing binary (or Brave) and an extension-capable profile; it drives the
extension over the Chrome DevTools Protocol with `scripts/lib/cdp.ts`.

## What it is

- **A browser node, not a wallet.** MV3 extension: `background.js` keeps the offscreen document alive,
  `offscreen.html` runs the node. No keys: it reads the chain, verifies it and submits transactions a
  wallet already signed (`submitTx` takes CBOR hex, returns the transaction id).
- **What it verifies.** For every header: header hash and parent link, operational certificate, KES
  signature, VRF proof against the epoch nonce, leader eligibility against the pool's stake; then the body
  hash and size. Only blocks that pass are stored.
- **Local UTxO projection.** Every stored block also feeds a local UTxO ledger in OPFS (P0 of
  `docs/LEDGER_SPEC.md`): created outputs, spent inputs, collateral-only spends for phase-2 invalid
  transactions, and a per-block diff log with a digest chain. Stored transactions answer
  `/txs/{hash}/utxos` and `/utxo/{txhash:index}` locally with coverage; address queries answer locally only
  from genesis/snapshot coverage, otherwise the Gerolamo peer answers.
- **What it does not do.** Full ledger rules, phase-2 script execution, stake/governance/epoch reward
  accounting and full consensus validation are not implemented (P2/P3). Say "UTxO projection from verified
  blocks with coverage", never "full node validation" or "UTxO from genesis".
- **Peers.** N2N-over-WebSocket as the initiator only (a browser cannot serve): handshake, chain-sync,
  block-fetch, keep-alive, tx-submission, plus Gerolamo's light-query protocol (Mithril digests, nonce,
  stake, chunks, Blockfrost). The bearer is meant to become a CIP; see `docs/WEBSOCKET_BEARER.md`.

Gerolamino is its own node: it does not import code from Gerolamo. Gerolamo servers serve it, Gerolamino
does not serve them.

## API for web pages (dApps)

`window.cardano.gerolamino` follows CIP-30 conventions (`apiVersion` is the CIP-30 string `"1"`,
`dappApiVersion` is Gerolamino's own `"0.1.0"`, `isWallet: false`). A page discovers it by sweeping
`Object.keys(window.cardano)` (the namespace is not a list) and calling `isEnabled()`/`enable()`.

| Method | Returns |
|---|---|
| `enable()` | per-site approval window, then the API object |
| `isEnabled()` | whether this site is approved |
| `getNetworkId()` | `0` testnet, `1` mainnet (CIP-30) |
| `submitTx(txCborHex)` | transaction id; sent by the node's tx-submission |
| `query(path)` | `{ status, body, source, peer, proof, ledger }`, any Blockfrost GET; `ledger` is `{ startSlot, kind, tipSlot }` on local UTxO answers |
| `getUtxos(address)` / `getProtocolParameters()` / `getAccount(stakeAddress)` | shorthands for `query` |
| `getTip()` | `{ slot, height, hash, network, state, peerTip }` |
| `getTrust()` | `{ verdict, rows }`, the Trust card as data |
| `getExtensions()` | `[]` |

Answers carry `source`: `"local"` when the node verified and stored the block (or the local UTxO ledger
justified it) itself, `"relay"` when a Gerolamo peer answered from its ledger (`peer` names it). Local UTxO
answers also carry `ledger: { startSlot, kind, tipSlot }`, the slot the UTxO state is complete from; a stale
ledger relays. For relayed transaction answers the node also asks Mithril for a proof (`certified`,
`too-new`, `mismatch`, `unavailable`). Errors are CIP-30 `{ code, info }`: -1 invalid request, -2 internal,
-3 refused; `submitTx` uses TxSendError 1/2. Rate limit is 60 calls per 10 s per origin, and approvals are
per origin (revocable in Settings). Only http/https pages get the API; the origin comes from the browser,
never the page. Full spec: `docs/DAPP_API.md`.

## Blockfrost through Gerolamino

A page does not call a Blockfrost proxy with `window.fetch`; it asks the extension. Reads come from its
own verified store first, otherwise from the Gerolamo peer over the same socket. `source: "relay"` names
the peer; no project_id, no CORS, no API key.

- **Failover.** The main relay is asked first; when it cannot answer (no light query, timeout, connection
  closed, 5xx) an extra Gerolamo peer that supports Blockfrost answers instead, honouring that peer's
  announced rate limit. A peer that announces capabilities without Blockfrost is never asked; a version-0
  peer without the announcement is probed last. No candidate gives a 503 with the peers tried, in
  Blockfrost's shape. Answer: `src/node/queryRouter.ts`; settings cap extra relays at 4.
- **SDK adapter.** `src/dapp/blockfrostProvider.ts` (built as `dist/gerolamino-blockfrost.js`) gives
  `hasGerolamino()`, `enableGerolamino()`, `gerolaminoProvider(api)` (`get/json/getAllPages/submitTx`) and
  `gerolaminoFetch(api)`; additive, so a page keeps its OnchainApps provider when the extension is absent.
- **Outside a browser.** Bun/backend/CI use Gerolamo's HTTP mini-Blockfrost on the node's `--port`
  (`http://127.0.0.1:3037/api/v0/*` for the local example, or `http://<node-host>:<http-port>/api/v0/*`);
  the adapter needs `window`.

Details and proof: `docs/BLOCKFROST_THROUGH_GEROLAMINO.md`.

## Storage (OPFS)

| Path | Contents |
|---|---|
| `gerolamino/<network>/immutable` | cardano-node immutable chunk files (`NNNNN.chunk\|primary\|secondary`) |
| `gerolamino/<network>/volatile` | one `v-<10-digit slot>.blk` per block within `securityParam` slots of the tip |
| `gerolamino/<network>/ledger` | one `b-<10-digit slot>-<hash8>.ldiff` per verified block plus `manifest.json` (UTxO coverage, digest chain; written last) |
| `gerolamino/<network>/immutable/mithril-anchor.json` | the Mithril-certified base of the stored chain (written once at a Mithril start) |
| `gerolamino/mithril-certs/<network>` | Mithril certificate cache (survives reinstall, avoids a second chain walk) |

Blocks near the tip stay volatile and are promoted into immutable chunks as they age
(`promoteOlderThan(h.slot - k)`; preview k=432, preprod/mainnet k=2160). Rollbacks inside k touch volatile
only. Resume order is chunks first, then volatile; the start point is the newer volatile tip. A resume
reads the anchor file only when its slot is not above the stored tip, and shows `resume-mithril` with the
Trust card row "Mithril-certified, resumed" (verified). Wipe removes immutable, volatile and ledger stores
(UTxO coverage restarts from the first verified block after the wipe).

The ledger resume replays `b-*.ldiff` files in slot order and checks the digest chain; a missing diff,
corrupt diff or tip mismatch marks the ledger stale, and stale local answers fall back to the Gerolamo peer.
The popup Storage card shows ledger blocks, UTxO count and coverage slot; the Trust card adds a "Local UTxO"
row (verified only at genesis/snapshot coverage 0, trusted for partial verified-start, warning when stale).

The certificate cache lives in `gerolamino/mithril-certs/<network>`, wired through the loader
(`src/mithril/index.ts`, `src/node/mithrilLoader.ts`); `mithril.js` is a separate bundle loaded on demand.

## Peers and live endpoints

| Endpoint | What |
|---|---|
| `ws://127.0.0.1:3004/n2n` | local Gerolamo relay (N2N-over-WebSocket + light query; default relay); replace host/port for a remote relay |
| `http://127.0.0.1:3037/api/v0/*` | local Gerolamo HTTP mini-Blockfrost, on the node's `--port` (Gerolamo side, not Gerolamino) |
| `http://<node-host>:<http-port>/api/v0/*` | any Gerolamo HTTP mini-Blockfrost (Bun/backend/CI fallback) |
| network magic | preview 2, preprod 1, mainnet 764824073; extension settings are preview/preprod |

Headers from extra relays are cross-checked (density, nonce, stake); only Blockfrost queries fail over.
Gerolamo must be started with `--n2n-ws` and `--n2n-ws-port`; the HTTP port is only `/api/v0` and `/health`.
Gerolamino itself has no listening port: the extension is its API surface, and the Gerolamo relay carries
the socket. Local setup: `docs/RUN_LOCAL_GEROLAMO.md`; extension setup: `docs/INSTALL_EXTENSION.md`.

## Settings (`chrome.storage.local`, one key)

| Key | Default |
|---|---|
| network | `preview` |
| relayUrl | `ws://127.0.0.1:3004/n2n` (local Gerolamo from `docs/RUN_LOCAL_GEROLAMO.md`) |
| startMode | `tip` (a stored tip always wins; otherwise `chunk` or `mithril`) |
| extraRelays | `[]` (at most 4, distinct, cross-checked) |
| certifiedStake | `true` (leader stake checked against Mithril's certified distribution) |
| txProofs | `true` (relayed transaction answers checked by Mithril) |
| mithrilDigests | `peer` (peer digests fast path; `aggregator` falls back to the IOG aggregator) |

Defaults live in `src/extension/settings.ts`. Web pages cannot read or write settings; only Gerolamino's
own pages can.

## Layout

- `src/node/` the node core (no DOM, no Bun APIs): `browserNode.ts` (start/resume/verify/store),
  `runner.ts` (peers, retries, failover), `query.ts`/`queryRouter.ts`, `localIndex.ts`,
  `ledgerApply.ts`/`ledgerStore.ts` (local UTxO projection and diff log),
  `lightQuery.ts`/`peerWatch.ts`, `headerVerify.ts`/`vrf.ts`/`leaderMath.ts`, `chunkFormat.ts`/
  `chunkWriter.ts`/`volatileStore.ts`/`opfsSink.ts`/`opfsWorker.ts`, `mithrilLoader.ts`/
  `mithrilAnchorStore.ts`, `txSubmit.ts`/`txProofCheck.ts`, `crossCheck.ts`/`trust.ts`, `networks.ts`.
- `src/extension/` the MV3 surface: `background.ts` (service worker), `offscreen.ts` (node host),
  `popup.ts`/`approve.ts`/`settings.ts`/`trustView.ts`, `inpage.ts` (MAIN world injection), `bridge.ts`,
  `dappApi.ts` (methods, approvals, rate limit), `manifest.json`.
- `src/dapp/` `blockfrostProvider.ts` (SDK adapter for pages).
- `src/mithril/` `index.ts` (loader entry: anchor, stake, tx proof with the OPFS certificate store).
- `scripts/` build, smokes (`node`, `query`, `query-failover`, `adapter`, `stake`, `trust`, `txproof`,
  `ledger`), `serve-demo.ts`, Chrome e2e and the CDP client in `scripts/lib/cdp.ts`.
- `examples/dapp-demo.html` the dApp demo page; `test/` unit tests.
- `vendor/` pinned HarmonicLabs tarballs (`mithril-ts`, `kes`, `cardano-ledger-ts`).

## Tests

`bun test` covers the core without a browser: chunk writers, volatile store, query router failover,
Blockfrost adapter, trust rows, header/CBOR paths and the local UTxO ledger (apply, spend, resume, rollback,
digest chain, stale detection). Tests that need cardano-node's preview chunk files are skipped without them;
set `GEROLAMINO_PREVIEW_IMMUTABLE` to an `immutable/` directory to run them. The browser e2e
(`scripts/e2e-chrome.ts`) is the live proof for start modes, resume, Trust checks, the dApp API and the
Blockfrost adapter, including local UTxO answers and ledger resume.

## Docs

- [`AGENTS.md`](AGENTS.md) agent-facing: gates, live endpoints, API and storage contracts, pitfalls.
- [`docs/STATUS.md`](docs/STATUS.md) dated status: what works, measured results, gaps, library problems.
- [`docs/DAPP_API.md`](docs/DAPP_API.md) the dApp API and approval/error contract.
- [`docs/BLOCKFROST_THROUGH_GEROLAMINO.md`](docs/BLOCKFROST_THROUGH_GEROLAMINO.md) Blockfrost transport and
  the SDK adapter.
- [`docs/WEBSOCKET_BEARER.md`](docs/WEBSOCKET_BEARER.md) what Gerolamino needs from a peer, basis for a CIP.
- [`docs/INSTALL_EXTENSION.md`](docs/INSTALL_EXTENSION.md) step-by-step unpacked install, first relay, verification and reload.
- [`docs/RUN_LOCAL_GEROLAMO.md`](docs/RUN_LOCAL_GEROLAMO.md) run Gerolamo locally as the relay (Docker and Bun flags).
- [`docs/LEDGER_SPEC.md`](docs/LEDGER_SPEC.md) the local UTxO ledger: implemented P0 coverage model, OPFS
  diff log, resume/rollback and digest chain; P1 snapshot bootstrap next.
- [`docs/MILESTONE_4_EVIDENCE.md`](docs/MILESTONE_4_EVIDENCE.md) the milestone 4 submission file: requirement to
  deliverable mapping, measured gates, Brave e2e transcript, honest gaps and bundle checklist.
