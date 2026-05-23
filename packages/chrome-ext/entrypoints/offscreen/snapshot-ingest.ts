/**
 * OPFS-side counterpart to `packages/bootstrap/src/snapshot.ts` —
 * reads Mithril V2LSM ledger-state CBOR via Effect `FileSystem` and seeds
 * consensus `LedgerView` + `Nonces` + tip.
 */
import { Effect, HashMap, Schema } from "effect";
import { extractLedgerView, extractNonces, extractSnapshotTip, Nonces } from "consensus";
import { appendSessionLogLine } from "../shared/test-log-buffer.ts";
import type { LedgerView } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { readLatestLedgerStateBytes } from "../../src/opfs/ledger-ingest.ts";

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

/**
 * Read + decode ledger state from OPFS. Yields `undefined` when no
 * `ledger/<slot>/state` exists (genesis mode).
 */
export const readLedgerStateFromOpfs: Effect.Effect<
  IngestResult | undefined,
  OpfsSnapshotReadError | unknown,
  import("consensus").SlotClock | import("effect/FileSystem").FileSystem
> = Effect.gen(function* () {
  const bytes = yield* readLatestLedgerStateBytes.pipe(
    Effect.mapError(
      (err) =>
        new OpfsSnapshotReadError({
          message: "OPFS ledger-state read failed",
          cause: err,
        }),
    ),
  );
  if (bytes === undefined) {
    appendSessionLogLine("[offscreen-ingest] No OPFS ledger-state found — genesis mode");
    yield* Effect.logInfo("[offscreen-ingest] No OPFS ledger-state found — genesis mode");
    return undefined;
  }
  appendSessionLogLine(`[offscreen-ingest] OPFS ledger-state: ${bytes.length} bytes — decoding`);
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
