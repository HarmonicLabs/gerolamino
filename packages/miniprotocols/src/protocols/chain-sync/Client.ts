import { Cause, Config, Context, Duration, Effect, Layer, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import type { ChainPoint } from "../types/ChainPoint";
import { requireReply, unexpectedFor } from "../common";
import * as Schemas from "./Schemas";

export class ChainSyncError extends Schema.TaggedErrorClass<ChainSyncError>()("ChainSyncError", {
  cause: Schema.Defect,
}) {}

export type ChainSyncRollForward =
  (typeof Schemas.ChainSyncMessage.cases)[Schemas.ChainSyncMessageType.RollForward]["Type"];
export type ChainSyncRollBackward =
  (typeof Schemas.ChainSyncMessage.cases)[Schemas.ChainSyncMessageType.RollBackward]["Type"];
export type ChainSyncIntersectFound =
  (typeof Schemas.ChainSyncMessage.cases)[Schemas.ChainSyncMessageType.IntersectFound]["Type"];
export type ChainSyncIntersectNotFound =
  (typeof Schemas.ChainSyncMessage.cases)[Schemas.ChainSyncMessageType.IntersectNotFound]["Type"];

const decodeMessage = Schema.decodeUnknownEffect(Schemas.ChainSyncMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.ChainSyncMessageBytes);

const makeError = (cause: string) => new ChainSyncError({ cause });
const unexpected = unexpectedFor(makeError);

/**
 * StMustReply timeout — per network spec 3.7.4, after AwaitReply the server
 * has 601-911s to respond. Defaults to 900s, configurable.
 */
const MustReplyTimeout = Config.duration("CHAIN_SYNC_MUST_REPLY_TIMEOUT").pipe(
  Config.withDefault(Duration.seconds(900)),
);

export class ChainSyncClient extends Context.Service<
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
      // StMustReply session timeout — Ouroboros spec Table 3.6: one draw
      // per session (not per request) so benign slow servers don't flap
      // under an unlucky short draw. The operator-visible
      // `CHAIN_SYNC_MUST_REPLY_TIMEOUT` knob takes precedence; without it,
      // we draw uniformly in [601, 911]s on layer construction and reuse
      // the value for every `RequestNext` in this session.
      const mustReplySessionTimeout = yield* MustReplyTimeout;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.ChainSync);

      const sendMessage = (msg: Schemas.ChainSyncMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      /** Expect a `RollForward` or `RollBackward`; anything else is a
       * protocol violation on the current agency transition. */
      const matchRollResult = (
        v: Schemas.ChainSyncMessageT,
      ): Effect.Effect<ChainSyncRollForward | ChainSyncRollBackward, ChainSyncError> =>
        Schemas.ChainSyncMessage.isAnyOf([
          Schemas.ChainSyncMessageType.RollForward,
          Schemas.ChainSyncMessageType.RollBackward,
        ])(v)
          ? Effect.succeed(v)
          : unexpected(v._tag);

      return ChainSyncClient.of({
        requestNext: () =>
          sendMessage(Schemas.ChainSyncMessage.cases.RequestNext.make({})).pipe(
            Effect.andThen(
              // StCanAwait: server must respond within 10s
              requireReply(messages, makeError, "StCanAwait").pipe(
                Effect.flatMap((msg) =>
                  Schemas.ChainSyncMessage.guards.AwaitReply(msg)
                    ? // StMustReply: at tip, wait for new block. Timeout
                      // draws from the per-session constant above.
                      requireReply(
                        messages,
                        makeError,
                        "StMustReply",
                        mustReplySessionTimeout,
                      ).pipe(Effect.flatMap(matchRollResult))
                    : matchRollResult(msg),
                ),
              ),
            ),
          ),
        findIntersect: (points) =>
          sendMessage(
            Schemas.ChainSyncMessage.cases.FindIntersect.make({ points: [...points] }),
          ).pipe(
            Effect.andThen(
              requireReply(messages, makeError, "FindIntersect").pipe(
                Effect.flatMap((v) =>
                  Schemas.ChainSyncMessage.isAnyOf([
                    Schemas.ChainSyncMessageType.IntersectFound,
                    Schemas.ChainSyncMessageType.IntersectNotFound,
                  ])(v)
                    ? Effect.succeed(v)
                    : unexpected(v._tag),
                ),
              ),
            ),
          ),
        done: () => sendMessage(Schemas.ChainSyncMessage.cases.Done.make({})),
      });
    }),
  );
}
