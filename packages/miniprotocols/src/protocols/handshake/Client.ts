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
                    // Narrow to the three valid responder states — a server
                    // that echoes `MsgProposeVersions` back at the client is
                    // a protocol violation we surface as `HandshakeError`
                    // rather than passing through as a typed message. The
                    // match keys are the numeric-enum values because
                    // `HandshakeMessageType` is a `Schema.Enum`.
                    onSome: (msg) =>
                      Schemas.HandshakeMessage.match(msg, {
                        [Schemas.HandshakeMessageType.MsgAcceptVersion]: (m) =>
                          Effect.succeed<Schemas.HandshakeMessageT>(m),
                        [Schemas.HandshakeMessageType.MsgRefuse]: (m) =>
                          Effect.succeed<Schemas.HandshakeMessageT>(m),
                        [Schemas.HandshakeMessageType.MsgQueryReply]: (m) =>
                          Effect.succeed<Schemas.HandshakeMessageT>(m),
                        [Schemas.HandshakeMessageType.MsgProposeVersions]: (_m) =>
                          Effect.fail(
                            new HandshakeError({
                              cause: `Unexpected handshake response from peer: MsgProposeVersions`,
                            }),
                          ),
                      }),
                  }),
                ),
              ),
            ),
          ),
      });
    }),
  );
}
