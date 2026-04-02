import { Cause, Duration, Effect, Layer, Option, Schema, Scope, ServiceMap, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import * as Schemas from "./Schemas";

export class PeerSharingError extends Schema.TaggedErrorClass<PeerSharingError>()(
  "PeerSharingError",
  { cause: Schema.Defect },
) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.PeerSharingMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.PeerSharingMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new PeerSharingError({ cause: `Unexpected message: ${tag}` }));

export class PeerSharingClient extends ServiceMap.Service<
  PeerSharingClient,
  {
    shareRequest: (
      amount: number,
    ) => Effect.Effect<
      ReadonlyArray<Schemas.PeerAddress>,
      | PeerSharingError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      PeerSharingError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/PeerSharingClient") {
  static readonly layer = Layer.effect(
    PeerSharingClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer
        .getProtocolChannel(MiniProtocol.PeerSharing)
        .pipe(Effect.mapError((cause) => new PeerSharingError({ cause })));

      const sendMessage = (msg: Schemas.PeerSharingMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return PeerSharingClient.of({
        shareRequest: (amount) =>
          sendMessage({ _tag: Schemas.PeerSharingMessageType.ShareRequest, amount }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(60)),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PeerSharingError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.PeerSharingMessage.match(v, {
                        SharePeers: (m) => Effect.succeed(m.peers),
                        ShareRequest: (m) => unexpected(m._tag),
                        Done: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        done: () => sendMessage({ _tag: Schemas.PeerSharingMessageType.Done }),
      });
    }),
  );
}
