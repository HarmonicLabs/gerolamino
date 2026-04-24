/**
 * Integration test — SyncStage pipeline feeding the EventLog.
 *
 * Demonstrates the plan's "consumers of SyncStage emit into the chain event
 * log" shape: a two-stage pipeline (validate → accept) where each accepted
 * block fans out to a live `Stream` + survives in the durable journal.
 * Mirrors the future Phase 3f BlockSync Workflow's `HeaderValidateStage →
 * BodyValidateStage → LedgerApplyStage → writeChainEvent` flow at reduced
 * scope — no real consensus rules, just the wiring shape.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Latch, PubSub, Stream } from "effect";
import { EventLog } from "effect/unstable/eventlog";
import {
  ChainEvent,
  ChainEventStream,
  ChainEventsLive,
  type ChainEventType,
  writeChainEvent,
} from "../chain/event-log.ts";
import { SyncStage, connect } from "../stage/SyncStage.ts";

type RawBlock = {
  readonly slot: bigint;
  readonly blockNo: bigint;
  readonly hash: Uint8Array;
  readonly parentHash: Uint8Array;
};

type ValidatedBlock = RawBlock & { readonly validated: true };

const validateStage = new SyncStage<RawBlock, ValidatedBlock, never, never>({
  name: "validate",
  run: (block) => Effect.succeed({ ...block, validated: true } as const),
  concurrency: 2,
});

const emitStage = new SyncStage<ValidatedBlock, ChainEventType, never, EventLog.EventLog>({
  name: "emit",
  run: (block) =>
    Effect.gen(function* () {
      const event: ChainEventType = {
        _tag: "BlockAccepted",
        slot: block.slot,
        blockNo: block.blockNo,
        hash: block.hash,
        parentHash: block.parentHash,
      };
      // `writeChainEvent` surfaces `EventJournalError` on journal write
      // failure; the stage's declared error channel is `never` (the in-memory
      // test journal doesn't fail). `Effect.orDie` keeps the stage
      // signature tight without widening to expose a transient infra error.
      yield* writeChainEvent(event).pipe(Effect.orDie);
      return event;
    }),
  concurrency: 1,
});

const mkBlock = (n: bigint): RawBlock => ({
  slot: n * 10n,
  blockNo: n,
  hash: new Uint8Array(32).fill(Number(n % 256n)),
  parentHash: new Uint8Array(32).fill(Number((n - 1n) % 256n)),
});

describe("SyncStage + EventLog integration", () => {
  it.effect("validate→emit pipeline writes one BlockAccepted per block", () =>
    Effect.gen(function* () {
      const stream = yield* ChainEventStream;
      const n = 5;
      const blocks = Array.from({ length: n }, (_, i) => mkBlock(BigInt(i + 1)));

      // Subscribe first — Latch-gated per PubSub canonical pattern
      const latch = yield* Latch.make();
      const subscriber = yield* stream.subscribe.pipe(
        Effect.flatMap((sub) =>
          latch.await.pipe(
            Effect.andThen(Effect.forEach(blocks, () => PubSub.take(sub), { discard: false })),
          ),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );

      // Drive the pipeline: Stream<RawBlock> → validate → emit
      const pipeline = connect(validateStage, emitStage);
      const emitted = yield* Stream.runCollect(pipeline(Stream.fromIterable(blocks)));

      // Release the subscriber so it drains
      yield* latch.open;
      const received = yield* Fiber.join(subscriber);

      expect(emitted.length).toBe(n);
      expect(received.length).toBe(n);
      // Subscriber saw every event the pipeline emitted. PubSub ordering is
      // not strictly guaranteed under concurrency > 1 in validate; the count
      // + identity is invariant. Extract stable keys for set comparison.
      const key = (e: ChainEventType): string =>
        e._tag === "BlockAccepted" ? e.hash.toString() : `${e._tag}-other`;
      expect(new Set(received.map(key))).toEqual(new Set(emitted.map(key)));
    }).pipe(Effect.provide(ChainEventsLive)),
  );

  it.effect("history replay returns every durable event", () =>
    Effect.gen(function* () {
      const stream = yield* ChainEventStream;
      const blocks = [mkBlock(1n), mkBlock(2n), mkBlock(3n)];
      const pipeline = connect(validateStage, emitStage);
      yield* Stream.runCollect(pipeline(Stream.fromIterable(blocks)));
      const history = yield* stream.history;
      // Every emitted BlockAccepted was journaled; count matches input.
      expect(history.length).toBe(blocks.length);
      for (const event of history) {
        expect(event._tag).toBe("BlockAccepted");
      }
    }).pipe(Effect.provide(ChainEventsLive)),
  );

  it.effect("all emitted events are valid ChainEvent shapes", () =>
    Effect.gen(function* () {
      const blocks = [mkBlock(1n), mkBlock(2n)];
      const pipeline = connect(validateStage, emitStage);
      const emitted = yield* Stream.runCollect(pipeline(Stream.fromIterable(blocks)));
      for (const event of emitted) {
        // Re-make forces schema validation
        const reEncoded = ChainEvent.make(event);
        expect(reEncoded._tag).toBe("BlockAccepted");
      }
    }).pipe(Effect.provide(ChainEventsLive)),
  );
});
