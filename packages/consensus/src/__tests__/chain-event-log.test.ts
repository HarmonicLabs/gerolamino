import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, Fiber, Latch, PubSub } from "effect";
import {
  ChainEvent,
  ChainEventStream,
  ChainEventsLive,
  type ChainEventType,
  RollbackTarget,
  writeChainEvent,
} from "../chain/event-log.ts";

const sampleBlock: ChainEventType = {
  _tag: "BlockAccepted",
  slot: 100n,
  blockNo: 42n,
  hash: new Uint8Array(32).fill(0xaa),
  parentHash: new Uint8Array(32).fill(0x99),
};

const sampleTip: ChainEventType = {
  _tag: "TipAdvanced",
  slot: 101n,
  blockNo: 43n,
  hash: new Uint8Array(32).fill(0xbb),
};

const sampleRollback: ChainEventType = {
  _tag: "RolledBack",
  to: { _tag: "RealPoint", slot: 50n, hash: new Uint8Array(32).fill(0xcc) },
  depth: 2,
};

const sampleEpoch: ChainEventType = {
  _tag: "EpochBoundary",
  fromEpoch: 1n,
  toEpoch: 2n,
  epochNonce: new Uint8Array(32).fill(0xdd),
};

describe("chain/event-log", () => {
  // Follows the `effect/test/PubSub.test.ts` canonical subscriber pattern
  // (sequential publishers/subscribers with Latch sync):
  //   1. Fork a subscriber that subscribes inside scoped + awaits a latch
  //   2. Publisher writes N events then opens the latch
  //   3. Subscriber takes N events and exits
  it.effect("single subscriber sees events in publish order", () =>
    Effect.gen(function* () {
      const stream = yield* ChainEventStream;
      const values = [sampleBlock, sampleTip, sampleRollback];
      const latch = yield* Latch.make();
      const subscriber = yield* stream.subscribe.pipe(
        Effect.flatMap((subscription) =>
          latch.await.pipe(
            Effect.andThen(Effect.forEach(values, () => PubSub.take(subscription))),
          ),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.forEach(values, writeChainEvent);
      yield* latch.open;
      const result = yield* Fiber.join(subscriber);
      expect(result).toEqual(values);
    }).pipe(Effect.provide(ChainEventsLive)),
  );

  it.effect("two subscribers receive the same fan-out ordering", () =>
    Effect.gen(function* () {
      const stream = yield* ChainEventStream;
      const values = [sampleBlock, sampleEpoch];
      const latch = yield* Latch.make();

      const makeSubscriber = stream.subscribe.pipe(
        Effect.flatMap((subscription) =>
          latch.await.pipe(
            Effect.andThen(Effect.forEach(values, () => PubSub.take(subscription))),
          ),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );

      const a = yield* makeSubscriber;
      const b = yield* makeSubscriber;
      yield* Effect.forEach(values, writeChainEvent);
      yield* latch.open;

      const [aResult, bResult] = yield* Effect.all([Fiber.join(a), Fiber.join(b)], {
        concurrency: "unbounded",
      });
      expect(aResult).toEqual(values);
      expect(bResult).toEqual(values);
    }).pipe(Effect.provide(ChainEventsLive)),
  );

  it.effect("many sequential writes preserve order through one subscription", () =>
    Effect.gen(function* () {
      const stream = yield* ChainEventStream;
      const values: ChainEventType[] = Array.range(0, 9).map((i) => ({
        _tag: "TipAdvanced",
        slot: BigInt(i),
        blockNo: BigInt(i),
        hash: new Uint8Array(32).fill(i),
      }));
      const latch = yield* Latch.make();
      const subscriber = yield* stream.subscribe.pipe(
        Effect.flatMap((subscription) =>
          latch.await.pipe(
            Effect.andThen(Effect.forEach(values, () => PubSub.take(subscription))),
          ),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.forEach(values, writeChainEvent);
      yield* latch.open;
      const result = yield* Fiber.join(subscriber);
      expect(result).toEqual(values);
    }).pipe(Effect.provide(ChainEventsLive)),
  );

  it.effect("durable history replays every written event", () =>
    Effect.gen(function* () {
      const stream = yield* ChainEventStream;
      const values = [sampleBlock, sampleTip, sampleRollback, sampleEpoch];
      yield* Effect.forEach(values, writeChainEvent);
      const history = yield* stream.history;
      // msgpackr decode produces Node `Buffer` views for byte fields (still a
      // Uint8Array subclass). Compare on the semantic shape (tag + byte
      // content) rather than prototype identity.
      const byteKey = (b: Uint8Array): string => Buffer.from(b).toString("hex");
      const fingerprint = (e: ChainEventType) =>
        ChainEvent.match(e, {
          BlockAccepted: (p) => ({ ...p, hash: byteKey(p.hash), parentHash: byteKey(p.parentHash) }),
          TipAdvanced: (p) => ({ ...p, hash: byteKey(p.hash) }),
          RolledBack: (p) =>
            RollbackTarget.match(p.to, {
              RealPoint: (pt) => ({ ...p, to: { ...pt, hash: byteKey(pt.hash) } }),
              Origin: () => p,
            }),
          EpochBoundary: (p) => ({ ...p, epochNonce: byteKey(p.epochNonce) }),
        });
      expect(history.map(fingerprint)).toEqual(values.map(fingerprint));
    }).pipe(Effect.provide(ChainEventsLive)),
  );

  it.effect("all four event variants round-trip through ChainEvent.make", () =>
    Effect.gen(function* () {
      // Schema-level check: every variant constructs without narrowing error.
      const decoded = [sampleBlock, sampleTip, sampleRollback, sampleEpoch];
      const reEncoded = decoded.map((e) => ChainEvent.make(e));
      expect(reEncoded).toEqual(decoded);
    }),
  );
});
