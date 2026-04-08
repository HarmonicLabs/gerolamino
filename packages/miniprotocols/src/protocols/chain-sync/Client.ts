import { Cause, Config, Duration, Effect, Layer, Option, Schema, Scope, ServiceMap, Stream } from "effect";
import { Socket } from "effect/unstable/socket";
import { TimeoutError } from "effect/Cause";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import { ChainPoint } from "../types/ChainPoint";
import * as Schemas from "./Schemas";

export class ChainSyncError extends Schema.TaggedErrorClass<ChainSyncError>()("ChainSyncError", {
  cause: Schema.Defect,
}) {}

export type ChainSyncRollForward = Schema.Schema.Type<typeof Schemas.ChainSyncMessage> & {
  readonly _tag: Schemas.ChainSyncMessageType.RollForward;
};
export type ChainSyncRollBackward = Schema.Schema.Type<typeof Schemas.ChainSyncMessage> & {
  readonly _tag: Schemas.ChainSyncMessageType.RollBackward;
};
export type ChainSyncIntersectFound = Schema.Schema.Type<typeof Schemas.ChainSyncMessage> & {
  readonly _tag: Schemas.ChainSyncMessageType.IntersectFound;
};
export type ChainSyncIntersectNotFound = Schema.Schema.Type<typeof Schemas.ChainSyncMessage> & {
  readonly _tag: Schemas.ChainSyncMessageType.IntersectNotFound;
};

const decodeMessage = Schema.decodeUnknownEffect(Schemas.ChainSyncMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.ChainSyncMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new ChainSyncError({ cause: `Unexpected message: ${tag}` }));

/**
 * StMustReply timeout — per network spec 3.7.4, after AwaitReply the server
 * has 601-911s to respond. Defaults to 900s, configurable.
 */
const MustReplyTimeout = Config.duration("CHAIN_SYNC_MUST_REPLY_TIMEOUT").pipe(
  Config.withDefault(Duration.seconds(900)),
);

export class ChainSyncClient extends ServiceMap.Service<
  ChainSyncClient,
  {
    requestNext: () => Effect.Effect<
      ChainSyncRollForward | ChainSyncRollBackward,
      | ChainSyncError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    findIntersect: (
      points: ReadonlyArray<ChainPoint>,
    ) => Effect.Effect<
      ChainSyncIntersectFound | ChainSyncIntersectNotFound,
      | ChainSyncError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      ChainSyncError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/ChainSyncClient") {
  static readonly layer = Layer.effect(
    ChainSyncClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const mustReplyTimeout = yield* MustReplyTimeout;
      const channel = yield* multiplexer
        .getProtocolChannel(MiniProtocol.ChainSync)
        .pipe(Effect.mapError((cause) => new ChainSyncError({ cause })));

      const sendMessage = (msg: Schemas.ChainSyncMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      /** Match a message that must be RollForward or RollBackward. */
      const matchRollResult = (v: Schemas.ChainSyncMessageT) =>
        Schemas.ChainSyncMessage.match(v, {
          RollForward: (m) => Effect.succeed(m),
          RollBackward: (m) => Effect.succeed(m),
          RequestNext: (m) => unexpected(m._tag),
          AwaitReply: (m) => unexpected(m._tag),
          FindIntersect: (m) => unexpected(m._tag),
          IntersectFound: (m) => unexpected(m._tag),
          IntersectNotFound: (m) => unexpected(m._tag),
          Done: (m) => unexpected(m._tag),
        });

      /** Read the next message from the stream with the given timeout. */
      const nextMessage = (timeout: Duration.Duration, phase: string) =>
        messages.pipe(
          Stream.runHead,
          Effect.timeout(timeout),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ChainSyncError({ cause: `No response in ${phase}` })),
              onSome: Effect.succeed,
            }),
          ),
        );

      return ChainSyncClient.of({
        requestNext: () =>
          sendMessage({ _tag: Schemas.ChainSyncMessageType.RequestNext }).pipe(
            Effect.andThen(
              // StCanAwait: server must respond within 10s
              nextMessage(Duration.seconds(10), "StCanAwait").pipe(
                Effect.flatMap((msg) =>
                  msg._tag === Schemas.ChainSyncMessageType.AwaitReply
                    // StMustReply: at tip, wait for new block (up to 900s)
                    ? nextMessage(mustReplyTimeout, "StMustReply").pipe(
                        Effect.flatMap(matchRollResult),
                      )
                    : matchRollResult(msg),
                ),
              ),
            ),
          ),
        findIntersect: (points) =>
          sendMessage({
            _tag: Schemas.ChainSyncMessageType.FindIntersect,
            points: [...points],
          }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new ChainSyncError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.ChainSyncMessage.match(v, {
                        IntersectFound: (m) => Effect.succeed(m),
                        IntersectNotFound: (m) => Effect.succeed(m),
                        RequestNext: (m) => unexpected(m._tag),
                        AwaitReply: (m) => unexpected(m._tag),
                        RollForward: (m) => unexpected(m._tag),
                        RollBackward: (m) => unexpected(m._tag),
                        FindIntersect: (m) => unexpected(m._tag),
                        Done: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        done: () => sendMessage({ _tag: Schemas.ChainSyncMessageType.Done }),
      });
    }),
  );
}
