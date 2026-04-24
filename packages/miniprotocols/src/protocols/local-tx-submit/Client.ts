import { Cause, Context, Effect, Layer, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import { requireReply, unexpectedFor } from "../common";
import * as Schemas from "./Schemas";

export class LocalTxSubmitError extends Schema.TaggedErrorClass<LocalTxSubmitError>()(
  "LocalTxSubmitError",
  { cause: Schema.Defect },
) {}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.LocalTxSubmitMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.LocalTxSubmitMessageBytes);

const makeError = (cause: string) => new LocalTxSubmitError({ cause });
const unexpected = unexpectedFor(makeError);

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
          sendMessage(Schemas.LocalTxSubmitMessage.cases.SubmitTx.make({ tx })).pipe(
            Effect.andThen(requireReply(messages, makeError, "submit")),
            Effect.flatMap((v) =>
              Schemas.LocalTxSubmitMessage.guards.AcceptTx(v)
                ? Effect.succeed<Schemas.LocalTxSubmitResult>({ accepted: true })
                : Schemas.LocalTxSubmitMessage.guards.RejectTx(v)
                  ? Effect.succeed<Schemas.LocalTxSubmitResult>({
                      accepted: false,
                      reason: v.reason,
                    })
                  : unexpected(v._tag),
            ),
          ),
        done: () => sendMessage(Schemas.LocalTxSubmitMessage.cases.Done.make({})),
      });
    }),
  );
}
