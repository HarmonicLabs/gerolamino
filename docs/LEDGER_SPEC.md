# Gerolamino local ledger spec (draft v0, 2026-10-29)

Status: draft, decisions in "Open decisions" need sign-off before implementation. This closes the one gap in
Milestone 4: "Browser adaptation and light node on the browser", whose project scope also says "follow the tip
and update the local ledger state accordingly". Today Gerolamino verifies and stores blocks, but UTxO and
other ledger facts are answered by a Gerolamo peer (`source: "relay"`).

## Scope and boundaries

- **Local UTxO set.** The node maintains its own UTxO state in OPFS, updated from blocks it verified itself.
  It never takes ledger state from a peer without proof.
- **Coverage is first-class.** Every ledger answer states the slot from which its state is complete. A
  tip/chunk/Mithril start gives coverage `startSlot`; only a genesis or snapshot bootstrap gives coverage 0.
- **Light node, not consensus.** Header/body verification stays as it is. Phase-2 script execution, stake,
  governance, epoch rewards and full ledger rule validation are separate phases; a local UTxO projection
  must say so in its answers.
- **Pure TypeScript on HarmonicLabs.** Parsing uses `@harmoniclabs/cardano-ledger-ts` (pinned vendor tarball),
  storage uses the existing OPFS sink pattern; no SQLite, no LMDB, no Bun-only APIs in the extension.
- **No keys.** The ledger never signs, validates scripts, or becomes a wallet.

## Coverage model

```
ledgerCoverage = {
  network, startSlot, startHash,
  startKind: "genesis" | "snapshot" | "verified-start",
  tipSlot, tipHash, blocksApplied, utxoCount, spentOutputs, unknownInputs
}
```

- `genesis`: complete from slot 0 (only after a genesis replay or snapshot import).
- `snapshot`: complete from a Mithril-certified snapshot slot (UTxO base imported, later blocks applied).
- `verified-start`: the node started at tip/chunk/Mithril; UTxO state covers only outputs seen since that
  slot. `/addresses` answers are partial unless the caller is told the coverage.
- Rollback moves `tipSlot/tipHash` back but never moves `startSlot`; if a rollback crosses the start, the
  ledger reports the gap and rebuilds from the snapshot or stays partial.

## Data model

- `UtxoRef = txid(hex):index(u16)`. `UtxoEntry`:
  `{ ref, addressBytes, addressBech32, value: { lovelace, assets: Array<{ policyHex, nameHex, quantity }> },
    datum: null | { hash } | { inline: bytes }, scriptRef: bytes | null, stakeCredential: bytes | null,
    createdSlot, createdTxIndex, spentSlot: number | null, spentTxIndex: number | null }`.
- Spent outputs stay as tombstones in the in-memory map (needed for rollback and tx lookups); tombstones
  older than the immutable window are dropped when the snapshot is rewritten.
- In-memory indexes: `byAddress: Map<addrBytes, Set<UtxoRef>>` (spent included until pruning),
  `byTx: Map<txid, { outputs: UtxoRef[]; inputs: UtxoRef[] }>`, `stakeBalance: Map<credential, bigint>`,
  optional `byAsset` / `byDatum` later. Address bytes are the source of truth; bech32 strings are derived.
- Transaction facts: per stored tx, fee, validity interval, counts, bytes, outputs refs; the existing
  `localIndex.ts` facts get a ledger-backed UTxO view rather than a duplicate store.
- Block diff (`LedgerDiff`): `created: UtxoEntry[]`, `spent: Array<{ ref, before: UtxoEntry }>`,
  `unknownInputs: refs`, `invalidTx: number[]`, `header { slot, hash, prevHash }`, `counts`.

## Storage layout (OPFS)

```
gerolamino/<network>/ledger/
  manifest.json                         # coverage, tip, counts, format version, app version; written last
  snapshot-<slot>-<hash>.ldb            # periodic base state (compact CBOR; sorted UTxO refs + indexes)
  blocks/<10digit slot>-<hash8>.ldiff   # per verified block: created/spent diff, exact
```

- The single writer is BrowserNode; the OPFS worker handles async reads/writes.
- Commit order: write the block diff, then the manifest, then (optionally) fsync. A torn diff reads as absent.
- Resume: read manifest, load newest snapshot <= tip, replay diffs newer than it up to tip. Diffs older
  than the latest snapshot are pruned after the snapshot writes successfully.
- Rollback within the volatile window: delete the undone diffs (newest first), apply their `spent`/`created`
  reverse in memory, write manifest. No snapshot rewrite for rollback inside k.
- Compaction: at each chunk promotion boundary, write a snapshot at `slot - k` and prune diffs older than it;
  keep the last k diffs for rollback.
- Limits: cap diff bytes per block (e.g. 8 MiB preview), cap snapshot bytes (UTxO set size), fail the
  ledger (not the chain store) when a write fails; a failed ledger never destroys verified blocks.

## Bootstrapping

| Mode | Coverage | How | When |
|---|---|---|---|
| `verified-start` | start slot | first block at tip/chunk/Mithril | always works, partial answers |
| `snapshot` | snapshot slot | Mithril ancillary `ledger/<slot>/tables` (MemPack decoder, sorted entries) | opt-in; preview tables ~650 MB |
| `genesis` | 0 | apply every block from genesis (Byron payloads included) | slow, future |

Snapshot import steps: verify a Mithril-certified anchor (existing `mithrilAnchor`), download the ancillary
`tables` file (aggregator or Gerolamo peer), verify its manifest signature and Merkle root, stream-decode
entries with the MemPack decoder (`utxohd` codec v1), write the base snapshot under the ledger dir, then
apply blocks from the snapshot slot onward. A peer may serve the tables bytes; a bad byte range must fail the
Merkle check, never silently drop entries.

## Block application (P0 UTxO projection)

Input: a verified block's bytes, slot, hash and `invalidTransactions` flags (body parser).
Per transaction, in block order:

1. If marked phase-2 invalid: spend only its collateral inputs; create no outputs; record `invalidTx`.
2. Otherwise: spend regular inputs; add outputs (all eras that have Babbage-shaped outputs); reference
   inputs are never spent by ordinary inputs, collateral inputs are spent only on failure.
3. Same-block spends are allowed in the order transactions appear; an input not in the local UTxO is
   recorded in `unknownInputs` and does not remove anything (coverage gap, not a block failure).
4. Update address/stake indexes and balances; keep tombstones for spent outputs.
5. Compute block counters and the UTxO digest (blake2b-256 over sorted `ref -> bytes`), store diff and manifest.

What P0 does **not** do: phase-2 script execution, fee/deposit/balance checks, stake delegation effects,
governance, epoch rewards, Byron payload-ledger effects. These are P2/P3 work; queries must state it.

Rollback: reverse a block diff in memory (unspend, delete created, restore balances/counters) and delete its
diff file. A deeper rollback than the retained diffs rebuilds from the newest snapshot then replays.

Failures: an undecodable body halts the ledger at that block, marks `ledgerStale`, keeps the chain store;
retry on the next resume. Never write a partial diff for a block whose outputs were not fully decoded.

## Query contract

| Query | Local answer | Notes |
|---|---|---|
| `/txs/{hash}/utxos` | outputs of a stored tx | complete for that tx regardless of coverage |
| `/txs/{hash}` | existing tx facts + output refs | local, as today |
| `/utxo/{txhash:index}` | UtxoEntry JSON if unspent | Gerolamo-style extension, no ledger needed |
| `/addresses/{addr}/utxos` | only when coverage is complete for the address | partial coverage answers must carry coverage metadata or relay |
| `/accounts/{stake}` | only with stake balances and complete coverage | P1/P2 |
| `/epochs/latest/parameters` | relay | not ledger state |

Answer shape stays Blockfrost-shaped. Coverage travels in the dApp envelope:
`query()` returns `{ status, body, source: "local" | "relay", peer?, proof?, ledger?: { startSlot, startKind, tipSlot } }`.
`source: "local"` is used only for answers the local ledger can fully justify; otherwise relay with `peer`.
The Trust card gets a ledger row: coverage, UTxO count, digest, stale/unknown inputs; no "verified" tone
unless coverage is complete and the digest matches.

## Trust and consistency rules

- Ledger state derives only from blocks this node verified; no peer-supplied UTxO entries enter the store.
- The UTxO digest is recomputed after every applied block; a resume/diff mismatch marks the ledger stale and
  requires a rebuild from the snapshot.
- A local answer's `source` cannot be `"local"` when `unknownInputs > 0` affects that answer's address/tx.
- Snapshot bootstrap is "certified by Mithril" only after the existing anchor/certificate/Merkle checks;
  the ancillary file's own signature is verified separately (it is not the multi-signature).
- Never claim full consensus validation, full address history, or UTxO from genesis unless coverage says so.

## Acceptance tests

Unit (`bun test`, no browser):
- parse a real preview block fixture, apply its UTxO diff, assert addresses/values/spends;
- rollback block N restores the exact before state;
- OPFS resume: snapshot + diffs replay equals memory; torn diff reads as absent;
- invalid tx collateral rule; same-block spend; unknown input recorded;
- digest stable for a known fixture; corrupt diff fails closed.

Live (Brave e2e, Gerolamo preview relay):
- start chunk; wait for ledger `utxoCount > 0`; query a stored tx `/txs/{hash}/utxos` via the extension dApp
  and get `source: "local"`; kill/recreate offscreen and confirm resume replays the ledger;
- force a rollback and confirm spent/created counters return to the prior values;
- parity window: compare UTxO refs/count for a slot range against the Gerolamo peer's `/api/v0` UTxO answers;
- screenshot/log evidence stored under the profile scratch, not committed.

Milestone 4 evidence: dist extension + e2e PASS + local UTxO `source: "local"` proof + coverage statement.

## Phases

| Phase | Work | Coverage |
|---|---|---|
| P0 | UTxO projection, diff log, resume/rollback, tx-scoped local answers | verified-start |
| P1 | Mithril `tables` snapshot import + MemPack decoder + compaction | snapshot |
| P2 | full ledger rules: fees/deposits, stake, governance, epoch rewards | snapshot/genesis |
| P3 | optional consensus validation parity (phase-2 scripts), proofs for local answers | full |

Milestone 4 closes on P0 evidence for the stated deliverable (browser extension + local ledger update), with
P1 as the next hardening step; do not claim genesis-complete address history before P1.

## Open decisions

1. Milestone wording: is `verified-start` coverage enough to close "update the local ledger state", or do we
   hold the milestone until P1 snapshot coverage? (Recommendation: close with P0 + explicit coverage.)
2. Snapshot source for P1: Mithril aggregator direct, Gerolamo peer `tables` stream, or both with peer first.
3. Memory budget: full preview UTxO map in memory (about 3.2 M entries) vs chunked index reads from OPFS;
   set a measured cap before P1.
4. Failed transaction rule: exclude outputs of phase-2 invalid txs (requires the body's invalid list) or
   include them as "unvalidated" projection? (Recommendation: exclude, mark invalidTx.)
5. Local address answers under partial coverage: relay by default, or return partial bodies with an explicit
   `ledger.startSlot` marker? (Recommendation: relay unless complete.)

## Dependencies

- Add `@harmoniclabs/cardano-ledger-ts` (Gerolamo pins `vendor/harmoniclabs-cardano-ledger-ts-0.6.0.tgz`).
- Existing OPFS sink/worker, chunk writer, volatile store, Mithril anchor/verifier and light query stay as-is.
- No new runtime dependency beyond HarmonicLabs packages; build gate stays on.
