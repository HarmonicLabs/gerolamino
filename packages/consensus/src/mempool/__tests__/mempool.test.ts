import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { ChainEventsLive } from "../../chain/event-log.ts";
import {
  CONWAY_PREDICATE_TOTAL,
  GOV_PREDICATE_COUNT,
  UTXOW_PREDICATE_COUNT,
  UTXOS_PREDICATE_COUNT,
  UTXO_PREDICATE_COUNT,
  Mempool,
} from "..";

const MempoolLayers = Mempool.Live.pipe(
  Layer.provide(KeyValueStore.layerMemory),
  Layer.provide(ChainEventsLive),
);

describe("mempool — Conway predicate surface", () => {
  it("counts match wave-2 Haskell-verified values", () => {
    expect(UTXOW_PREDICATE_COUNT).toBe(19);
    expect(UTXO_PREDICATE_COUNT).toBe(23);
    expect(UTXOS_PREDICATE_COUNT).toBe(2);
    expect(GOV_PREDICATE_COUNT).toBe(19);
    expect(CONWAY_PREDICATE_TOTAL).toBe(63);
  });
});

describe("Mempool — submit / snapshot / removeByHash / onReorg", () => {
  const mkTxId = (first: number): Uint8Array => {
    const id = new Uint8Array(32);
    id[0] = first;
    return id;
  };

  const mkTxCbor = (size: number): Uint8Array => {
    return new Uint8Array(size).fill(0x42);
  };

  it.effect("submit + snapshot returns the tx in fee-desc order", () =>
    Effect.gen(function* () {
      const mempool = yield* Mempool;
      const r1 = yield* mempool.submit(mkTxId(1), mkTxCbor(100), 500n, 0.5);
      const r2 = yield* mempool.submit(mkTxId(2), mkTxCbor(80), 501n, 1.2);
      const r3 = yield* mempool.submit(mkTxId(3), mkTxCbor(120), 502n, 0.8);
      expect(r1._tag).toBe("Accepted");
      expect(r2._tag).toBe("Accepted");
      expect(r3._tag).toBe("Accepted");
      const snap = yield* mempool.snapshot;
      expect(snap.length).toBe(3);
      // Highest fee-per-byte first
      expect(snap[0]!.feePerByte).toBe(1.2);
      expect(snap[1]!.feePerByte).toBe(0.8);
      expect(snap[2]!.feePerByte).toBe(0.5);
    }).pipe(Effect.provide(MempoolLayers)),
  );

  it.effect("duplicate submit returns AlreadyPresent", () =>
    Effect.gen(function* () {
      const mempool = yield* Mempool;
      const id = mkTxId(7);
      const first = yield* mempool.submit(id, mkTxCbor(60), 1n, 0.5);
      const second = yield* mempool.submit(id, mkTxCbor(60), 2n, 0.7);
      expect(first._tag).toBe("Accepted");
      expect(second._tag).toBe("AlreadyPresent");
      const size = yield* mempool.size;
      expect(size).toBe(1);
    }).pipe(Effect.provide(MempoolLayers)),
  );

  it.effect("synthetic rejection fires for txId starting with 0xff", () =>
    Effect.gen(function* () {
      const mempool = yield* Mempool;
      const result = yield* mempool.submit(mkTxId(0xff), mkTxCbor(40), 1n, 0.5);
      expect(result._tag).toBe("Rejected");
      const size = yield* mempool.size;
      expect(size).toBe(0);
    }).pipe(Effect.provide(MempoolLayers)),
  );

  it.effect("removeByHash drops the entry", () =>
    Effect.gen(function* () {
      const mempool = yield* Mempool;
      const id = mkTxId(5);
      yield* mempool.submit(id, mkTxCbor(50), 1n, 0.5);
      yield* mempool.removeByHash(id);
      const size = yield* mempool.size;
      expect(size).toBe(0);
    }).pipe(Effect.provide(MempoolLayers)),
  );

  it.effect("onReorg evicts the specified txIds", () =>
    Effect.gen(function* () {
      const mempool = yield* Mempool;
      yield* mempool.submit(mkTxId(1), mkTxCbor(50), 1n, 0.5);
      yield* mempool.submit(mkTxId(2), mkTxCbor(50), 1n, 0.5);
      yield* mempool.submit(mkTxId(3), mkTxCbor(50), 1n, 0.5);
      yield* mempool.onReorg([mkTxId(1), mkTxId(3)]);
      const size = yield* mempool.size;
      expect(size).toBe(1);
      const snap = yield* mempool.snapshot;
      expect(snap[0]!.txId[0]).toBe(2);
    }).pipe(Effect.provide(MempoolLayers)),
  );
});
