import {
  Cause,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  Scope,
  Context,
  Stream,
} from "effect";
import { Socket } from "effect/unstable/socket";
import { TimeoutError } from "effect/Cause";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import type { ChainPoint } from "../types/ChainPoint";
import * as Schemas from "./Schemas";

export class BlockFetchError extends Schema.TaggedErrorClass<BlockFetchError>()("BlockFetchError", {
  cause: Schema.Defect,
}) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.BlockFetchMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.BlockFetchMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new BlockFetchError({ cause: `Unexpected message: ${tag}` }));

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

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return BlockFetchClient.of({
        requestRange: (from, to) =>
          sendMessage({ _tag: Schemas.BlockFetchMessageType.RequestRange, from, to }).pipe(
            Effect.timeout(Duration.seconds(60)),
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new BlockFetchError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.BlockFetchMessage.match(v, {
                        StartBatch: () =>
                          messages.pipe(
                            Stream.takeUntil(Schemas.BlockFetchMessage.guards.BatchDone, {
                              excludeLast: true,
                            }),
                            Stream.filterMap((msg) =>
                              Schemas.BlockFetchMessage.guards.Block(msg)
                                ? Result.succeed(msg.block)
                                : Result.fail(msg),
                            ),
                            Option.some,
                            Effect.succeed,
                          ),
                        NoBlocks: () => Effect.succeed(Option.none()),
                        RequestRange: (m) => unexpected(m._tag),
                        ClientDone: (m) => unexpected(m._tag),
                        Block: (m) => unexpected(m._tag),
                        BatchDone: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        done: () => sendMessage({ _tag: Schemas.BlockFetchMessageType.ClientDone }),
      });
    }),
  );
}
