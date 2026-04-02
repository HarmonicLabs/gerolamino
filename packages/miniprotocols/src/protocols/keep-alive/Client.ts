import { Cause, Duration, Effect, Layer, Option, Schedule, Schema, Scope, ServiceMap, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import * as Schemas from "./Schemas";

export class KeepAliveError extends Schema.TaggedErrorClass<KeepAliveError>()("KeepAliveError", {
  cause: Schema.Defect,
}) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.KeepAliveMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.KeepAliveMessageBytes);

const unexpected = (tag: string) => Effect.fail(new KeepAliveError({ cause: `Unexpected message: ${tag}` }));

export class KeepAliveClient extends ServiceMap.Service<
  KeepAliveClient,
  {
    keepAlive: (
      cookie: number,
    ) => Effect.Effect<
      number,
      | KeepAliveError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      KeepAliveError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
    run: () => Effect.Effect<
      void,
      | KeepAliveError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/KeepAliveClient") {
  static readonly layer = Layer.effect(
    KeepAliveClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer
        .getProtocolChannel(MiniProtocol.KeepAlive)
        .pipe(Effect.mapError((cause) => new KeepAliveError({ cause })));

      const sendMessage = (msg: Schemas.KeepAliveMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return KeepAliveClient.of({
        keepAlive: (cookie) =>
          sendMessage({ _tag: Schemas.KeepAliveMessageType.KeepAlive, cookie }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(97)),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new KeepAliveError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.KeepAliveMessage.match(v, {
                        KeepAliveResponse: (m) => Effect.succeed(m.cookie),
                        KeepAlive: (m) => unexpected(m._tag),
                        Done: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        done: () => sendMessage({ _tag: Schemas.KeepAliveMessageType.Done }),
        run: () => {
          let cookie = 0;
          return sendMessage({
            _tag: Schemas.KeepAliveMessageType.KeepAlive,
            cookie: cookie++,
          }).pipe(
            Effect.andThen(messages.pipe(Stream.runHead)),
            Effect.repeat(Schedule.spaced(Duration.seconds(30))),
          );
        },
      });
    }),
  );
}
