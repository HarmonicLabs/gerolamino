/**
 * Bearer transport abstraction — the lowest-level "bytes in / bytes out"
 * contract the mini-protocol multiplexer rides over. Concrete bearers are
 * platform-specific (Bun Socket, browser WebSocket, in-memory mock) but
 * all speak the same `Channel<Uint8Array, Uint8Array, BearerError>` shape.
 *
 * Research: plan Tier-1 §2a. Every concrete bearer Layer is composed in
 * at app entrypoint; shared code only binds to `Bearer`.
 */
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";

/** Transport-layer failure — wraps whatever the concrete bearer surfaces. */
export class BearerError extends Schema.TaggedErrorClass<BearerError>()(
  "miniprotocols/BearerError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * Abstract bytes-in / bytes-out transport. The `Channel` shape is natural
 * for binary protocols — consumers read chunks via `Channel.runCollect` or
 * `Channel.toStream`, write chunks by lifting through `Channel.fromIterable`.
 *
 * We expose both a raw `Channel` (for advanced consumers) and a
 * `{ send, receive }` adapter (the common 80% path) so most protocol
 * clients can stay on simple yields.
 */
export class Bearer extends Context.Service<
  Bearer,
  {
    /** Read side — a stream of inbound byte chunks (arbitrary fragmentation). */
    readonly incoming: Stream.Stream<Uint8Array, BearerError>;
    /** Write side — send a byte chunk out. */
    readonly send: (bytes: Uint8Array) => Effect.Effect<void, BearerError>;
    /** Close the bearer; idempotent. */
    readonly close: Effect.Effect<void>;
  }
>()("miniprotocols/Bearer") {}

// ---------------------------------------------------------------------------
// MockBearer — in-memory, queue-backed. Used by tests + property runners.
// ---------------------------------------------------------------------------

/**
 * Handles for a paired `MockBearer` — the two halves of a bidirectional
 * in-memory connection. `a.send` delivers to `b.incoming`, and vice versa.
 *
 * Usage:
 *   const { clientLayer, serverLayer } = yield* MockBearer.pair();
 *   // clientLayer provides Bearer to a `HandshakeClient` under test;
 *   // serverLayer provides Bearer to a `HandshakeServer` stub under test.
 */
export interface BearerPair {
  readonly clientLayer: Layer.Layer<Bearer>;
  readonly serverLayer: Layer.Layer<Bearer>;
}

const mkSide = (tx: Queue.Queue<Uint8Array>, rx: Queue.Queue<Uint8Array>): Bearer["Service"] => ({
  incoming: Stream.fromQueue(rx),
  send: (bytes) =>
    Queue.offer(tx, bytes).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) => new BearerError({ message: "MockBearer send failed", cause }),
      ),
    ),
  close: Queue.shutdown(tx).pipe(Effect.zip(Queue.shutdown(rx)), Effect.asVoid),
});

/**
 * Allocate a paired in-memory bearer. Both sides are bounded at 1024
 * chunks by default — enough for test traffic, not enough to mask
 * backpressure bugs.
 */
export const MockBearer = {
  pair: (capacity = 1024): Effect.Effect<BearerPair> =>
    Effect.gen(function* () {
      const a = yield* Queue.bounded<Uint8Array>(capacity);
      const b = yield* Queue.bounded<Uint8Array>(capacity);
      // client writes into `b`, reads from `a`; server writes into `a`,
      // reads from `b`.
      const clientLayer = Layer.succeed(Bearer, mkSide(b, a));
      const serverLayer = Layer.succeed(Bearer, mkSide(a, b));
      return { clientLayer, serverLayer };
    }),
};

// (A `Channel`-oriented view over `Bearer` is easy to add when a consumer
// actually needs it; deliberately keeping the service surface minimal
// until then — the existing multiplexer already works off the raw
// `Socket` from `effect/unstable/socket/Socket`, and the typed-channel
// driver below only needs `incoming` / `send`.)
