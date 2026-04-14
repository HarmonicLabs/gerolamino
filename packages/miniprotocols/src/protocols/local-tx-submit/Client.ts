import { Cause, Context, Duration, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import * as Schemas from "./Schemas";

export class LocalTxSubmitError extends Schema.TaggedErrorClass<LocalTxSubmitError>()(
  "LocalTxSubmitError",
  { cause: Schema.Defect },
) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.LocalTxSubmitMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.LocalTxSubmitMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new LocalTxSubmitError({ cause: `Unexpected message: ${tag}` }));

export class LocalTxSubmitClient extends Context.Service<
  LocalTxSubmitClient,
  {
    submit: (
      tx: Uint8Array,
    ) => Effect.Effect<
      Schemas.LocalTxSubmitResult,
      | LocalTxSubmitError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      LocalTxSubmitError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/LocalTxSubmitClient") {
  static readonly layer = Layer.effect(
    LocalTxSubmitClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.LocalTxSubmission);

      const sendMessage = (msg: Schemas.LocalTxSubmitMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      return LocalTxSubmitClient.of({
        submit: (tx) =>
          sendMessage({ _tag: Schemas.LocalTxSubmitMessageType.SubmitTx, tx }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new LocalTxSubmitError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.LocalTxSubmitMessage.match(v, {
                        AcceptTx: () => Effect.succeed({ accepted: true as const }),
                        RejectTx: (m) =>
                          Effect.succeed({ accepted: false as const, reason: m.reason }),
                        SubmitTx: (m) => unexpected(m._tag),
                        Done: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        done: () => sendMessage({ _tag: Schemas.LocalTxSubmitMessageType.Done }),
      });
    }),
  );
}
