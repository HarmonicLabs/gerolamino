import { describe, it, assert } from "@effect/vitest";
import { Effect } from "effect";
import { decodeExtLedgerState, type ExtLedgerState } from "../lib/new-epoch-state.ts";
import { Era } from "../lib/era.ts";

const STATE_PATH = "packages/bootstrap/db/ledger/119401006/state";

// Decode once, share across tests
let cached: ExtLedgerState | undefined;

const decoded = Effect.gen(function* () {
  if (cached) return cached;
  const bytes = yield* Effect.tryPromise(() => Bun.file(STATE_PATH).bytes());
  const result = yield* decodeExtLedgerState(bytes);
  cached = result;
  return result;
});

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
          assert.isTrue(cert.pState.stakePools.size > 400);
          const firstPool = [...cert.pState.stakePools.values()][0]!;
          assert.strictEqual(firstPool.vrfKeyHash.length, 32);
          assert.isTrue(firstPool.pledge > 0n);
          assert.isTrue(cert.dState.accounts.size > 30000);
        }),
      ),
    ),
  );

  it.effect("decodes UTxOState with empty UTxO (UTxO-HD), fees, and instant stake", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const utxo = ext.newEpochState.epochState.ledgerState.utxoState;
          assert.isTrue(utxo.deposited > 0n);
          assert.isTrue(utxo.fees > 0n);
          assert.isTrue(utxo.instantStake.size > 500000);
          assert.strictEqual(utxo.donation, 0n);
        }),
      ),
    ),
  );

  it.effect("decodes SnapShots with stake, delegations, and pool data", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const snaps = ext.newEpochState.epochState.snapShots;
          assert.isTrue(snaps.mark.stake.size > 20000);
          assert.isTrue(snaps.mark.delegations.size > 20000);
          assert.isTrue(snaps.mark.poolParams.size > 400);
          assert.isTrue(snaps.set.stake.size > 20000);
          assert.isTrue(snaps.go.stake.size > 20000);
          assert.isTrue(snaps.fee > 0n);
        }),
      ),
    ),
  );

  it.effect("decodes PoolDistr with active pools", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const pd = ext.newEpochState.poolDistr;
          assert.isTrue(pd.pools.size > 400);
          assert.isTrue(pd.totalActiveStake > 0n);
          const firstPool = [...pd.pools.values()][0]!;
          assert.isTrue(firstPool.stakeRatio.numerator > 0n);
          assert.strictEqual(firstPool.vrfKeyHash.length, 32);
        }),
      ),
    ),
  );

  it.effect("decodes past era boundaries correctly", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          assert.strictEqual(ext.pastEras[0]!.start.slot, 0n);
          assert.strictEqual(ext.pastEras[0]!.start.epoch, 0n);
          for (let i = 0; i < ext.pastEras.length - 1; i++) {
            assert.strictEqual(ext.pastEras[i]!.end.slot, ext.pastEras[i + 1]!.start.slot);
          }
          const lastPast = ext.pastEras[ext.pastEras.length - 1]!;
          assert.strictEqual(lastPast.end.slot, ext.currentStart.slot);
        }),
      ),
    ),
  );

  it.effect("decodes ConwayGovState with constitution and PParams", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const gov = ext.newEpochState.epochState.ledgerState.utxoState.govState;
          assert.isDefined(gov.constitution.anchor.url);
          assert.strictEqual(gov.constitution.anchor.hash.length, 32);
          assert.isDefined(gov.constitution.scriptHash);
          // PParams stored as CBOR arrays
          assert.isDefined(gov.currentPParams);
          assert.isDefined(gov.previousPParams);
        }),
      ),
    ),
  );

  it.effect("captures stashedAVVMAddresses (null in Conway)", () =>
    decoded.pipe(
      Effect.tap((ext) =>
        Effect.sync(() => {
          const stashed = ext.newEpochState.stashedAVVMAddresses;
          assert.isDefined(stashed);
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
