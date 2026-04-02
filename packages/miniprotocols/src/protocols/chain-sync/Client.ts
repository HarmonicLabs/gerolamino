import { Cause, Duration, Effect, Layer, Option, Schema, Scope, ServiceMap, Stream } from "effect";
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

const unexpected = (tag: string) => Effect.fail(new ChainSyncError({ cause: `Unexpected message: ${tag}` }));

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
      const channel = yield* multiplexer
        .getProtocolChannel(MiniProtocol.ChainSync)
        .pipe(Effect.mapError((cause) => new ChainSyncError({ cause })));

      const sendMessage = (msg: Schemas.ChainSyncMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return ChainSyncClient.of({
        requestNext: () =>
          sendMessage({ _tag: Schemas.ChainSyncMessageType.RequestNext }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.filter((msg) => msg._tag !== Schemas.ChainSyncMessageType.AwaitReply),
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new ChainSyncError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.ChainSyncMessage.match(v, {
                        RollForward: (m) => Effect.succeed(m),
                        RollBackward: (m) => Effect.succeed(m),
                        RequestNext: (m) => unexpected(m._tag),
                        AwaitReply: (m) => unexpected(m._tag),
                        FindIntersect: (m) => unexpected(m._tag),
                        IntersectFound: (m) => unexpected(m._tag),
                        IntersectNotFound: (m) => unexpected(m._tag),
                        Done: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        findIntersect: (points) =>
          sendMessage({ _tag: Schemas.ChainSyncMessageType.FindIntersect, points: [...points] }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new ChainSyncError({ cause: "No response received" })),
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
