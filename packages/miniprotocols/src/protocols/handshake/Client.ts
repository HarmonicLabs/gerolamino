import { Cause, Context, Duration, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import * as Schemas from "./Schemas";

export class HandshakeError extends Schema.TaggedErrorClass<HandshakeError>()("HandshakeError", {
  cause: Schema.Defect,
}) {}

export class HandshakeTimeoutError extends Schema.TaggedErrorClass<HandshakeTimeoutError>()(
  "HandshakeTimeoutError",
  { cause: Schema.Defect },
) {}

export class HandshakeClient extends Context.Service<
  HandshakeClient,
  {
    propose: (
      versionTable: Schemas.VersionTable,
    ) => Effect.Effect<
      Schemas.HandshakeMessageT,
      | HandshakeError
      | HandshakeTimeoutError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/HandshakeClient") {
  static readonly layer = Layer.effect(
    HandshakeClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.Handshake);

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) =>
          Schema.decodeUnknownEffect(Schemas.HandshakeMessageBytes)(bytes),
        ),
      );

      return HandshakeClient.of({
        propose: (versionTable) =>
          Schema.encodeUnknownEffect(Schemas.HandshakeMessageBytes)({
            _tag: Schemas.HandshakeMessageType.MsgProposeVersions,
            versionTable,
          }).pipe(
            Effect.flatMap(channel.send),
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new HandshakeError({ cause: "No response received" })),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
          ),
      });
    }),
  );
}
