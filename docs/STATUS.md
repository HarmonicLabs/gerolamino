# Gerolamino status (2026-10-16)

Gerolamino is a standalone Cardano node for the browser, shipped as a Chrome MV3 extension. This page records
why it was rebuilt, what works, what was measured, what is missing, and the problems found in the libraries it
depends on.

## Role and scope (2026-10-22)

Gerolamino is the light member of the Gerolamo family, not a smaller copy of all of it.

- **What it is.** A data and information node: it follows the chain, verifies what it receives, keeps it in
  OPFS and answers questions about it. It may later act as a relay for other browser peers.
- **What it is not.** It will never host a stake pool. Block production, KES keys and leader schedules stay in
  Gerolamo.
- **Default use.** Most people will sync from the tip. That path must stay fast, small and dependable. Starting
  from an immutable chunk or a Mithril-certified point, and a ledger state (UTxO set) in OPFS, are welcome
  extras, never requirements for the default path.
- **Look and feel.** The UI follows Gerolamo's desktop app (Electrobun, `gerolamo/desktop`), simpler and
  lighter: same dark theme, red-to-orange accent, cards, progress ring and badges. It does not follow the old
  web dashboard. Gerolamino builds it in plain TypeScript and CSS, because it takes no third-party runtime
  packages (no Solid, no Tailwind).

## Why it was rebuilt

The first Gerolamino (HarmonicLabs/gerolamino `main`, May 2026) was an Effect v4 monorepo. It used Haskell
`lsm-tree` compiled to WebAssembly with GHC's WASM backend for storage, and Rust crates compiled to WASM for the
multiplexer and crypto. It reached peers through a websockify proxy in front of a cardano-node relay.

On 2026-10-16 we ran it against Gerolamo's native N2N-over-WebSocket bearer:

- **Network: worked.** Handshake (version 15), intersection, rollback, and 6 215 blocks streamed in three minutes.
- **Storage: failed.** Every block write failed inside its WASM LSM store, whose session never opened in
  genesis mode.
- **Before that, a silent stop.** Effect API drift stopped the sync before the socket opened: a renamed
  `timeoutOrElse` option threw.
- **Build.** The storage layer can only be built through Nix and the GHC WASM toolchain.

The decision was to rebuild it in pure TypeScript on the HarmonicLabs libraries, with no Haskell, no WASM, no
Effect and no third-party runtime packages, and the chain kept in OPFS. Gerolamino stays its own codebase. It
does not import Gerolamo; the pieces it shares in spirit (chunk format, header checks, Mithril verification) are
ported and owned here.

## What works

| Area | State |
|---|---|
| N2N over WebSocket | handshake (v14/v15, initiator-only), chain-sync, block-fetch, keep-alive, tx-submission |
| Header checks | hash and parent link, operational certificate, KES, VRF against the epoch nonce (Praos, TPraos), leader eligibility |
| Body checks | body hash and size against the header; only verified, linked blocks are stored |
| Storage | cardano-node immutable chunk files in OPFS, byte-identical to cardano-node's; resume and rollback across chunk boundaries |
| Start modes | relay tip, newest complete chunk, Mithril-certified point; a stored tip always wins |
| Mithril | full certificate-chain verification to genesis (STM multi-signatures, BLS12-381, genesis ed25519), Merkle root of the cardano-database digests, chunk digests |
| Extension | service worker keeps the offscreen node alive and recreates it; popup in the desktop app's look (sync ring, epoch bar, tip tiles, verification cards, storage, recent blocks; settings, tx submission, wipe; "Open in a tab" for a wide view) |
| Dependencies | runtime `@harmoniclabs/*` only; the build fails on anything else |

## Volatile store (2026-10-28)

Blocks within k slots of the tip are no longer written into the immutable chunk files. They live in
`gerolamino/<network>/volatile` (one `v-<slot>.blk` file per block, header hash + block bytes) and are
promoted to the chunk writer only when they are k slots behind the tip (`promoteOlderThan(h.slot - k)`).
A rollback inside the k window therefore truncates volatile files only; chunk files are rewritten only
when a rollback crosses the k boundary. Resume reads the chunks first, then the volatile store, and starts
at the volatile tip when it is newer. Files under the volatile path: at most about k slots of blocks.

Live (Brave, `scripts/e2e-chrome.ts --start chunk --relay ws://192.168.1.173:3004/n2n`, 2026-10-28): PASS.
The immutable directory held one chunk (29295), the volatile store the newer blocks; after closing and
recreating the offscreen document the node resumed at the volatile tip (126555200) with no block lost
(34 stored before, 36 after), and the popup showed 41 blocks with tip slot 126555407.

## Peer-backed Blockfrost queries (2026-10-28)

A Blockfrost GET the local index cannot answer goes to the main relay first. When that peer cannot answer (no
light query, timeout, connection closed, 5xx, or an announcement without `blockfrost`), the query fails over to
an extra Gerolamo peer that speaks the light query: peers that announce `blockfrost` come first, version-0 peers
(no announcement) are probed last, and each peer's announced rate/window is honoured (a rate-limited peer is
skipped, not failed). The answer names the peer that actually answered (`peer`), and a 503 is returned only when
no peer answers. Code: `src/node/queryRouter.ts`; runner candidates: main node first, then watchers
(`src/node/runner.ts` `queryCandidates`).

Live (Bun, `scripts/query-failover-smoke.ts`, 2026-10-28): main relay `ws://127.0.0.1:9999/n2n` dead, extra
`ws://192.168.1.173:3004/n2n`: `/addresses/{addr}/utxos` 200 (peer `ws://192.168.1.173:3004/n2n`), `/epochs/latest`
200 (epoch 1465), `/blocks/1000` 200 (height 50). PASS.

## Not being fooled by peers (2026-10-23)

Signature checks stop a peer from forging blocks. These checks stop it from lying in other ways.

| # | Check | What it catches | Code | Live test |
|---|---|---|---|---|
| 1 | Freshness and density | a stale tip; a private fork from a small pool (too sparse, too few pools) | `src/node/trust.ts` | `scripts/trust-smoke.ts`: fresh, density 0.63 to 0.78, about 40 pools |
| 2 | Trust panel | shows each fact as verified, trusted (still the peer's word) or warning | `src/extension/trustView.ts` | popup Trust card |
| 3 | Several peers | withheld or different blocks, a stale main peer; failover to the longer chain, rollback to the common block on a fork, a peer serving bad headers dropped | `src/node/crossCheck.ts`, `peerWatch.ts`, `runner.ts` | `scripts/peers-smoke.ts`: 3039 and .173 agree; dead main peer replaced in 20 s |
| 4 | Stake and nonce | the leader stake from Mithril's certified distribution (artifact N - 2 for epoch N), peer figures compared with it; the nonce confirmed by distinct pools' VRF proofs and by other peers | `src/mithril/stake.ts`, `browserNode.ts` | `scripts/stake-smoke.ts`: 646 pools certified, 0 mismatches, nonce confirmed by 48 pools and 2 of 2 peers |
| 5 | Mithril proofs for relayed answers | a made-up transaction or a wrong block height in a relayed `/txs/{hash}` answer | `src/mithril/txProof.ts`, `src/node/txProofCheck.ts` | `scripts/txproof-smoke.ts`: proven in blocks 4785195 to 4785209 |

Settings: extra relays (up to 4), "Check pool stake with Mithril" and "Check relayed transaction answers with
Mithril proofs" (both on by default). A first Mithril check walks the certificate chain to genesis (331
certificates on preview, about 3 minutes in Bun); later checks stop at certificates already verified.

All five in the browser (Brave, `scripts/e2e-chrome.ts --start mithril --relay ws://127.0.0.1:3039/n2n
--extra ws://192.168.1.173:3004/n2n --trust`, 2026-10-23): PASS. Mithril start: 332 certificates to genesis in
143 s (19 s verifying), certified point slot 126074844; stake certified for epoch 1459 after 1 more certificate
(1.3 s); 507 headers and 507 leader checks, 0 bad; nonce confirmed by 47 pools and 2 of 2 peers; .173 agrees;
a relayed `/txs` answer proven in blocks 4782420 to 4782434.

Follow-ups:
- Done 2026-10-23: the Mithril start took about 6 minutes more downloading the cardano-database digests (10 MB;
  the aggregator sends about 27 KB/s). A Gerolamo peer now serves them from its own chunk files (light query
  request 10, `digests` capability; it hashes its store once, 149 s for preview's 15 GB, and keeps a cache), the
  download runs during the certificate walk, and the list must reproduce the certified Merkle root. Setting
  "Mithril files from": Gerolamo peer (default) or Mithril aggregator (direct, no peer needed); a peer without
  digests, or with wrong ones, falls back to the aggregator. Mithril start in Bun: 69 s (was about 9 minutes).
- Done 2026-10-29: the anchor is written next to the chunk files (`mithril-anchor.json`) when the Mithril start
  verifies; a resume reads it and the Trust card shows "Mithril-certified, resumed" (verified) while the stored
  chain still reaches that slot. Brave `scripts/e2e-chrome.ts --start mithril`: anchor slot 126584621 written,
  after reopen `startMode` resume-mithril with the same anchor slot, stored 42 → 50 blocks.

## dApp API (2026-10-23)

`window.cardano.gerolamino`, CIP-30 style, for web pages: `enable()` with a per-site approval window, network
id, tip, Trust checks, Blockfrost queries answered locally or by the Gerolamo peer (with Mithril proofs on
transactions) and `submitTx`. No keys, so no signing. Spec and examples in `docs/DAPP_API.md`; demo page
`examples/dapp-demo.html` (`bun scripts/serve-demo.ts`); browser test `scripts/e2e-chrome.ts --dapp` (PASS in
Brave: allow, calls, deny on a second site).

## Measured

All live runs were against Gerolamo's preview relay, `ws://192.168.1.173:3004/n2n`.

| Run | Result |
|---|---|
| `bun test` | 119 pass, 3 skipped (network-gated), 0 fail; `tsc` clean |
| Smoke, newest-chunk start, 60 s | 517 headers verified (crypto 517 / 0, leader 517 / 0), 516 bodies checked and stored in 4 chunks, 8.6 headers/s |
| Smoke, tip start, 120 s | follows the tip; one real rollback undone correctly |
| Smoke, Mithril start | 325 certificates verified to genesis, 87 165 digests reproduce the certified Merkle root, then 552 / 552 headers |
| Chrome for Testing 155, headless | verified blocks in OPFS after 2.8 s; offscreen document closed and recreated, resumed from the stored tip; popup refuses a malformed transaction |
| Mithril cross-check against Gerolamo's verifier | 1 757 cases, all agree, including tampered certificates (flipped signature, key, stake, message, previous hash) |
| Mithril chain walk | cold 47–51 s (network-bound, one certificate at a time); warm certificate cache 7–8 s; verification alone 5–7 s for 325 certificates |

The browser e2e drives Chrome over the DevTools Protocol with a small client in `scripts/lib/cdp.ts`; no Playwright
or Puppeteer.

## Speed

Header checks cost about 110–170 ms in Bun and 180–290 ms in Chrome. The default ed25519 and VRF in
`@harmoniclabs/crypto` are BigInt implementations at 40–65 ms per operation. That is fine at the tip and slow
from genesis, about 8.6 headers/s.

The fix stays inside the HarmonicLabs libraries. `@harmoniclabs/crypto` ships a strict port of noble's ed25519
under `dist/noble/ed25519.js` that verifies in about 1 ms; Gerolamo's header validation already uses it. The VRF
can be rebuilt on the same curve code.

## Not done

- Ledger rules: transactions are not applied, so there is no UTxO set.
- The epoch nonce is confirmed, not computed: computing it needs the whole previous epoch's headers.
- No preprod run yet; there is no preprod Gerolamo relay.
- The Mithril start ran in Bun, not yet inside the extension. Its OPFS certificate cache exists but is not
  wired through the loader.
- Real signed transaction submission is untested.
- Byron headers are not verified.
- Session counters reset when the offscreen document is recreated.

## Problems found in the HarmonicLabs libraries

Each is pinned by a test here and worked around in Gerolamino's own code.

1. **`@harmoniclabs/crypto` 0.3.1, ed25519 (`verifyEd25519Signature_sync`).**
   - **Forgery.** With the identity public key (`01 00…00`), the signature R = identity, S = 0 verifies for
     any message.
   - **Too lenient.** It accepts S + ℓ (malleable), non-canonical point encodings, and small-order keys and R.
   - **Bad lengths.** It throws instead of returning false.
   - **Wrong typings.** `verifyEd25519Signature` is typed with the argument order `(publicKey, signature,
     data)`, but runs the sync function `(signature, message, publicKey)`.
   - **Workaround here.** Gerolamino uses a strict check with dalek `verify_strict` semantics. Gerolamo's
     header path uses the bundled noble port and is not exposed.
2. **`@harmoniclabs/crypto` 0.3.1, VRF.** `VrfProof03.verify` accepts a non-canonical response scalar (s + ℓ),
   which libsodium rejects.
3. **`@harmoniclabs/crypto` 0.3.1, BLS12-381.** `bls12_381_G1_uncompress` / `G2_uncompress` accept x ≥ p
   (reduced mod p), where blst returns BAD_ENCODING. This is also a Plutus-builtin conformance issue.
4. **`@harmoniclabs/crypto`, missing pieces.**
   - No blake2s; implemented in `src/mithril/blake2s.ts`.
   - No multi-scalar multiplication; Pippenger in `src/mithril/bls.ts` cut a 56-signer aggregation from 686 ms
     to 58 ms.
   - The package index is CommonJS and bundles every algorithm; `src/mithril/hl.ts` imports modules directly,
     205 KB instead of 310 KB.
5. **`@harmoniclabs/ouroboros-miniprotocols-ts` 0.0.5-dev7, handshake.**
   - `HandshakeClient.propose(versionTable)` never recognises a version table: `isVersionTableMap` checks the
     string keys of `Object.keys` with a number-only guard. It then throws
     `VersionData :: invalid networkMagic: undefined`.
   - The default proposal stops at version 14.
   - Gerolamino sends its own proposal (`src/node/handshake.ts`).

## Roadmap

1. **Speed.** Use `@harmoniclabs/crypto`'s fast ed25519 port, and rebuild the VRF on the same curve code.
2. **N2N over WebSocket as a CIP.** Write it from the server and client experience gathered here, so any node
   can serve Gerolamino peers; see `WEBSOCKET_BEARER.md`.
3. **Several peers and chain selection.** Done 2026-10-23 (see "Not being fooled by peers").
4. **Volatile store.** Done 2026-10-28 (see "Volatile store"): blocks within k slots of the tip stay in
   `volatile` files, promoted to immutable chunks as they age; rollbacks inside k touch volatile only.
5. **Ledger state in OPFS (optional extra).** A pure-TypeScript key-value store over OPFS for the UTxO set,
   then ledger rules. Mithril's ledger snapshot `tables` file is already a sorted run (preview, 2026-10-22:
   3 169 305 entries, 34-byte keys in strictly ascending byte order, 650 MB), so it can serve unchanged as the
   base level, with a sparse key index, small sorted delta runs for later blocks, the last k blocks' changes in
   memory for rollback and a manifest written last. Caveats: those files are signed only by IOG's ancillary
   Ed25519 key, not the Mithril multi-signature, and their values are MemPack, which needs a decoder of our own.
6. **Library fixes upstream.** The issues above, on `conformance-fixes`-style branches.
