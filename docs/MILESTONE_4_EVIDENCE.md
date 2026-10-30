# Milestone 4 evidence: Browser adaptation and light node on the browser

Project: Harmonic Laboratories, Gerolamo (EC-0014-25), milestone 4. Status on treasury.sundae.fi (2026-10-29):
milestone Paused, 213 days late, no evidence submitted, 95,464.17 ADA allocated.

## Requirement to deliverable

| Milestone text | Gerolamino implementation | Evidence |
|---|---|---|
| Browser adaptation | MV3 extension: service worker keeps an offscreen node alive, popup + side panel in Gerolamo's look, approval window, settings, wipe, dApp page API `window.cardano.gerolamino` | `dist/` built 2026-10-29 (4001 KiB JS), extension id from e2e; popup/panel/tab screenshots |
| Light node on the browser | N2N-over-WebSocket initiator: handshake v14/v15, chain-sync, block-fetch, keep-alive, tx-submission; every header verified (hash/parent link, opcert, KES, VRF, leader) and body hash/size before storage; cardano-node chunk files in OPFS; tip/chunk/Mithril start modes; Mithril certificate chain | `bun scripts/node-smoke.ts` and Brave e2e PASS; STATUS measured rows |
| Local ledger state update | P0 UTxO projection from verified blocks: per-block `b-<slot>-<hash8>.ldiff` + `manifest.json` in `gerolamino/<network>/ledger`, blake2b digest chain, resume/rollback, coverage-first local `/txs/{hash}/utxos` and `/utxo/{txhash:index}` answers, address answers at coverage 0 only | unit ledger suite, `scripts/ledger-smoke.ts` PASS, Brave e2e PASS with ledger resume and local UTxO answers |

Deliverable: browser extension. The rebuilt Gerolamino is that extension; the original Effect/WASM Gerolamino
is documented as the predecessor (`docs/STATUS.md`, "Why it was rebuilt").

## Local ledger P0 (the gap closed on 2026-10-29)

Commit `d059ea6` (`Local UTxO ledger P0: verified blocks feed an OPFS diff log`, local `main`; not pushed).

- `src/node/ledgerApply.ts`: UTxO diff from a verified block's own bytes with `@harmoniclabs/cardano-ledger-ts`
  (`MultiEraBlock.fromCbor`). Phase-2 invalid transactions spend collateral only and create only a collateral
  return; reference inputs are not spent; unknown inputs are recorded per block.
- `src/node/ledgerStore.ts`: flat OPFS diff log, manifest written last, per-diff digest chain
  (`blake2b_256(prevDigestBytes ‖ diff JSON)`), resume replay with continuity checks, rollback by reversing
  newer diffs and deleting their files, idempotent re-apply, same-slot branch replacement, stale detection.
- Coverage is carried on every local UTxO answer: `window.cardano.gerolamino.query()` returns
  `ledger: { startSlot, kind, tipSlot }`; a stale ledger relays instead of inventing UTxO. `/addresses` answers
  locally only at coverage 0 (genesis/snapshot, P1), so partial verified-start coverage never claims complete
  address history.
- UI: popup Storage row `Ledger UTxO N blocks · M UTxO · from slot S`; Trust card `Local UTxO` row (verified only
  at coverage 0, trusted partial verified-start, warning stale). Wipe removes immutable + volatile + ledger.
- Honest limits: P0 is a UTxO projection with verified-start coverage. Full ledger rules (fees/deposits, stake,
  governance, epoch rewards, phase-2 scripts) are P2/P3; Mithril `tables` snapshot coverage is P1.

## Commands and measured output (2026-10-29)

```
bun run typecheck
  tsc --noEmit -p .                     clean

bun test
  138 pass, 0 fail (1107 expects, 25 files)

bun run build
  dist ready: ... (4001 KiB of JS, with Mithril)
  background/offscreen/popup/opfsWorker/approve/blockfrost/inpage/bridge/mithril bundles

bun scripts/ledger-smoke.ts --seconds 8 --start chunk --relay ws://192.168.1.173:3004/n2n
  PASS
  ledgerBlocks 4, ledgerCreated 13, ledgerSpent 8, ledgerUtxoCount 13,
  ledgerUnknownInputs 8, ledgerInvalidTx 0, ledgerTipSlot 126619300,
  ledgerCoverageStart 126619215, ledgerDigest ef33ba08fa66f97d5de89a8aae120fb63d73edd34d76628eadc2fa949a573993,
  ledgerStale false, ledgerFiles 5, ledgerBytes 11642
  localTxOutputs 2 on c38362b84ae9017f2a337a5255fa8563d03e25f8155e2e9e3cd04fbd8aebd26e,
  utxoAnswer for ...:0 amounts 6000000 lovelace + assets, coverage { startSlot: 126619215,
  kind: "verified-start", tipSlot: 126619300 }
```

Brave end-to-end (`bun scripts/e2e-chrome.ts --chrome /opt/brave.com/brave/brave --no-build --start chunk
--relay ws://192.168.1.173:3004/n2n --screenshot ...`): PASS.

- First phase wrote OPFS chunk files and ledger diffs; popup Storage showed the ledger row.
- `/txs/7abbb2c6.../utxos` returned `source: "local"`, status 200, 4 outputs, coverage
  `{ startSlot: 126619215, kind: "verified-start", tipSlot: 126620501 }`; `/utxo/7abbb2c6...:0` returned
  `source: "local"`.
- Offscreen document closed and recreated: ledger resumed (40 blocks, digest preserved, `ledgerStale: false`),
  chain resumed at the stored tip (40 stored after reopen vs 30 before), popup row read
  `37 blocks · 66 UTxO · from slot 126,619,215`.
- Screenshots (profile scratch, not committed):
  `popup.png`, `panel.png`, `tab.png`; the e2e popup probe read `37 blocks · 66 UTxO · from slot 126,619,215`
  (the run's own sync point; vision tools were unavailable, so the e2e gate is the textual proof).

## What the reviewer sees

- Extension source and `dist/` are in the repo; `bun run build` reproduces the unpacked extension.
- Local ledger code, unit tests and Live smoke/e2e assertions are in the repo (`docs/LEDGER_SPEC.md` implemented P0,
  not a draft).
- `docs/STATUS.md` carries the dated evidence and honest gaps; `README.md`/`AGENTS.md` carry the API/storage/query
  contracts.
- No keys, no signing: Gerolamino reads the chain and submits wallet-signed CBOR; it never claims to be a wallet.

## Suggested submission bundle

1. This file (`docs/MILESTONE_4_EVIDENCE.md`).
2. `docs/STATUS.md` sections "Local UTxO ledger (2026-10-29)", "Volatile store", "Peer-backed Blockfrost queries".
3. `docs/LEDGER_SPEC.md` (implemented P0) plus `src/node/ledgerApply.ts`, `src/node/ledgerStore.ts`.
4. Test log: `bun test` 152 pass/0 fail (1194 expects); `bun run typecheck` clean; `bun run build` 4011 KiB of JS.
5. Smoke/e2e transcript and screenshots (profile scratch), including `ledger: { startSlot, kind, tipSlot }`
   and the popup `Ledger UTxO` row.
6. Commit `d059ea6` (or the pushed hash once the user asks to push).

## Gaps left, stated honestly

- P1 Mithril `tables` snapshot coverage is implemented for local files (signed ancillary manifest check, streaming
  MemPack decoder, `snapshot.json` base, compaction); the aggregator/peer download and UI start mode are not wired yet.
  Partial verified-start answers relay for addresses by design.
- P2 full ledger rules and P3 consensus parity not built; no claim of full validation.
- Preprod run not done yet (preview pilot); signed tx submission remains untested with a real wallet.
- Byron header verification absent; Byron payload effects outside P0.
