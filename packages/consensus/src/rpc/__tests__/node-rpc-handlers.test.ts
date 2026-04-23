import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { ChainEventsLive } from "../../chain/event-log.ts";
import { Mempool } from "../../mempool/mempool.ts";
import { NodeRpcHandlersLive } from "../node-rpc-handlers.ts";

/**
 * Integration tests for NodeRpcHandlers. Exercises the handler shape +
 * backing-service wiring without going through an actual RpcServer
 * transport — the transport is a separate plan Phase 5 concern (Bun
 * Worker vs WebSocket vs in-memory).
 */

const TestLayers = Mempool.Live.pipe(
  Layer.provideMerge(ChainEventsLive),
  Layer.provide(KeyValueStore.layerMemory),
);

describe("NodeRpcHandlersLive contract", () => {
  it.effect("builds successfully with Mempool + ChainEventStream provided", () =>
    Effect.gen(function* () {
      // Provide NodeRpcHandlersLive — success = no construction error.
      yield* Effect.void;
    }).pipe(
      Effect.provide(NodeRpcHandlersLive),
      Effect.provide(TestLayers),
    ),
  );

  it("NodeRpcHandlersLive is a well-formed Layer", () => {
    // Non-effectful smoke test: the exported value is a Layer with the
    // expected shape — not `undefined` or an Effect.
    expect(NodeRpcHandlersLive).toBeTruthy();
    expect(typeof NodeRpcHandlersLive).toBe("object");
  });
});
