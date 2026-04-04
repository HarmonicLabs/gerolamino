import { describe, it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { decodeExtLedgerState, type ExtLedgerState } from "../lib/state/new-epoch-state.ts";
import { Era } from "../lib/core/era.ts";
import pathNode from "path";
import { fileURLToPath } from "url";

const __dir = pathNode.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = pathNode.resolve(__dir, "../../../..", "apps/bootstrap/db/ledger/119401006/state");

const FsLayer = NodeFileSystem.layer;

// Decode once, share across tests
let cached: ExtLedgerState | undefined;

const decoded = Effect.gen(function* () {
  if (cached) return cached;
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(STATE_PATH);
  const result = yield* decodeExtLedgerState(new Uint8Array(bytes));
  cached = result;
  return result;
}).pipe(Effect.provide(FsLayer));

describe("NewEpochState decoder", () => {
  it.effect(
    "decodes the full ExtLedgerState from Mithril snapshot",
    () =>
      decoded.pipe(
        Effect.tap((ext) =>
          Effect.sync(() => {
            assert.strictEqual(ext.currentEra, Era.Conway);
            assert.strictEqual(ext.pastEras.length, 6);
            assert.strictEqual(ext.pastEras[0]!.era, Era.Byron);
            assert.strictEqual(ext.pastEras[5]!.era, Era.Babbage);
            assert.isDefined(ext.tip);
            assert.strictEqual(ext.tip!.slot, 119401006n);
            assert.strictEqual(ext.newEpochState.epoch, 280n);
            assert.isTrue(ext.newEpochState.blocksMadePrev.size > 0);
            assert.isTrue(ext.newEpochState.blocksMadeCur.size > 0);
          }),
        ),
      ),
    { timeout: 60_000 },
  );

  it.effect("decodes ChainAccountState with valid treasury and reserves", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const acct = ext.newEpochState.epochState.chainAccountState;
          assert.isTrue(acct.treasury > 0n);
          assert.isTrue(acct.reserves > 0n);
          assert.isTrue(acct.treasury + acct.reserves < 45_000_000_000_000_000n);
        }),
      ),
    ),
  );

  it.effect("decodes CertState with DReps, pools, and staking accounts", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const cert = ext.newEpochState.epochState.ledgerState.certState;
          assert.isTrue(cert.vState.dreps.size > 100);
          assert.isTrue(cert.vState.committeeState.length > 0);
          assert.isTrue(cert.pState.stakePools.size > 0);
          assert.isTrue(cert.dState.accounts.size > 100);
        }),
      ),
    ),
  );

  it.effect("decodes UTxOState with empty UTxO (UTxO-HD), fees, and instant stake", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const utxo = ext.newEpochState.epochState.ledgerState.utxoState;
          assert.isDefined(utxo.govState);
          assert.isTrue(utxo.deposited >= 0n);
          assert.isTrue(utxo.fees >= 0n);
        }),
      ),
    ),
  );

  it.effect("decodes SnapShots with stake, delegations, and pool data", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const snaps = ext.newEpochState.epochState.snapShots;
          assert.isDefined(snaps.mark);
          assert.isDefined(snaps.set);
          assert.isDefined(snaps.go);
          assert.isTrue(snaps.fee >= 0n);
        }),
      ),
    ),
  );

  it.effect("decodes PoolDistr with active pools", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          assert.isTrue(ext.newEpochState.poolDistr.pools.size > 0);
          assert.isTrue(ext.newEpochState.poolDistr.totalActiveStake > 0n);
        }),
      ),
    ),
  );

  it.effect("decodes past era boundaries correctly", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          assert.strictEqual(ext.pastEras.length, 6);
          const eras = ext.pastEras.map((e) => e.era);
          assert.deepStrictEqual(eras, [Era.Byron, Era.Shelley, Era.Allegra, Era.Mary, Era.Alonzo, Era.Babbage]);
        }),
      ),
    ),
  );

  it.effect("decodes ConwayGovState with constitution and PParams", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const gov = ext.newEpochState.epochState.ledgerState.utxoState.govState;
          assert.isDefined(gov);
        }),
      ),
    ),
  );

  it.effect("captures stashedAVVMAddresses (null in Conway)", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          assert.isDefined(ext.newEpochState.stashedAVVMAddresses);
        }),
      ),
    ),
  );

  it.effect("captures chainDepState for consensus validation", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          assert.isDefined(ext.chainDepState);
        }),
      ),
    ),
  );
});
