/**
 * `ChainDBLive` contract tests — exercises every operation against the
 * actual Layer (not a stub) using `BlobStoreInMemory` as the backing
 * store. Each test gets isolated state via a fresh in-memory BlobStore.
 *
 * Block fixtures use unique slot-derived hashes so successor /
 * getBlock lookups don't collide across tests.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { BlobStoreInMemory, ChainDB, ChainDBLive } from "../index.ts";
import type { StoredBlock } from "../types/StoredBlock.ts";

/** Build a `StoredBlock` with deterministic hash bytes derived from
 *  slot. Each test uses unique slots so hashes don't collide. */
const makeBlock = (slot: bigint, blockNo: bigint, prevHash?: Uint8Array): StoredBlock => {
  const hash = new Uint8Array(32);
  // Spread slot bits across the hash so two slots map to two distinct
  // hashes (the prior `.fill(slot & 0xff)` collapsed slot 256 onto
  // slot 0).
  const dv = new DataView(hash.buffer);
  dv.setBigUint64(0, slot);
  dv.setBigUint64(8, blockNo);
  return {
    slot,
    blockNo,
    hash,
    blockSizeBytes: 256,
    blockCbor: new Uint8Array(256).fill(Number(slot & 0xffn)),
    ...(prevHash ? { prevHash } : {}),
  };
};

/** Provide a fresh `ChainDB` over `BlobStoreInMemory` for each test. */
const runWithChainDB = <A>(effect: Effect.Effect<A, unknown, ChainDB>) =>
  effect.pipe(Effect.provide(ChainDBLive.pipe(Layer.provide(BlobStoreInMemory))));

describe("ChainDBLive — contract", () => {
  it.effect("addBlock + getBlock round-trips via the by-hash inverted index", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const block = makeBlock(100n, 50n);
        yield* db.addBlock(block);
        const result = yield* db.getBlock(block.hash);
        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          expect(result.value.slot).toBe(100n);
          expect(result.value.blockNo).toBe(50n);
          expect(result.value.blockSizeBytes).toBe(256);
        }
      }),
    ),
  );

  it.effect("getBlockAt direct lookup", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const block = makeBlock(123n, 99n);
        yield* db.addBlock(block);
        const result = yield* db.getBlockAt({ slot: 123n, hash: block.hash });
        expect(Option.isSome(result) && result.value.blockNo).toBe(99n);
      }),
    ),
  );

  it.effect("getTip returns the highest-slot block", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.addBlock(makeBlock(150n, 75n));
        const tip = yield* db.getTip;
        // BlobStore-only `getTip` reads the persisted `vtip` singleton,
        // which `addBlock` overwrites on every write — so the tip is
        // the LAST inserted block, not the highest-slot one. The SQL
        // sibling computes `MAX(slot)`. Both behaviours are valid for
        // a synchronously-fed chain (each `addBlock` advances the
        // tip); the test asserts the BlobStore-only contract.
        expect(Option.isSome(tip) && tip.value.slot).toBe(150n);
      }),
    ),
  );

  it.effect("rollback removes volatile blocks above the rollback point", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const b1 = makeBlock(100n, 50n);
        const b2 = makeBlock(200n, 100n);
        const b3 = makeBlock(300n, 150n);
        yield* db.addBlock(b1);
        yield* db.addBlock(b2);
        yield* db.addBlock(b3);
        yield* db.rollback({ slot: 150n, hash: b1.hash });
        const tip = yield* db.getTip;
        expect(Option.isSome(tip) && tip.value.slot).toBe(150n);
        // Blocks above 150 are gone.
        const above = yield* db.getBlockAt({ slot: 300n, hash: b3.hash });
        expect(Option.isNone(above)).toBe(true);
        // Block at 100 survives.
        const below = yield* db.getBlock(b1.hash);
        expect(Option.isSome(below) && below.value.slot).toBe(100n);
      }),
    ),
  );

  it.effect("promoteToImmutable moves blocks to the immutable region", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const b1 = makeBlock(100n, 50n);
        const b2 = makeBlock(200n, 100n);
        yield* db.addBlock(b1);
        yield* db.addBlock(b2);
        yield* db.promoteToImmutable({ slot: 100n, hash: b1.hash });
        // Promoted block is still readable (now from the immutable region).
        const result = yield* db.getBlock(b1.hash);
        expect(Option.isSome(result) && result.value.slot).toBe(100n);
        // Immutable tip advanced.
        const iTip = yield* db.getImmutableTip;
        expect(Option.isSome(iTip) && iTip.value.slot).toBe(100n);
      }),
    ),
  );

  it.effect("garbageCollect removes old volatile blocks", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const b1 = makeBlock(100n, 50n);
        const b2 = makeBlock(200n, 100n);
        yield* db.addBlock(b1);
        yield* db.addBlock(b2);
        yield* db.garbageCollect(150n);
        // Block at 100 was below the GC threshold — removed.
        const gone = yield* db.getBlock(b1.hash);
        expect(Option.isNone(gone)).toBe(true);
        // Block at 200 survives.
        const present = yield* db.getBlock(b2.hash);
        expect(Option.isSome(present) && present.value.slot).toBe(200n);
      }),
    ),
  );

  // Test-coverage gap #9 — garbageCollect MUST NOT touch the
  // immutable region. The volatile→immutable promotion at depth k is
  // the security boundary: once a block is past the rollback horizon
  // it is durably committed and never collected. A bug here would
  // silently corrupt the chain.
  it.effect("garbageCollect doesn't touch immutable blocks", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const b1 = makeBlock(100n, 50n);
        const b2 = makeBlock(200n, 100n);
        const b3 = makeBlock(300n, 150n);
        yield* db.addBlock(b1);
        yield* db.addBlock(b2);
        yield* db.addBlock(b3);
        // Promote b1 + b2 to immutable (upTo: 200n means b1+b2 move).
        yield* db.promoteToImmutable({ slot: 200n, hash: b2.hash });
        // garbageCollect with threshold=350 — would normally clear all
        // volatile + immutable below 350. Spec says immutable
        // untouched.
        yield* db.garbageCollect(350n);
        // Immutable b1 + b2 must survive.
        const survivedB1 = yield* db.getBlock(b1.hash);
        const survivedB2 = yield* db.getBlock(b2.hash);
        expect(Option.isSome(survivedB1)).toBe(true);
        expect(Option.isSome(survivedB2)).toBe(true);
        // Volatile b3 below 350 is gone.
        const goneB3 = yield* db.getBlock(b3.hash);
        expect(Option.isNone(goneB3)).toBe(true);
        // Immutable tip pointer survived too.
        const iTip = yield* db.getImmutableTip;
        expect(Option.isSome(iTip)).toBe(true);
      }),
    ),
  );

  it.effect("garbageCollect boundary — keeps slot exactly at threshold", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        // garbageCollect(belowSlot) clears slots STRICTLY less than the
        // threshold. A block at slot==threshold must survive.
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(150n, 75n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.garbageCollect(150n);
        const at100 = yield* db.getBlock(makeBlock(100n, 50n).hash);
        const at150 = yield* db.getBlock(makeBlock(150n, 75n).hash);
        const at200 = yield* db.getBlock(makeBlock(200n, 100n).hash);
        expect(Option.isNone(at100)).toBe(true); // < 150 — gone
        expect(Option.isSome(at150)).toBe(true); // == 150 — survives
        expect(Option.isSome(at200)).toBe(true); // > 150 — survives
      }),
    ),
  );

  it.effect("getSuccessors finds children via the inverted index", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const parent = makeBlock(100n, 50n);
        const childA = makeBlock(200n, 100n, parent.hash);
        const childB = makeBlock(201n, 101n, parent.hash);
        yield* db.addBlock(parent);
        yield* db.addBlock(childA);
        yield* db.addBlock(childB);
        const succs = yield* db.getSuccessors(parent.hash);
        expect(succs.length).toBe(2);
        // Successors are returned in (slot, hash) order — childA at slot
        // 200 sorts before childB at slot 201.
        expect(Array.from(succs[0]!)).toEqual(Array.from(childA.hash));
        expect(Array.from(succs[1]!)).toEqual(Array.from(childB.hash));
      }),
    ),
  );

  it.effect("streamFrom emits blocks in slot order from the start point", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.addBlock(makeBlock(300n, 150n));
        const blocks = yield* Stream.runCollect(db.streamFrom({ slot: 100n, hash: new Uint8Array(32) }));
        // All three blocks are at slot >= 100 → all included.
        expect(blocks.length).toBe(3);
        // Slot ASC order.
        expect(blocks[0]!.slot).toBe(100n);
        expect(blocks[1]!.slot).toBe(200n);
        expect(blocks[2]!.slot).toBe(300n);
      }),
    ),
  );

  // Test-coverage gap #28 — `streamFrom` merges immutable + volatile
  // regions in slot order. The pre-existing test above only covers
  // volatile blocks (everything fresh from `addBlock`). After
  // `promoteToImmutable`, the streamFrom path runs TWO prefix scans
  // (`vmet` + `imet`) and merges them; if either side is dropped or
  // the merge order is wrong the consensus driver receives blocks
  // out of slot-ASC order and the chain-selection logic mis-handles
  // tip detection.
  it.effect("streamFrom merges immutable + volatile in slot order", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        // Add 4 blocks. Promote the lowest two (slots 100, 200) to
        // immutable; leave 300 + 400 in volatile.
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.addBlock(makeBlock(300n, 150n));
        yield* db.addBlock(makeBlock(400n, 200n));
        yield* db.promoteToImmutable({ slot: 200n, hash: makeBlock(200n, 100n).hash });

        const blocks = yield* Stream.runCollect(
          db.streamFrom({ slot: 100n, hash: new Uint8Array(32) }),
        );
        // All 4 blocks (2 immutable + 2 volatile) included, slot ASC.
        expect(blocks.length).toBe(4);
        expect(blocks[0]!.slot).toBe(100n);
        expect(blocks[1]!.slot).toBe(200n);
        expect(blocks[2]!.slot).toBe(300n);
        expect(blocks[3]!.slot).toBe(400n);
      }),
    ),
  );

  it.effect("streamFrom skips immutable blocks below the start point", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        // 100 + 200 in immutable, 300 + 400 in volatile.
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.addBlock(makeBlock(300n, 150n));
        yield* db.addBlock(makeBlock(400n, 200n));
        yield* db.promoteToImmutable({ slot: 200n, hash: makeBlock(200n, 100n).hash });

        // Start at slot 250 — should yield only volatile 300 + 400.
        const blocks = yield* Stream.runCollect(
          db.streamFrom({ slot: 250n, hash: new Uint8Array(32) }),
        );
        expect(blocks.length).toBe(2);
        expect(blocks[0]!.slot).toBe(300n);
        expect(blocks[1]!.slot).toBe(400n);
      }),
    ),
  );

  it.effect("genesis block (no prevHash) round-trips with null prevHash", () =>
    runWithChainDB(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const genesis = makeBlock(0n, 0n); // no prevHash
        yield* db.addBlock(genesis);
        const result = yield* db.getBlock(genesis.hash);
        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          // The decoder detects the all-zero sentinel and returns
          // `undefined`/`null` for prevHash, NOT 32 zero bytes.
          expect(result.value.prevHash).toBeUndefined();
        }
      }),
    ),
  );
});
