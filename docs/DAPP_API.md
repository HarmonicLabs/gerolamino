# Gerolamino dApp API

`window.cardano.gerolamino` lets a web page use the visitor's own Cardano node. It follows CIP-30 conventions:
injection under `window.cardano`, one `enable()` approval per site, CBOR hex and the same error objects. Gerolamino holds
no keys, so it is not a wallet: it reads the chain for the page, says how each answer was verified, and submits
transactions a wallet already signed.

## Connecting

```js
const node = window.cardano?.gerolamino;   // undefined: Gerolamino is not installed
await node.isEnabled();                    // false until the user allows this site
const api = await node.enable();           // opens Gerolamino's "Allow this site?" window once
```

`enable()` rejects with `{ code: -3, info }` when the user denies or closes the window. The user can remove the site
later in Gerolamino's Settings ("Connected sites"); calls then fail with code -3 until `enable()` is called again.

## Methods

| Method | Returns | Notes |
|---|---|---|
| `getNetworkId()` | `0` testnet, `1` mainnet | CIP-30 |
| `submitTx(txCborHex)` | transaction id (hex) | CIP-30; sent to the network by the node's tx-submission |
| `query(path)` | `{ status, body, source, peer, proof }` | any Blockfrost GET, `path` under `/api/v0` (`"/blocks/latest"`) |
| `getUtxos(address)` | as `query` | `/addresses/{address}/utxos` |
| `getProtocolParameters()` | as `query` | `/epochs/latest/parameters` |
| `getAccount(stakeAddress)` | as `query` | `/accounts/{stakeAddress}` |
| `getTip()` | `{ slot, height, hash, network, state, peerTip }` | this node's newest verified block |
| `getTrust()` | `{ verdict, rows }` | the Trust card: block signatures, freshness, density, start point, nonce, stake, peers |
| `getExtensions()` | `[]` | CIP-30 |

### Where an answer comes from

`query` answers carry `source`:

- `"local"`: from blocks this node verified and stored itself (`/blocks/latest`, `/blocks/{id}`, `/blocks/{id}/txs`,
  `/txs/{hash}` for stored blocks).
- `"relay"`: from a Gerolamo peer that answers from its full ledger (`peer` names it). The main relay is asked
  first; when it cannot answer (no light query, timeout, 5xx), an extra Gerolamo peer that supports Blockfrost
  queries answers instead, honouring that peer's announced rate limit. A peer that announces capabilities without
  blockfrost is never asked. For `/txs/{hash}…` the node also asks Mithril for a proof that the transaction is
  on the chain, and `proof.status` is `"certified"` (with the certified block range), `"too-new"`, `"mismatch"`
  (the peer is wrong) or `"unavailable"`.

`status` and `body` are Blockfrost's: a 404 is `{ status: 404, body: { status_code: 404, … } }`, not an error.

## Errors

CIP-30 objects `{ code, info }`:

| Code | Meaning |
|---|---|
| -1 | InvalidRequest: unknown method or bad arguments |
| -2 | InternalError: the node failed (for example no verified block yet) |
| -3 | Refused: the site is not allowed, the user denied it, or the site called too often (60 calls per 10 s) |
| 1, 2 | `submitTx` only, TxSendError Refused or Failure |

## Security

- The site's origin is taken from the browser (the content script's sender), never from the page.
- Web pages can only reach the dApp calls; settings, the store and approvals are for Gerolamino's own pages.
- Only http and https pages get the API.

## Try it

```
bun scripts/serve-demo.ts          # http://127.0.0.1:8787/
```

Open the page with the extension loaded, press Connect and allow the site. The browser test drives the same page:
`bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://127.0.0.1:3039/n2n --dapp`.
