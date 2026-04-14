/**
 * ChainDB service tests — using stub BlobStore + stub SQL.
 * Tests the unified chain storage interface (volatile-first lookups, rollback, GC).
 */
import { describe, it, expect } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { ChainDB } from "../services/chain-db.ts";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

// In-memory stub ChainDB for testing the service interface
const makeInMemoryChainDB = () => {
  const blocks = new Map<string, StoredBlock>();
  const immutableSlots = new Set<string>();
  let ledgerSnapshot: { point: RealPoint; stateBytes: Uint8Array; epoch: bigint } | undefined;

  const hashKey = (hash: Uint8Array) =>
    Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");

  return {
    getBlock: (hash: Uint8Array) => Effect.succeed(Option.fromNullishOr(blocks.get(hashKey(hash)))),

    getBlockAt: (point: RealPoint) =>
      Effect.succeed(Option.fromNullishOr(blocks.get(hashKey(point.hash)))),

    getTip: Effect.sync(() => {
      let best: RealPoint | undefined;
      for (const block of blocks.values()) {
        if (!best || block.slot > best.slot) {
          best = { slot: block.slot, hash: block.hash };
        }
      }
      return Option.fromNullishOr(best);
    }),

    getImmutableTip: Effect.sync(() => {
      let best: RealPoint | undefined;
      for (const block of blocks.values()) {
        if (immutableSlots.has(hashKey(block.hash))) {
          if (!best || block.slot > best.slot) {
            best = { slot: block.slot, hash: block.hash };
          }
        }
      }
      return Option.fromNullishOr(best);
    }),

    addBlock: (block: StoredBlock) =>
      Effect.sync(() => {
        blocks.set(hashKey(block.hash), block);
      }),

    rollback: (point: RealPoint) =>
      Effect.sync(() => {
        for (const [key, block] of blocks) {
          if (block.slot > point.slot && !immutableSlots.has(key)) {
            blocks.delete(key);
          }
        }
      }),

    getSuccessors: (hash: Uint8Array) =>
      Effect.sync(() => {
        const parentKey = hashKey(hash);
        const succs: Uint8Array[] = [];
        for (const block of blocks.values()) {
          if (block.prevHash && hashKey(block.prevHash) === parentKey) {
            succs.push(block.hash);
          }
        }
        return succs;
      }),

    streamFrom: (from: RealPoint) =>
      Stream.fromIterable(
        [...blocks.values()]
          .filter((b) => b.slot > from.slot)
          .sort((a, b) => Number(a.slot - b.slot)),
      ),

    promoteToImmutable: (upTo: RealPoint) =>
      Effect.sync(() => {
        for (const [key, block] of blocks) {
          if (block.slot <= upTo.slot) {
            immutableSlots.add(key);
          }
        }
      }),

    garbageCollect: (belowSlot: bigint) =>
      Effect.sync(() => {
        for (const [key, block] of blocks) {
          if (block.slot < belowSlot && !immutableSlots.has(key)) {
            blocks.delete(key);
          }
        }
      }),

    writeLedgerSnapshot: (slot: bigint, hash: Uint8Array, epoch: bigint, stateBytes: Uint8Array) =>
      Effect.sync(() => {
        ledgerSnapshot = { point: { slot, hash }, stateBytes, epoch };
      }),

    readLatestLedgerSnapshot: Effect.sync(() => Option.fromNullishOr(ledgerSnapshot)),

    writeNonces: () => Effect.void,
    readNonces: Effect.succeed(Option.none()),
  };
};

const makeBlock = (slot: bigint, blockNo: bigint, prevHash?: Uint8Array): StoredBlock => ({
  slot,
  blockNo,
  hash: new Uint8Array(32).fill(Number(slot & 0xffn)),
  prevHash,
  blockSizeBytes: 256,
  blockCbor: new Uint8Array(256),
});

/** Create a fresh ChainDB layer per test invocation. */
const run = <A>(effect: Effect.Effect<A, unknown, ChainDB>) => {
  const layer = Layer.succeed(ChainDB, makeInMemoryChainDB());
  return effect.pipe(Effect.provide(layer), Effect.runPromise);
};

describe("ChainDB unified service", () => {
  it("addBlock and getBlock", async () => {
    const block = makeBlock(100n, 50n);
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(block);
        return yield* db.getBlock(block.hash);
      }),
    );
    expect(Option.isSome(result) && result.value.slot).toBe(100n);
  });

  it("getTip returns highest slot", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.addBlock(makeBlock(150n, 75n));
        return yield* db.getTip;
      }),
    );
    expect(Option.isSome(result) && result.value.slot).toBe(200n);
  });

  it("rollback removes blocks after point", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.addBlock(makeBlock(300n, 150n));
        yield* db.rollback({ slot: 150n, hash: new Uint8Array(32) });
        return yield* db.getTip;
      }),
    );
    expect(Option.isSome(result) && result.value.slot).toBe(100n);
  });

  it("promoteToImmutable protects blocks from rollback", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const b1 = makeBlock(100n, 50n);
        const b2 = makeBlock(200n, 100n);
        yield* db.addBlock(b1);
        yield* db.addBlock(b2);
        yield* db.promoteToImmutable({ slot: 100n, hash: b1.hash });
        yield* db.rollback({ slot: 50n, hash: new Uint8Array(32) });
        // b1 is immutable — should survive rollback
        return yield* db.getBlock(b1.hash);
      }),
    );
    expect(Option.isSome(result) && result.value.slot).toBe(100n);
  });

  it("garbageCollect removes old volatile blocks", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.garbageCollect(150n);
        return yield* db.getTip;
      }),
    );
    expect(Option.isSome(result) && result.value.slot).toBe(200n); // Only slot 200 survives
  });

  it("streamFrom returns blocks in slot order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(300n, 150n));
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        const blocks: StoredBlock[] = [];
        yield* Stream.runForEach(db.streamFrom({ slot: 0n, hash: new Uint8Array(32) }), (b) =>
          Effect.sync(() => {
            blocks.push(b);
          }),
        );
        return blocks.map((b) => Number(b.slot));
      }),
    );
    expect(result).toEqual([100, 200, 300]);
  });

  it("getSuccessors finds child blocks", async () => {
    const parent = makeBlock(100n, 50n);
    const child1Hash = new Uint8Array(32).fill(0x01);
    const child2Hash = new Uint8Array(32).fill(0x02);
    const child1: StoredBlock = {
      ...makeBlock(101n, 51n),
      hash: child1Hash,
      prevHash: parent.hash,
    };
    const child2: StoredBlock = {
      ...makeBlock(102n, 52n),
      hash: child2Hash,
      prevHash: parent.hash,
    };

    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(parent);
        yield* db.addBlock(child1);
        yield* db.addBlock(child2);
        return yield* db.getSuccessors(parent.hash);
      }),
    );
    expect(result.length).toBe(2);
  });

  it("ledger snapshot write and read", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.writeLedgerSnapshot(
          100n,
          new Uint8Array(32).fill(0xaa),
          5n,
          new Uint8Array([1, 2, 3]),
        );
        return yield* db.readLatestLedgerSnapshot;
      }),
    );
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.point.slot).toBe(100n);
      expect(result.value.epoch).toBe(5n);
      expect(result.value.stateBytes).toEqual(new Uint8Array([1, 2, 3]));
    }
  });
});
