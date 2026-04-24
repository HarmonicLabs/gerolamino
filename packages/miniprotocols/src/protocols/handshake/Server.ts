import { Context, Effect, Layer, PubSub, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";
import { intersection } from "es-toolkit";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MultiplexerHeaderError } from "../../multiplexer";
import { MiniProtocol } from "../../MiniProtocol";
import * as Schemas from "./Schemas";

export interface HandshakeServerConfig {
  supportedVersions: Schemas.VersionTable;
}

export class HandshakeServerError extends Schema.TaggedErrorClass<HandshakeServerError>()(
  "HandshakeServerError",
  {
    cause: Schema.Defect,
  },
) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.HandshakeMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.HandshakeMessageBytes);

const handleProposal = (
  message: Schemas.HandshakeMessageT,
  config: HandshakeServerConfig,
  channel: {
    send: (
      data: Uint8Array,
    ) => Effect.Effect<void, MultiplexerEncodingError | Socket.SocketError, Scope.Scope>;
  },
) => {
  if (!Schemas.HandshakeMessage.guards[Schemas.HandshakeMessageType.MsgProposeVersions](message)) {
    return Effect.fail(
      new HandshakeServerError({ cause: `Unexpected message type: ${message._tag}` }),
    );
  }

  return Effect.gen(function* () {
    const proposedVersions = Schema.decodeSync(
      Schema.String.pipe(Schema.decodeTo(Schemas.VersionNumber), Schema.Array),
    )(Object.keys(message.versionTable.data));

    const supportedVersions = Schema.decodeSync(
      Schema.String.pipe(Schema.decodeTo(Schemas.VersionNumber), Schema.Array),
    )(Object.keys(config.supportedVersions.data));

    // Highest mutually-supported N2N version wins. `intersection` preserves
    // the proposer's order; `Math.max` selects the newest regardless.
    const shared = intersection(proposedVersions, supportedVersions);
    const selectedVersion = shared.length > 0 ? Math.max(...shared) : undefined;

    if (selectedVersion) {
      const proposedData = message.versionTable.data[selectedVersion];

      if (proposedData?.query) {
        yield* encodeMessage({
          _tag: Schemas.HandshakeMessageType.MsgQueryReply,
          versionTable: config.supportedVersions,
        }).pipe(Effect.flatMap(channel.send));
      } else {
        const acceptedData = config.supportedVersions.data[selectedVersion];

        if (!acceptedData) {
          return yield* Effect.fail(
            new HandshakeServerError({
              cause: "Internal error: version not found",
            }),
          );
        }

        yield* encodeMessage({
          _tag: Schemas.HandshakeMessageType.MsgAcceptVersion,
          version: selectedVersion,
          versionData: acceptedData,
        }).pipe(Effect.flatMap(channel.send));
      }
    } else {
      yield* encodeMessage({
        _tag: Schemas.HandshakeMessageType.MsgRefuse,
        reason: {
          _tag: Schemas.RefuseReasonType.VersionMismatch,
          validVersions: supportedVersions,
        },
      }).pipe(Effect.flatMap(channel.send));
    }
  });
};

export class HandshakeServer extends Context.Service<
  HandshakeServer,
  {
    start: () => Effect.Effect<
      void,
      | HandshakeServerError
      | MultiplexerHeaderError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/HandshakeServer") {
  static readonly layer = (config: HandshakeServerConfig) =>
    Layer.effect(
      HandshakeServer,
      Effect.gen(function* () {
        const multiplexer = yield* Multiplexer;

        return HandshakeServer.of({
          start: () =>
            multiplexer.getProtocolChannel(MiniProtocol.Handshake).pipe(
              Effect.flatMap((channel) =>
                Stream.fromPubSub(channel.pubsub).pipe(
                  Stream.mapEffect((bytes) => decodeMessage(bytes)),
                  Stream.mapEffect((message) => handleProposal(message, config, channel)),
                  Stream.runDrain,
                ),
              ),
            ),
        });
      }),
    );
}
