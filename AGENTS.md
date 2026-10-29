# AGENTS.md

Agent-facing guide for this repo (Gerolamino, the browser node). Read this before changing code, docs or
tests. It carries the gates, the live endpoints, the API and storage contracts, and the pitfalls that
have already cost cycles. Do not rely on memory of the repo: read `git status`, `git log` and the source
first, because this file and `docs/STATUS.md` are dated snapshots.

Repo: `/media/bakon/data/Dev/HarmonicLabs/gerolamino-ts`, branch `main`, remote
`https://github.com/HarmonicLabs/gerolamino.git` (commits stay local unless the user asks to push).

## Read order for a task

1. `git status --short; git log --oneline -5` - what is already committed and what is in flight.
2. `docs/STATUS.md` - dated state, measured evidence, gaps; treat "Not done" as a claim to re-verify,
   not a fact.
3. The relevant source and its tests (search first; never invent a symbol).
4. The gates below. Report only what real command output showed.

## Gates (in this order)

```
bun install                       # vendor tarballs are pinned file: deps
bun run typecheck                 # tsc --noEmit -p . must be clean
bun test                          # unit tests; report pass/fail and expect() count
bun run build                     # dist/ bundle + manifest; the build rejects non-HarmonicLabs runtime deps
```

Then, for anything touching the extension surface, the browser e2e is the proof (not `bun test`):

```
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://192.168.1.173:3004/n2n --start chunk
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://192.168.1.173:3004/n2n --start mithril --trust
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://192.168.1.173:3004/n2n --extra ws://192.168.1.173:3004/n2n --trust
bun scripts/e2e-chrome.ts --chrome /usr/bin/brave-browser --relay ws://192.168.1.173:3004/n2n --dapp
bun scripts/query-failover-smoke.ts         # dead main relay + live extra peer
bun scripts/adapter-smoke.ts                # Blockfrost SDK adapter through the real extension
bun scripts/serve-demo.ts                   # http://127.0.0.1:8787/ dApp demo
```

`scripts/e2e-chrome.ts` wipes the store through `chrome.runtime.sendMessage({ to: "background",
type: "wipe-store" })` then starts the requested mode, so every run is clean; `--no-build` reuses dist
when only scripts/tests changed. `--keep-profile` leaves the temp profile. Phase 1 gates on
`opfs.chunks > 0`, so a volatile-only run needs promotion before it can pass. `--dapp` serves
`examples/dapp-demo.html` on localhost and drives allow/deny from two sites.

Never `pkill bun` or kill by process name; derive the pid from the run (profile `--user-data-dir` in
`/proc/<pid>/cmdline`, or the port served). The e2e script cleans up its own Chrome processes.

## Live endpoints and networks

| Endpoint | Role |
|---|---|
| `ws://192.168.1.173:3004/n2n` | Gerolamo preview relay: N2N-over-WebSocket plus light query; the extension's default relay |
| `http://192.168.1.173:3040/api/v0/*` | Gerolamo HTTP mini-Blockfrost (Gerolamo node side; LAN-exposed 2026-10-28) |
| `http://127.0.0.1:3037` | local Gerolamo preview node's mini-Blockfrost |
| network magic | preview 2, preprod 1, mainnet 764824073 (Gerolamo); extension settings offer preview and preprod |

Gerolamino does not listen: the extension is its API surface, and Gerolamo serves the socket. Preview is
the pilot network (user directive); preprod is the Gerolamo-first target when the browser run moves.
Test data: Gerolamo preview DB at `/media/bakon/data/cardano/gerolamo-preview-genesis3037`, local node
pid comes from `ss -ltnp` on `:3037`; do not touch that DB while the node runs (one writer per DB).

## Architecture map

| Path | Contract |
|---|---|
| `src/node/browserNode.ts` | start/resume/verify/store, rollback, anchor, stats; single writer on the OPFS sinks |
| `src/node/runner.ts` | relay list (main + up to 4), retries, session counters, trust assembly, failover |
| `src/node/query.ts` / `queryRouter.ts` | Blockfrost GET: local index first, then peers in order, per-peer timeout/rate limits, 503 only when none |
| `src/node/localIndex.ts` | always-on in-memory index of stored blocks/tx facts; answers only block/tx paths |
| `src/node/volatileStore.ts` | one file per near-tip block; promote on age; rollback inside k leaves chunks alone |
| `src/node/chunkWriter.ts` / `opfsSink.ts` / `opfsWorker.ts` | cardano-node immutable chunk files through OPFS (worker for async) |
| `src/node/lightQuery.ts` / `peerWatch.ts` | request 8/9/10/11/12 style light query: chunk, digests, nonce, stake, Blockfrost limits |
| `src/node/mithrilLoader.ts` / `mithrilAnchorStore.ts` / `src/mithril/index.ts` | verify on demand; anchor file next to chunks; cert cache through OPFS |
| `src/node/txSubmit.ts` / `txProofCheck.ts` | tx submission (CIP-30 shape) and Mithril proof statuses |
| `src/extension/background.ts` / `offscreen.ts` | worker keeps offscreen alive; offscreen runs the node |
| `src/extension/inpage.ts` | MAIN-world injection at document_start; API object, `apiVersion "1"`, `dappApiVersion "0.1.0"`, `isWallet: false` |
| `src/extension/bridge.ts` / `dappApi.ts` | page/bridge messages; approvals, rate limit 60/10 s, CIP-30 error codes, dispatch |
| `src/extension/popup.ts` / `approve.ts` / `settings.ts` / `trustView.ts` | UI, approvals, settings (chrome.storage.local), Trust rows |
| `src/dapp/blockfrostProvider.ts` | page adapter (`hasGerolamino`, `enableGerolamino`, `gerolaminoProvider`, `gerolaminoFetch`), built as `dist/gerolamino-blockfrost.js` |
| `scripts/e2e-chrome.ts` / `scripts/lib/cdp.ts` | browser run over CDP without Playwright/Puppeteer |
| `examples/dapp-demo.html` | dApp demo page driven by `--dapp` |

## Non-negotiable constraints

- Runtime code is pure TypeScript on `@harmoniclabs/*` only. The build fails if a bundle pulls in
  anything else (no WASM, no Haskell storage, no Effect, no other third-party packages). HarmonicLabs
  library edits: rebuild, `npm version` / `npm pack`, copy the `.tgz` to `vendor/`, update package.json
  `file:vendor/...`; never add a registry dependency casually.
- No runtime environment variables: extension settings live in `chrome.storage.local` under
  `gerolamino.settings`; script flags are arguments. The one test-only env var is
  `GEROLAMINO_PREVIEW_IMMUTABLE` (chunk-file fixtures).
- No keys and no signing: `submitTx` takes signed CBOR hex and returns the id. Do not claim Gerolamino is a
  wallet (`isWallet: false`), and do not add signing "for convenience".
- The extension is initiator-only: no incoming N2N in the browser. Gerolamo serves peers; Gerolamino is
  the client.
- Ledger rules are not applied: no UTxO set, no full consensus validation. Say "blocks verified and
  stored" or "light query", never "full node validation".
- One writer per store: browserNode owns immutable + volatile sinks; Gerolamo node DBs are separate
  (SQLite WAL, one writer).
- Content scripts cover `http://*/*` and `https://*/*` at `document_start`; the API origin comes from the
  browser sender, never from the page.
- Do not commit scratch/harness files; put probes in the profile scratch dir and commit only scripts the
  repo references.

## API contract (extension)

| Surface | Contract |
|---|---|
| discovery | `window.cardano` is a namespace, not a list; sweep keys for `enable`/`isEnabled`; Gerolamino appears as `window.cardano.gerolamino` |
| versions | `apiVersion` is the CIP-30 string `"1"`; own version is `dappApiVersion: "0.1.0"`; `isWallet: false`; `supportedExtensions: []` |
| methods | `enable`, `isEnabled`, `getNetworkId`, `submitTx`, `query`, `getUtxos`, `getProtocolParameters`, `getAccount`, `getTip`, `getTrust`, `getExtensions` |
| approval | per origin, one window; revocable in Settings ("Connected sites"); calls fail -3 until `enable()` |
| errors | CIP-30 `{ code, info }` -1 InvalidRequest, -2 InternalError, -3 Refused; `submitTx` TxSendError 1/2 |
| rate | 60 calls per 10 s per origin (`DAPP_RATE` / `DAPP_WINDOW_MS`); exceed gives -3 |
| query answer | `{ status, body, source, peer?, proof? }`; `source` `"local"` or `"relay"`; status/body follow Blockfrost, 404 is a body not an error |
| tx proof | `certified`, `too-new`, `mismatch` (peer wrong), `unavailable`; relayed answers only when `txProofs` is on |
| adapter | `hasGerolamino()`, `enableGerolamino()`, `gerolaminoProvider(api)`, `gerolaminoFetch(api)`; additive fallback keeps OnchainApps |

A site's call surface is only http/https pages; settings and the store stay in Gerolamino's own pages.

## Storage contract

| Path | Invariant |
|---|---|
| `gerolamino/<network>/immutable` | chunk files `NNNNN.chunk\|primary\|secondary` (chunkNo padded to 5 digits, not 10) |
| `gerolamino/<network>/volatile` | `v-<10-digit slot>.blk` = 32-byte header hash + block bytes; only within k slots of the tip |
| `gerolamino/<network>/immutable/mithril-anchor.json` | base of the stored chain; written once at a Mithril start, never overwritten on later resumes |
| `gerolamino/mithril-certs/<network>` | certificate cache; survives reinstall |

Resume order: `ChunkWriter.resume()` first, then `VolatileStore.resume()`; the start point is the newer
volatile tip. Promotion: `promoteOlderThan(h.slot - k)` (preview k=432, preprod/mainnet k=2160) moves
aged volatile blocks into the chunk writer; rollback inside k touches volatile only. The anchor file is
accepted on resume only when its slot is not above the stored tip; corrupt JSON, bad hash or non-integer
slot is rejected, and `startMode` becomes `resume-mithril` with the Trust row "Mithril-certified, resumed"
(verified). Never write near-tip blocks straight into chunks: that reintroduces rollback rewriting.
`refreshOpfs` sums immutable + volatile bytes/files but counts chunks only for immutable; wipe removes both.

## Peer / failover contract

- Main relay is asked first; candidates are watchers that announce `blockfrost` and version-0 peers last
  (probed because they predate the announcement). A peer announcing capabilities without blockfrost is
  never asked.
- A candidate failure (no light query, timeout, connection closed, unsupported, 5xx) yields to the next;
  a rate-limited candidate is skipped without counting. Per-candidate timeout defaults to 10 s; per-peer
  announced `blockfrost: { rate, window_ms, maxBody }` is honoured.
- No candidate gives a 503 with the tried peers in Blockfrost's error shape. Answers name the peer that
  actually answered (`peer`).
- Local answers stay limited to the stored blocks: `/blocks/latest|{hash|height}`, `/blocks/{height}/txs`,
  `/txs/{hash}`; everything ledger-shaped is relayed. Do not promise UTxO/balances without ledger state.
- Gerolamo announces light query capabilities `nonce/stake/chunk/digests/blockfrost`; Gerolamino only
  consumes them.

## Trust model

| Tone | Meaning |
|---|---|
| verified | cannot be faked by a peer: block signatures/KES/VRF/leader checks, density, Mithril-certified start point, computed nonce |
| trusted | can be wrong if the peer lies: stored-chain start, peer chunk/tip anchor, peer nonce/stake while checking |
| warning | something looks wrong now: failed checks, sparse density, disagreeing peers, stake mismatch |

Start point rows: `Mithril-certified` (fresh start, verified), `Mithril-certified, resumed` (anchor file,
verified), `this node's stored chain` (plain resume, trusted), peer chunk/tip (trusted). Do not promote a
trusted row to verified without evidence.

## Settings contract

| Key | Values / default |
|---|---|
| `network` | `preview` or `preprod`; default `preview` |
| `relayUrl` | ws/wss URL with host; default `ws://192.168.1.173:3004/n2n` |
| `startMode` | `tip`, `chunk`, `mithril`; default `tip`; a stored tip always wins |
| `extraRelays` | distinct, trimmed, at most 4 (`MAX_EXTRA_RELAYS`) |
| `certifiedStake` | default `true` |
| `txProofs` | default `true` |
| `mithrilDigests` | `peer` (default) or `aggregator` |

Keys live in `src/extension/settings.ts`; normalize on load; invalid values fall back to defaults.

## Docs update obligation

When a feature or defect lands, update in the same commit (or in a docs-only follow-up the user asks for):

1. `docs/STATUS.md` with a date and real measured evidence (command, numbers, PASS line). Remove a stale
   "Not done" bullet when its claim becomes false; do not leave a done item in that list.
2. `docs/DAPP_API.md` when the page API surface, error codes, approvals, rate or query sources change.
3. `docs/BLOCKFROST_THROUGH_GEROLAMINO.md` when transport, adapter, failover or local/relay semantics change.
4. `README.md` and this file when layout, commands, endpoints or contracts change.
5. `docs/WEBSOCKET_BEARER.md` when peer wire requirements change.

`docs/STATUS.md` is the dated source of truth for gaps; keep its Measured table current or mark it dated.

## Known gaps (verify in STATUS before acting)

- Ledger rules / UTxO set in OPFS: roadmap item 5, not implemented.
- Epoch nonce is confirmed by peers/pools, not computed from headers yet.
- No preprod Gerolamo relay run; preview is the current pilot.
- Real signed transaction submission is untested (malformed tx refusal is tested).
- Byron header verification absent.
- Session counters reset when the offscreen document is recreated.
- Upstream library issues (ed25519 leniency, VRF scalar, BLS x>=p, handshake version table) are worked
  around, not fixed upstream here.
- CIP for N2N-over-WebSocket is a draft in `docs/WEBSOCKET_BEARER.md`, not a submission.

## Commit discipline

- Small commits: code + tests + docs for one behaviour; never mix unrelated refactors.
- Run `bun run typecheck` and `bun test` before committing; `bun run build` when dist/manifest changes.
- Real output only: no invented command results, screenshots or peer answers; report blockers honestly.
- Do not push or rewrite history unless asked; HarmonicLabs library work goes straight to main per user
  directive, Gerolamino commits stay local until asked.
- No secrets in commits; do not read or print `.env`/credential files unless asked.
- Keep the repo's branch name: `main` (already tracks `origin/main`; ahead commits exist, check before push).

## Pitfalls that already cost cycles

- OPFS async: reads/writes go through the worker; catches around file listing race with node writes.
- Volatile-only runs cannot pass e2e phase 1 without promotion (gates on `opfs.chunks > 0`).
- `startMode` resumed is not `mithril`: the anchor file turns it into `resume-mithril`; if you write the
  anchor at every start you lose the base and lie about the start point.
- Chunk names pad chunkNo to 5 digits, volatile names pad slot to 10; do not swap.
- The query router must skip a peer that announces capabilities without blockfrost, never fall through
  to "any peer" blindly.
- Trust rows: verified rows are cryptographic, trusted rows are peer claims; do not blur them in copy.
- GitHub: library repos get changes on main; this repo's commits stay local; never assume push.
