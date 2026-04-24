import {
  Cause,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Metric,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Socket } from "effect/unstable/socket";

import { keepAliveRtt, keepAliveCookieMissmatch } from "../../Metrics";
import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import { requireReply, unexpectedFor } from "../common";
import * as Schemas from "./Schemas";

export class KeepAliveError extends Schema.TaggedErrorClass<KeepAliveError>()("KeepAliveError", {
  cause: Schema.Defect,
}) {}

/**
 * Specific error raised when a peer returns `MsgKeepAliveResponse` with a
 * cookie that doesn't match the one we sent. Preserves the upstream Haskell
 * typo `Missmatch` (`ouroboros-network/.../KeepAlive/Type.hs:42-45`) so
 * operator dashboards and post-mortems correlate with cardano-node
 * telemetry — wave-2 research correction #27.
 */
export class KeepAliveCookieMissmatch extends Schema.TaggedErrorClass<KeepAliveCookieMissmatch>()(
  "KeepAliveCookieMissmatch",
  {
    sent: Schema.Number,
    received: Schema.Number,
  },
) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.KeepAliveMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.KeepAliveMessageBytes);

const makeError = (cause: string) => new KeepAliveError({ cause });
const unexpected = unexpectedFor(makeError);

/** KeepAlive interval — configurable, defaults to 30s. */
const KeepAliveInterval = Config.duration("KEEP_ALIVE_INTERVAL").pipe(
  Config.withDefault(Duration.seconds(30)),
);

export class KeepAliveClient extends Context.Service<
  KeepAliveClient,
  {
    keepAlive: (
      cookie: number,
    ) => Effect.Effect<
      number,
      | KeepAliveError
      | KeepAliveCookieMissmatch
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      KeepAliveError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
    run: () => Effect.Effect<
      void,
      | KeepAliveError
      | KeepAliveCookieMissmatch
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/KeepAliveClient") {
  static readonly layer = Layer.effect(
    KeepAliveClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const keepAliveInterval = yield* KeepAliveInterval;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.KeepAlive);

      const sendMessage = (msg: Schemas.KeepAliveMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      /**
       * Send a KeepAlive and validate that the response cookie matches.
       * Records round-trip latency in `ouroboros.keepalive.rtt_ms`.
       */
      const sendAndValidate = (cookie: number) =>
        Effect.gen(function* () {
          const startMs = yield* Clock.currentTimeMillis;
          yield* sendMessage(Schemas.KeepAliveMessage.cases.KeepAlive.make({ cookie }));
          const reply = yield* requireReply(messages, makeError, "KeepAlive", Duration.seconds(97));
          const result = yield* Schemas.KeepAliveMessage.guards.KeepAliveResponse(reply)
            ? reply.cookie === cookie
              ? Effect.succeed(reply.cookie)
              : Metric.update(keepAliveCookieMissmatch, 1).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new KeepAliveCookieMissmatch({ sent: cookie, received: reply.cookie }),
                    ),
                  ),
                )
            : unexpected(reply._tag);
          const endMs = yield* Clock.currentTimeMillis;
          yield* Metric.update(keepAliveRtt, endMs - startMs);
          return result;
        });

      return KeepAliveClient.of({
        keepAlive: (cookie) =>
          cookie < 0 || cookie > 0xffff
            ? Effect.fail(
                new KeepAliveError({ cause: `Cookie must be word16 (0-65535), got ${cookie}` }),
              )
            : sendAndValidate(cookie),
        done: () => sendMessage(Schemas.KeepAliveMessage.cases.Done.make({})),
        run: () =>
          Effect.gen(function* () {
            const cookie = yield* Ref.make(0);
            yield* Ref.getAndUpdate(cookie, (n) => (n + 1) & 0xffff).pipe(
              Effect.flatMap(sendAndValidate),
              Effect.repeat(Schedule.spaced(keepAliveInterval)),
            );
          }),
      });
    }),
  );
}
