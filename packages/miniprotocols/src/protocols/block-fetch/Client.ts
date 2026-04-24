import {
  Cause,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Socket } from "effect/unstable/socket";
import { TimeoutError } from "effect/Cause";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import type { ChainPoint } from "../types/ChainPoint";
import { requireReply, unexpectedFor } from "../common";
import * as Schemas from "./Schemas";

export class BlockFetchError extends Schema.TaggedErrorClass<BlockFetchError>()("BlockFetchError", {
  cause: Schema.Defect,
}) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.BlockFetchMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.BlockFetchMessageBytes);

const makeError = (cause: string) => new BlockFetchError({ cause });
const unexpected = unexpectedFor(makeError);

export class BlockFetchClient extends Context.Service<
  BlockFetchClient,
  {
    requestRange: (
      from: ChainPoint,
      to: ChainPoint,
    ) => Effect.Effect<
      Option.Option<Stream.Stream<Uint8Array, BlockFetchError | Schema.SchemaError | TimeoutError>>,
      | BlockFetchError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      BlockFetchError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/BlockFetchClient") {
  static readonly layer = Layer.effect(
    BlockFetchClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.BlockFetch);

      const sendMessage = (msg: Schemas.BlockFetchMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      // Persistent PubSub subscription — all messages buffered in this queue.
      // Stream.fromPubSub creates a NEW subscription per stream consumption,
      // causing a race where messages published between consumptions are
      // dropped. Stream.fromSubscription reuses one persistent subscription.
      const subscription = yield* PubSub.subscribe(channel.pubsub);

      const messages = Stream.fromSubscription(subscription).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return BlockFetchClient.of({
        requestRange: (from, to) =>
          sendMessage(Schemas.BlockFetchMessage.cases.RequestRange.make({ from, to })).pipe(
            Effect.andThen(requireReply(messages, makeError, "requestRange", Duration.seconds(60))),
            Effect.flatMap((v) =>
              Schemas.BlockFetchMessage.guards.StartBatch(v)
                ? Effect.succeed(
                    Option.some(
                      messages.pipe(
                        Stream.takeUntil(Schemas.BlockFetchMessage.guards.BatchDone, {
                          excludeLast: true,
                        }),
                        Stream.filterMap((msg) =>
                          Schemas.BlockFetchMessage.guards.Block(msg)
                            ? Result.succeed(msg.block)
                            : Result.fail(msg),
                        ),
                      ),
                    ),
                  )
                : Schemas.BlockFetchMessage.guards.NoBlocks(v)
                  ? Effect.succeed(Option.none())
                  : unexpected(v._tag),
            ),
          ),
        done: () => sendMessage(Schemas.BlockFetchMessage.cases.ClientDone.make({})),
      });
    }),
  );
}
