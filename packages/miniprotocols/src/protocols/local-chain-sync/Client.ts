import { Cause, Context, Effect, Layer, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import type { ChainPoint } from "../types/ChainPoint";
import { requireReply, unexpectedFor } from "../common";
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

const makeError = (cause: string) => new LocalChainSyncError({ cause });
const unexpected = unexpectedFor(makeError);

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

      // AwaitReply tells us the tip has been reached; spec says the server
      // may keep the channel open — filter AwaitReply out so `requestNext`
      // sees only the RollForward / RollBackward / IntersectFound /
      // IntersectNotFound / Done frames the caller cares about.
      const rollStream = messages.pipe(
        Stream.filter((msg) => !Schemas.LocalChainSyncMessage.guards.AwaitReply(msg)),
      );

      return LocalChainSyncClient.of({
        requestNext: () =>
          sendMessage(Schemas.LocalChainSyncMessage.cases.RequestNext.make({})).pipe(
            Effect.andThen(requireReply(rollStream, makeError, "requestNext")),
            Effect.flatMap((v) =>
              Schemas.LocalChainSyncMessage.isAnyOf([
                Schemas.LocalChainSyncMessageType.RollForward,
                Schemas.LocalChainSyncMessageType.RollBackward,
              ])(v)
                ? Effect.succeed(v)
                : unexpected(v._tag),
            ),
          ),
        findIntersect: (points) =>
          sendMessage(
            Schemas.LocalChainSyncMessage.cases.FindIntersect.make({ points: [...points] }),
          ).pipe(
            Effect.andThen(requireReply(messages, makeError, "findIntersect")),
            Effect.flatMap((v) =>
              Schemas.LocalChainSyncMessage.isAnyOf([
                Schemas.LocalChainSyncMessageType.IntersectFound,
                Schemas.LocalChainSyncMessageType.IntersectNotFound,
              ])(v)
                ? Effect.succeed(v)
                : unexpected(v._tag),
            ),
          ),
        done: () => sendMessage(Schemas.LocalChainSyncMessage.cases.Done.make({})),
      });
    }),
  );
}
