# Gerolamino local ledger (implemented P0, 2026-10-29)

Status: P0 implemented and proven; P1 snapshot import and local compaction implemented 2026-10-30 (local files, streaming decoder, signed ancillary manifest check, full preview count 3,169,305 entries). The aggregator download/UI is the remaining P1 wiring. This closes the local ledger part of
Milestone 4 ("Browser adaptation and light node on the browser"): Gerolamino verifies and stores blocks, and now
maintains its own UTxO projection in OPFS instead of taking UTxO from a Gerolamo peer.

## Scope and boundaries

- **Local UTxO set.** The node maintains its own UTxO state in OPFS, updated from blocks it verified itself.
  It never takes ledger state from a peer without proof.
- **Coverage is first-class.** Every local ledger answer states the slot from which its state is complete. A
  tip/chunk/Mithril start gives coverage `startSlot`; only a genesis or snapshot bootstrap gives coverage 0.
- **Light node, not consensus.** Header/body verification stays as it is. Phase-2 script execution, stake,
  governance, epoch rewards and full ledger rule validation are P2/P3; the UTxO projection says so.
- **Pure TypeScript on HarmonicLabs.** Parsing uses `@harmoniclabs/cardano-ledger-ts` (pinned vendor tarball),
  storage uses the existing OPFS sink pattern; no SQLite, no LMDB, no Bun-only APIs in the extension.
- **No keys.** The ledger never signs, validates scripts, or becomes a wallet.

## Coverage model (implemented shape)

```ts
interface LedgerCoverage {
  network: string;
  startSlot: number | null;              // first verified block applied; null before any block
  kind: "verified-start" | "snapshot" | "genesis"; // P0 always "verified-start"
  tipSlot: number | null;
  blocks: number;
  utxoCount: number;                     // unspent only
  digest: string | null;                 // blake2b-256 chain of per-block diffs
  stale: boolean;                        // a gap or a failed digest/write
}
```

- `genesis`: complete from slot 0 (only after a genesis replay or snapshot import).
- `snapshot`: complete from a Mithril-certified snapshot slot (UTxO base imported, later blocks applied).
- `verified-start`: the node started at tip/chunk/Mithril; UTxO state covers only outputs seen since that slot.
  `/addresses` answers relay unless coverage starts at 0 or the base is a snapshot.
- A rollback moves `tipSlot` back but never moves `startSlot`; if a rollback crosses the start, the ledger
  reports the gap (stale or partial) and does not pretend completeness.

## Data model

- `UtxoRef = txid(hex):index(u16)`. `LedgerOut`:
  `{ ref, txHash, address, addressBytes, lovelace, assets: Array<{ policy, name, quantity }>, datumHash?,
    inlineDatum?, scriptRefHash?, stakeKey?, createdSlot, spentSlot: number | null }`.
- Spent outputs stay as tombstones in memory (needed for rollback and tx lookups); local compaction keeps them in the base snapshot, so a snapshot base remains query-compatible.
- In-memory indexes: `utxos: Map<ref, LedgerOut>` (spent included), `byAddress: Map<address, Set<ref>>`,
  `byTx: Map<txHash, { out: ref[]; input: ref[] }>`, `stakeBalance: Map<credential, bigint>` (kept, not yet
  queried). The address is the bech32 string produced by ledger-ts; raw address bytes are kept for stake keys.
- Transaction facts stay in `localIndex.ts`; the ledger adds UTxO views rather than duplicating block facts.
- Block diff (`LedgerBlockDiff`): `format: 1, slot, hash, txs, invalidTx: number[], created: LedgerOut[],
  spent: ref[]`; per stored diff also `prevDigest`, `digest`, `unknownInputs` (the compiler records unknown
  inputs there).

## Storage layout (OPFS, implemented)

```text
gerolamino/<network>/ledger/
  manifest.json                       # coverage, tip, counters, digest chain, format 1, written last
  snapshot.json                       # P1 base at a slot: UTxO rows + spent tombstones + counters (optional)
  b-<10-digit slot>-<hash8>.ldiff     # one verified block newer than the base: created/spent diff + digest chain
```

- `snapshot.json` is the base under the per-block diff log. It carries `format`, `network`, original `startSlot`, coverage `kind`, `slot`, chain `digest`, state `stateDigest`, cumulative counters and `historyComplete` (`true` for local compaction, `false` for a Mithril `tables` import). Resume reads it once and replays only diffs newer than its slot.

- File name: `b-${slot.padStart(10)}-${hash.slice(0,8)}.ldiff` (flat directory, no `blocks/` subdir).
- The single writer is BrowserNode through the OPFS worker; `manifest.json` is written after each diff.
- Resume: read the manifest, then replay every diff in slot order, checking `prevDigest` continuity; a missing
  diff, a missing manifest with diffs present, a corrupt diff, a tip mismatch or a digest mismatch marks the
  ledger stale rather than failing half a block. The ledger loads what it can and refuses local answers while
  stale.
- Rollback within the volatile window: reverse diffs newer than the target slot in bulk (spent outputs become
  unspent again, created outputs leave, counters rebuild), delete their files, rewrite the manifest. Local
  compaction treats the snapshot slot as a base; rolling back below it marks the ledger stale and keeps the
  snapshot state (a deeper rebuild is future work).
- Compaction (`compactTo(slot)`): write the UTxO state at `slot` as `snapshot.json` (spent tombstones included,
  original `startSlot` kept), drop every diff file at or below `slot`, then re-apply the newer diffs on top of
  the base. A rollback below the snapshot slot never pretends to reconstruct the missing history.
- A write failure reverts the in-memory diff, removes the file and throws; BrowserNode catches it, marks the
  ledger stale and keeps the verified chain store intact. A decode failure likewise marks stale, never drops a
  chain block.
- Wipe (`wipe-store`) removes immutable, volatile and ledger together; the next start rebuilds coverage from
  the first verified block.

## Bootstrapping

| Mode | Coverage | How | When |
|---|---|---|---|
| `verified-start` | first verified slot | first block at tip/chunk/Mithril | always works, partial answers |
| `snapshot` | snapshot slot | Mithril ancillary `ledger/<slot>/tables` (MemPack decoder, sorted entries) | P1, opt-in; preview tables about 650 MB |
| `genesis` | 0 | apply every block from genesis (Byron payloads included) | slow, P2 |

Snapshot import (P1, implemented for local files): verify the signed `ancillary_manifest.json` (Gerolamino's 64-bit SHA-256 of
`tables`/`meta`, network ancillary Ed25519 key), stream-decode entries with the MemPack decoder, build the
UTxO-only base snapshot (`historyComplete: false`), install it under the ledger dir, then apply blocks from the
snapshot slot onward. The aggregator/peer download and the UI switch are the remaining P1 wiring. A tampered
manifest or table fails before any ledger state is written.

## Block application (P0 UTxO projection, implemented)

Input: a verified block's bytes, slot, hash and `invalidTransactions` flags (body parser).
Per transaction, in block order:

1. If marked phase-2 invalid: spend only its collateral inputs; create no ordinary outputs; record the tx
   index in `invalidTx`; a collateral return is created at index `outputs.length` (same rule as Gerolamo).
2. Otherwise: spend regular inputs; add outputs (all eras that have Babbage-shaped outputs); reference inputs
   are not spent by ordinary inputs.
3. Same-block spends are allowed in the order transactions appear; an input not in the local UTxO is recorded
   in that block's `unknownInputs` and removes nothing (coverage gap, not a block failure).
4. Update address/stake indexes and balances; keep tombstones for spent outputs.
5. Compute the diff digest: `blake2b-256(prevDigestBytes ‖ JSON({slot, hash, created refs, spent, unknown,
   invalid}))`; store the diff, then the manifest.

What P0 does **not** do: phase-2 script execution, fee/deposit/balance checks, stake delegation effects,
governance, epoch rewards, Byron payload-ledger effects. These are P2/P3 work; queries must state it.

Rollback: reverse a block diff in memory (unspend, delete created, restore balances/counters) and delete its
diff file. A deeper rollback than the retained diffs rebuilds from the newest snapshot (P1).

Failures: an undecodable body marks the ledger stale at that block (the chain store keeps going; later diffs can
still append, but local UTxO answers relay until a rebuild). A result it could not decode is never written as a
partial diff.

## Query contract (implemented)

| Query | Local answer | Notes |
|---|---|---|
| `/txs/{hash}/utxos` | outputs of a stored tx | only when the ledger covers the tx's slot and history is complete; a snapshot with `historyComplete: false` relays |
| `/txs/{hash}` | existing tx facts + output refs | local, as before, not ledger-dependent |
| `/utxo/{txhash:index}` | Blockfrost-shaped UTxO if unspent | only from the local ledger; spent/unknown relays |
| `/addresses/{addr}/utxos` | only when coverage is complete (start 0) or the base is a snapshot | partial verified-start coverage relays by default |
| `/accounts/{stake}` | only with stake balances and complete coverage | P1/P2 |
| `/epochs/latest/parameters` | relay | not ledger state |

Answer shape stays Blockfrost-shaped. Coverage travels in the dApp envelope:
`query()` returns `{ status, body, source: "local" | "relay", peer?, proof?, ledger?: { startSlot, kind, tipSlot } }`.
`source: "local"` is used only for answers the local ledger can fully justify and is not stale; otherwise the
peer answers. The popup Status card shows ledger blocks, UTxO count and coverage slot; the Trust card gets a
"Local UTxO" row (verified only for coverage 0; partial coverage is trusted, stale is a warning).

## Trust and consistency rules

- Ledger state derives only from blocks this node verified; no peer-supplied UTxO entries enter the store.
- The digest chain is recomputed after every applied block; a resume/diff mismatch marks the ledger stale and
  local answers stop until a rebuild.
- Unknown inputs are recorded per block and shown in stats; partial coverage answers carry coverage metadata
  and never claim genesis completeness.
- Snapshot bootstrap is "certified by Mithril" only after the existing anchor/certificate/Merkle checks; the
  ancillary file's own signature is verified separately.
- Never claim full consensus validation, full address history, or UTxO from genesis unless coverage says so.

## Acceptance tests (implemented)

Unit (`bun test`, no browser):
- parse real preview block fixtures and apply their UTxO diff; addresses/values/spends are consistent (the
  lovelace value is not duplicated as an empty-policy asset);
- tx outputs and `/utxo` answers carry `{ startSlot, kind, tipSlot }`; a stale ledger does not answer locally;
- rollback restores spent outputs and removes created ones; resume agrees; corrupt/tampered diffs and torn
  manifests go stale; digest chain continuity is checked; repeated block idempotence and a same-slot branch
  replacement are tested;
- memory-only ledger (no sink) still answers; unknown input is recorded; `markStale` persists.
- P1 (`test/ledgerSnapshot.test.ts`): signed ancillary manifest verifies `tables`/`meta` SHA-256 with Gerolamino's
  64-bit SHA-256 (`src/node/sha256.ts`, tested against FIPS 180-4 vectors); a tampered
  table fails; stream and whole-file scanners agree across chunk boundaries; snapshot install/resume keeps
  `historyComplete: false`; compacted bases keep tombstones and drop older diffs; rollback across a compacted
  base stays query-safe; state digest detects tampering.
- Smoke scripts: `scripts/ledger-smoke.ts` (local block ledger); `scripts/mithril-tables-smoke.ts` (P1 import, 20,000 real preview rows decoded with 0 errors; full `--count-only` count 3,169,305 entries)
  from local `tables`/`meta`, optional signed manifest, snapshot install and local/relay query checks).

Live (Brave e2e, Gerolamo preview relay):
- start chunk; wait for ledger blocks, UTxOs and coverage; query a stored transaction `/txs/{hash}/utxos` via
  the extension and get `source: "local"` plus coverage; query `/utxo/{ref}` locally;
- kill/recreate the offscreen document and confirm the ledger resumes from its diff files without stale state;
- screenshot/log evidence stored under the profile scratch, not committed.

2026-10-29 e2e evidence (Brave, `--start chunk --relay ws://192.168.1.173:3004/n2n`): first phase 26 ledger
blocks, 41 created, 32 spent, 33 UTxO, coverage start 126614888; resume 38 ledger blocks after reopen, digest
`7efbc563...`; `/txs/26da193d.../utxos` local with coverage tip 126615857; `/utxo/26da193d...:0` local; PASS.

## Phases

| Phase | Work | Coverage |
|---|---|---|
| P0 | UTxO projection, diff log, resume/rollback, tx-scoped local answers | verified-start |
| P1 | Mithril `tables` snapshot import + MemPack decoder + compaction | snapshot | implemented for local files; aggregator/UI wiring next |
| P2 | full ledger rules: fees/deposits, stake, governance, epoch rewards | snapshot/genesis |
| P3 | optional consensus validation parity (phase-2 scripts), proofs for local answers | full |

Milestone 4 closes on P0 evidence for the stated deliverable (browser extension + local ledger update), with
P1 core import/compaction implemented and P2 as the next hardening step; do not claim genesis-complete address
history before a snapshot base is installed and blocks after it are applied.

## Decisions resolved

1. Milestone wording: `verified-start` coverage plus explicit coverage metadata closes "update the local
   ledger state"; the reviewer sees local UTxO answers and their start slot.
2. Snapshot source for P1: local files implemented with signed ancillary manifest verification; peer-first `tables` stream and aggregator fallback still recommended for the browser start mode.
3. Memory budget: P0 keeps the full map in memory; the full preview scan uses ~4.2 GiB RSS with the `scanMithrilTables` row array, so plan streaming rows for the browser import.
4. Failed transaction rule: exclude ordinary outputs of phase-2 invalid txs, collateral only; implemented.
5. Local address answers under partial coverage: relay by default, genesis/snapshot coverage answers locally;
   implemented.

## Dependencies

- `@harmoniclabs/cardano-ledger-ts` 0.6.0 vendored as `vendor/harmoniclabs-cardano-ledger-ts-0.6.0.tgz`;
  it is built against HarmonicLabs cbor/plutus-data/uplc 2.x, so keep its nested `node_modules/@harmoniclabs`
  copies next to the package (Gerolamino's own code stays on cbor 1.6.6 / plutus-data 1.2.6). Its `@noble/*`
  transitive crypto code is allowed in the browser bundle (build gate extended for ledger-ts).
- Existing OPFS sink/worker, chunk writer, volatile store, Mithril anchor/verifier and light query stay as-is.
