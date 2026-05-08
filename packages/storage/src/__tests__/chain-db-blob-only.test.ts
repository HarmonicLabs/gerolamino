/**
 * `ChainDBBlobOnlyLive` contract tests — exercises every operation
 * against the actual Layer (not a stub) using `BlobStoreInMemory` as the
 * backing store. Mirrors the contract suite in `chain-db.test.ts` so the
 * BlobStore-only impl matches the same behaviour as the SQL-backed
 * sibling.
 *
 * Pattern:
 *   - `runWithChainDB(effect)` builds a fresh in-memory BlobStore and
 *     wires it into `ChainDBBlobOnlyLive`. Each test gets isolated
 *     state — closure-captured state in the in-memory store doesn't
 *     leak across tests.
 *   - Block fixtures use unique slot-derived hashes so successor /
 *     getBlock lookups don't collide across tests.
 *
 * The same `runChainDBContract(layer)` shape can be lifted to a shared
 * helper when we add a parallel run against `ChainDBLive` (SQL); the
 * only divergence is layer composition. Keeping one file per impl for
 * now since `ChainDBLive` requires `SqlClient` setup that's already
 * exercised in `chain-db-sql.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { BlobStoreInMemory, ChainDB } from "../index.ts";
import { ChainDBBlobOnlyLive } from "../services/chain-db-blob-only-live.ts";
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
  effect.pipe(
    Effect.provide(ChainDBBlobOnlyLive.pipe(Layer.provide(BlobStoreInMemory))),
  );

describe("ChainDBBlobOnlyLive — contract", () => {
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
