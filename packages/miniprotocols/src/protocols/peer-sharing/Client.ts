import {
  Cause,
  Context,
  Duration,
  Effect,
  Layer,
  Metric,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import { oversizedPeerSharingResponse } from "../../Metrics";
import { requireReply, unexpectedFor } from "../common";
import * as Schemas from "./Schemas";

export class PeerSharingError extends Schema.TaggedErrorClass<PeerSharingError>()(
  "PeerSharingError",
  { cause: Schema.Defect },
) {}

/**
 * Raised when a peer returns `MsgSharePeers` containing more entries than
 * we requested. Upstream codec (`PeerSharing/Type.hs:77-87`) documents the
 * cap but does not enforce it at the wire layer, so we detect + disconnect
 * (wave-2 research correction #28 — NOT silent truncate).
 */
export class OversizedPeerShareResponse extends Schema.TaggedErrorClass<OversizedPeerShareResponse>()(
  "OversizedPeerShareResponse",
  {
    requested: Schema.Number,
    received: Schema.Number,
  },
) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.PeerSharingMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.PeerSharingMessageBytes);

const makeError = (cause: string) => new PeerSharingError({ cause });
const unexpected = unexpectedFor(makeError);

export class PeerSharingClient extends Context.Service<
  PeerSharingClient,
  {
    shareRequest: (
      amount: number,
    ) => Effect.Effect<
      ReadonlyArray<Schemas.PeerAddress>,
      | PeerSharingError
      | OversizedPeerShareResponse
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
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.PeerSharing);

      const sendMessage = (msg: Schemas.PeerSharingMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return PeerSharingClient.of({
        shareRequest: (amount) =>
          sendMessage(Schemas.PeerSharingMessage.cases.ShareRequest.make({ amount })).pipe(
            Effect.andThen(
              requireReply(messages, makeError, "shareRequest", Duration.seconds(60)),
            ),
            Effect.flatMap((v) =>
              Effect.gen(function* () {
                if (!Schemas.PeerSharingMessage.guards.SharePeers(v)) {
                  return yield* unexpected(v._tag);
                }
                // Response cap is advisory at the wire layer
                // (`PeerSharing/Type.hs:77-87`); enforce it here and
                // disconnect oversized peers instead of silently truncating.
                if (v.peers.length > amount) {
                  yield* Metric.update(oversizedPeerSharingResponse, 1);
                  return yield* Effect.fail(
                    new OversizedPeerShareResponse({
                      requested: amount,
                      received: v.peers.length,
                    }),
                  );
                }
                return v.peers;
              }),
            ),
          ),
        done: () => sendMessage(Schemas.PeerSharingMessage.cases.Done.make({})),
      });
    }),
  );
}
