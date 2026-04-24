/**
 * Shared protocol-client helpers.
 *
 * Every mini-protocol Client follows the same `send → await reply →
 * dispatch on _tag` shape. The functions in here are the handful of
 * pieces that would otherwise be copy-pasted verbatim across all 11
 * clients:
 *
 *   - `requireReply` — pull the next inbound message with a timeout, map
 *     `None` + `TimeoutError` to a typed protocol error. Replaces the
 *     repeated `messages.pipe(Stream.runHead, Effect.timeout(…),
 *     Effect.flatMap(Option.match({ onNone, onSome })))` chain.
 *   - `unexpectedFor` — build a fail-on-unexpected-tag helper curried on
 *     the client's typed error class. Replaces the per-client `const
 *     unexpected = (tag: string) => Effect.fail(new FooError(...))`.
 *
 * Kept deliberately un-Schema-annotated — these are plumbing helpers,
 * not wire types.
 */
import { Duration, Effect, Option, Stream } from "effect";

// ---------------------------------------------------------------------------
// requireReply
// ---------------------------------------------------------------------------

/**
 * Pull the next message off a decoded protocol stream, subject to a
 * timeout. Missing messages (stream ended) and timeouts both collapse to
 * the caller's typed `ProtocolError`.
 *
 * @param messages  decoded inbound message stream for this protocol
 * @param makeError factory — `(cause) => new FooError({ cause })`
 * @param phase     free-form label used in the "No response …" message
 * @param timeout   how long to wait for the reply; defaults to 10s
 */
export const requireReply = <A, E, R, ProtocolError>(
  messages: Stream.Stream<A, E, R>,
  makeError: (cause: string) => ProtocolError,
  phase: string,
  timeout: Duration.Duration = Duration.seconds(10),
): Effect.Effect<A, E | ProtocolError, R> =>
  messages.pipe(
    Stream.runHead,
    Effect.timeout(timeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(makeError(`No response in ${phase} (timeout ${Duration.format(timeout)})`)),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(makeError(`No response received (${phase})`)),
        onSome: Effect.succeed,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// unexpectedFor
// ---------------------------------------------------------------------------

/**
 * Build a `(tag) => Effect.fail(new ProtocolError(...))` closure for the
 * `Match.orElse` / guard-fallback path. Usage:
 *
 *   const unexpected = unexpectedFor((cause) => new FooError({ cause }));
 *   ...
 *   Match.value(v).pipe(
 *     Match.tag("Expected", handle),
 *     Match.orElse((m) => unexpected(m._tag)),
 *   );
 */
export const unexpectedFor =
  <ProtocolError>(makeError: (cause: string) => ProtocolError) =>
  (tag: string): Effect.Effect<never, ProtocolError> =>
    Effect.fail(makeError(`Unexpected message: ${tag}`));
