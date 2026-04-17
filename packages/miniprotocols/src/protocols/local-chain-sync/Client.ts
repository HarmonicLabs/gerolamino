import { Cause, Context, Duration, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";
import { TimeoutError } from "effect/Cause";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import type { ChainPoint } from "../types/ChainPoint";
import * as Schemas from "./Schemas";

export class LocalChainSyncError extends Schema.TaggedErrorClass<LocalChainSyncError>()(
  "LocalChainSyncError",
  { cause: Schema.Defect },
) {}

export type LocalChainSyncRollForward =
  (typeof Schemas.LocalChainSyncMessage.cases)[Schemas.LocalChainSyncMessageType.RollForward]["Type"];
export type LocalChainSyncRollBackward =
  (typeof Schemas.LocalChainSyncMessage.cases)[Schemas.LocalChainSyncMessageType.RollBackward]["Type"];
export type LocalChainSyncIntersectFound =
  (typeof Schemas.LocalChainSyncMessage.cases)[Schemas.LocalChainSyncMessageType.IntersectFound]["Type"];
export type LocalChainSyncIntersectNotFound =
  (typeof Schemas.LocalChainSyncMessage.cases)[Schemas.LocalChainSyncMessageType.IntersectNotFound]["Type"];

const decodeMessage = Schema.decodeUnknownEffect(Schemas.LocalChainSyncMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.LocalChainSyncMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new LocalChainSyncError({ cause: `Unexpected message: ${tag}` }));

export class LocalChainSyncClient extends Context.Service<
  LocalChainSyncClient,
  {
    requestNext: () => Effect.Effect<
      LocalChainSyncRollForward | LocalChainSyncRollBackward,
      | LocalChainSyncError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    findIntersect: (
      points: ReadonlyArray<ChainPoint>,
    ) => Effect.Effect<
      LocalChainSyncIntersectFound | LocalChainSyncIntersectNotFound,
      | LocalChainSyncError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      LocalChainSyncError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/LocalChainSyncClient") {
  static readonly layer = Layer.effect(
    LocalChainSyncClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.LocalChainSync);

      const sendMessage = (msg: Schemas.LocalChainSyncMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return LocalChainSyncClient.of({
        requestNext: () =>
          sendMessage({ _tag: Schemas.LocalChainSyncMessageType.RequestNext }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.filter((msg) => !Schemas.LocalChainSyncMessage.guards.AwaitReply(msg)),
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new LocalChainSyncError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.LocalChainSyncMessage.match(v, {
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
          sendMessage({
            _tag: Schemas.LocalChainSyncMessageType.FindIntersect,
            points: [...points],
          }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new LocalChainSyncError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.LocalChainSyncMessage.match(v, {
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
        done: () => sendMessage({ _tag: Schemas.LocalChainSyncMessageType.Done }),
      });
    }),
  );
}
