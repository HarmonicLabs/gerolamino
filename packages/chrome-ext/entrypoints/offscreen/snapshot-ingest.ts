/**
 * OPFS-side counterpart to `packages/bootstrap/src/snapshot.ts` —
 * walks the OPFS directory the popup populated via drag-drop, reads
 * the Mithril V2LSM ledger-state CBOR, and seeds the consensus
 * `LedgerView` + `Nonces` + tip.
 *
 * Mirrors the apps/tui `loadSnapshotState` shape so both hosts decode
 * an identical ExtLedgerState through `ledger.decodeExtLedgerState` +
 * `consensus.{extractLedgerView, extractNonces, extractSnapshotTip}`.
 * The only difference is the IO boundary: the TUI uses Effect's
 * `FileSystem`; this module uses the async File System Access API on
 * the offscreen window context (NOT `FileSystemSyncAccessHandle`,
 * which is dedicated-Worker-only).
 *
 * Returns `{ ledgerView, snapshotState }` for the bootstrap-sync
 * pipeline to feed into `initialVolatileState`. Returns `undefined`
 * when OPFS is empty (genesis-mode startup) so the pipeline can
 * cleanly fall back without an error.
 */
import { Effect, HashMap, Schema } from "effect";
import { extractLedgerView, extractNonces, extractSnapshotTip, Nonces } from "consensus";
import type { LedgerView } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { SLOT_DIR_RE } from "bootstrap";

export type SnapshotState = {
  tip: { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined;
  nonces: Nonces;
};

export type IngestResult = {
  ledgerView: LedgerView;
  snapshotState: SnapshotState;
};

export class OpfsSnapshotReadError extends Schema.TaggedErrorClass<OpfsSnapshotReadError>()(
  "OpfsSnapshotReadError",
  { message: Schema.String, cause: Schema.Defect },
) {}

/** Walk OPFS root for a `ledger/<slot>/state` file. Picks the
 *  numerically-largest slot directory (the tip-most snapshot) when
 *  multiple are present — Mithril snapshots converted from a running
 *  cardano-node typically ship two adjacent slots. */
const findLatestLedgerStateBytes = (
  root: FileSystemDirectoryHandle,
): Effect.Effect<Uint8Array | undefined, OpfsSnapshotReadError> =>
  Effect.tryPromise({
    try: async () => {
      // Step 1: top-level `ledger/`. Missing → genesis path.
      let ledger: FileSystemDirectoryHandle;
      try {
        ledger = await root.getDirectoryHandle("ledger");
      } catch {
        return undefined;
      }
      // Step 2: enumerate slot subdirectories. `SLOT_DIR_RE` matches
      // both plain-digit (native cardano-node V2LSM dump) and `_lsm`
      // suffixed (Mithril-converted) entries.
      const slots: Array<{ name: string; slot: bigint }> = [];
      for await (const [name, child] of ledger.entries()) {
        if (child.kind !== "directory") continue;
        const m = SLOT_DIR_RE.exec(name);
        if (m === null || m[1] === undefined) continue;
        slots.push({ name, slot: BigInt(m[1]) });
      }
      if (slots.length === 0) return undefined;
      // Pick the tip-most slot (Cardano slots are monotonic).
      slots.sort((a, b) => (b.slot > a.slot ? 1 : b.slot < a.slot ? -1 : 0));
      const primary = slots[0]!;
      const slotDir = await ledger.getDirectoryHandle(primary.name);
      const stateFile = await slotDir.getFileHandle("state");
      const file = await stateFile.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    catch: (err) =>
      new OpfsSnapshotReadError({
        message: "OPFS ledger-state read failed",
        cause: err,
      }),
  });

/**
 * Read + decode the ledger state from OPFS, returning a seeded
 * `LedgerView` / `Nonces` / tip. Yields `undefined` when the OPFS
 * tree doesn't contain a `ledger/<slot>/state` file (first-boot or
 * genesis mode).
 *
 * Requires `SlotClock` because `extractLedgerView` reads
 * `activeSlotsCoeff` from the configured network parameters.
 */
export const readLedgerStateFromOpfs: Effect.Effect<
  IngestResult | undefined,
  OpfsSnapshotReadError | unknown,
  import("consensus").SlotClock
> = Effect.gen(function* () {
  const root: FileSystemDirectoryHandle = yield* Effect.tryPromise({
    try: () => navigator.storage.getDirectory(),
    catch: (err) =>
      new OpfsSnapshotReadError({
        message: "OPFS root unavailable",
        cause: err,
      }),
  });
  const bytes = yield* findLatestLedgerStateBytes(root);
  if (bytes === undefined) {
    yield* Effect.logInfo("[offscreen-ingest] No OPFS ledger-state found — genesis mode");
    return undefined;
  }
  yield* Effect.logInfo(
    `[offscreen-ingest] OPFS ledger-state: ${bytes.length} bytes — decoding`,
  );
  const extState = yield* decodeExtLedgerState(bytes);
  yield* Effect.logInfo(
    `[offscreen-ingest] Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
      `${HashMap.size(extState.newEpochState.poolDistr.pools)} pools`,
  );
  const ledgerView = yield* extractLedgerView(extState);
  const nonces = extractNonces(extState);
  const tip = extractSnapshotTip(extState);
  yield* Effect.logInfo(
    `[offscreen-ingest] Seeded: tip ${tip?.slot ?? "origin"}, totalStake ${ledgerView.totalStake}, ` +
      `${HashMap.size(ledgerView.poolVrfKeys)} VRF keys`,
  );
  return { ledgerView, snapshotState: { tip, nonces } };
});
