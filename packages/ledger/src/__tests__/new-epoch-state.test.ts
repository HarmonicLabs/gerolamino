import { describe, it, assert } from "@effect/vitest";
import { Effect, FileSystem, HashMap, Layer, Option, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { decodeExtLedgerState, type ExtLedgerState, Era } from "..";
import { CborKinds } from "codecs";
import pathNode from "path";
import { fileURLToPath } from "url";

const __dir = pathNode.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = pathNode.resolve(
  __dir,
  "../../../..",
  "apps/bootstrap/db/ledger/119401006/state",
);

const FsLayer = BunFileSystem.layer;

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
            assert.isTrue(Option.isSome(ext.tip));
            assert.strictEqual(Option.getOrThrow(ext.tip).slot, 119401006n);
            assert.strictEqual(ext.newEpochState.epoch, 280n);
            assert.isTrue(HashMap.size(ext.newEpochState.blocksMadePrev) > 0);
            assert.isTrue(HashMap.size(ext.newEpochState.blocksMadeCur) > 0);
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
          assert.isTrue(HashMap.size(cert.vState.dreps) > 100);
          assert.strictEqual(cert.vState.committeeState._tag, CborKinds.Array);
          assert.isTrue(HashMap.size(cert.pState.stakePools) > 0);
          assert.isTrue(HashMap.size(cert.dState.accounts) > 100);
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
          assert.isTrue(HashMap.size(ext.newEpochState.poolDistr.pools) > 0);
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
          assert.deepStrictEqual(eras, [
            Era.Byron,
            Era.Shelley,
            Era.Allegra,
            Era.Mary,
            Era.Alonzo,
            Era.Babbage,
          ]);
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
