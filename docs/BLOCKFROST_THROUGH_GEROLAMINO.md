# Blockfrost through Gerolamino (in the browser)

Gerolamino is the browser-side Blockfrost gateway: a page does not call `window.fetch` against a Blockfrost
proxy; it asks the extension, which answers from its own verified store first and otherwise forwards the
request to the Gerolamo peer it is connected to (N2N-over-WebSocket light query, request 8, mini-Blockfrost
backend). If the main relay cannot answer, an extra Gerolamo peer that supports Blockfrost queries answers
instead (the answer's `peer` names it, per-peer announced rate limits honoured). No project_id, no CORS, no
API key; the chain comes over the same socket the node already follows.

## What a page gets

`window.cardano.gerolamino.enable()` (one approval per site origin) returns an api with:

- `query(path)` → `{ status, body, source: "local" | "relay", peer, proof, ledger }` for any Blockfrost GET
  path (`/blocks/latest`, `/epochs/latest`, `/addresses/{addr}/utxos?count=100&page=1`,
  `/txs/{hash}/utxos`, `/utxo/{txhash:index}`, `/txs/{hash}/metadata`, `/assets/policy/{policy}`, ...).
  `ledger` is `{ startSlot, kind, tipSlot }` on local UTxO answers.
- `submitTx(txCborHex)` → tx id (a wallet-signed transaction; Gerolamino never signs).
- `getTip()`, `getTrust()`, `getNetworkId()`, `getUtxos(address)`, `getAccount(stake)`, `getProtocolParameters()`.

Limits: 60 calls per 10 s per origin; `query` paths start with `/`, max 1024 chars, no `..`; relayed
transaction answers carry Mithril proofs when the setting is on.

## The provider adapter

`src/dapp/blockfrostProvider.ts` (built to `dist/gerolamino-blockfrost.js`) wraps that api in the shape an
SDK provider expects:

```ts
import { enableGerolamino, gerolaminoProvider, hasGerolamino } from "./gerolamino-blockfrost.js";

if (hasGerolamino()) {
    const api = await enableGerolamino();              // approval window once per site
    const provider = gerolaminoProvider(api);          // hand this to the SDK instead of window.fetch
    const tip = await provider.json("/blocks/latest");
    const utxos = await provider.getAllPages("/addresses/" + addr + "/utxos");  // pages of 100, stops on a short page
    const txid = await provider.submitTx(signedCborHex);
}
```

`gerolaminoFetch(api)` gives a fetch-shaped `(url) => {status, body, source}` for SDKs that call a fetch
function internally; it strips `/api/v0` from full URLs. `provider.get(path, {count, page, order})` is the
paged GET; `provider.json` throws on non-200.

## When to use it

- Browser dApp with Gerolamino installed and connected: use the adapter; reads are local-first (stored block
  facts and local UTxO answers with coverage), then relay-backed, and the page never needs the Gerolamo HTTP
  port. A stale or partial local ledger relays rather than inventing UTxO.
- Bun/backend/CI: use the Gerolamo mini-Blockfrost over HTTP (`http://192.168.1.173:3040/api/v0/*` or the
  node's own `:3037`/`:3040`); the adapter needs `window`.
- Fallback: if `hasGerolamino()` is false (extension absent), keep the OnchainApps/Blockfrost provider; the
  adapter is additive, not a replacement.

## Proof

`bun test test/blockfrostProvider.test.ts` (4 tests: detection/enable, paged GET + error mapping,
getAllPages, submitTx + fetch shape). Live: `bun scripts/adapter-smoke.ts` (Brave headless, the real extension,
the Gerolamo peer): provider.json("/blocks/latest") local 200 (preview height 4,803,xxx),
get("/epochs/latest") relay 200 (epoch 1464), getAllPages("/addresses/{addr}/utxos") relay 200 (9 UTxOs
across 2 pages), get("/blocks/1000") relay 200. `bun scripts/e2e-chrome.ts --dapp` drives the same api in
Brave (`query("/blocks/latest")` → 200 local, `query("/epochs/latest")` → 200 relay, allow/deny per site).
The ledger P0 e2e (`--start chunk`) additionally proves `query("/txs/{hash}/utxos")` and `query("/utxo/{ref}")`
answer locally with `ledger: { startSlot, kind, tipSlot }` and resume the diff log after the offscreen document
is recreated.
