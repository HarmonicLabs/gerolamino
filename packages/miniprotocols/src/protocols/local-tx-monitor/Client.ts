import { Cause, Context, Effect, Layer, Option, Ref, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import { requireReply, unexpectedFor } from "../common";
import * as Schemas from "./Schemas";

export class LocalTxMonitorError extends Schema.TaggedErrorClass<LocalTxMonitorError>()(
  "LocalTxMonitorError",
  { cause: Schema.Defect },
) {}

type MonitorState = "Idle" | "Acquiring" | "Acquired" | "Busy" | "Done";

const decodeMessage = Schema.decodeUnknownEffect(Schemas.LocalTxMonitorMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.LocalTxMonitorMessageBytes);

const makeError = (cause: string) => new LocalTxMonitorError({ cause });
const unexpected = unexpectedFor(makeError);

export class LocalTxMonitorClient extends Context.Service<
  LocalTxMonitorClient,
  {
    acquire: () => Effect.Effect<
      number,
      | LocalTxMonitorError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    nextTx: () => Effect.Effect<
      Option.Option<Uint8Array>,
      | LocalTxMonitorError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    hasTx: (
      txId: Uint8Array,
    ) => Effect.Effect<
      boolean,
      | LocalTxMonitorError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    getSizes: () => Effect.Effect<
      Schemas.MempoolSizes,
      | LocalTxMonitorError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    release: () => Effect.Effect<
      void,
      LocalTxMonitorError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      LocalTxMonitorError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/LocalTxMonitorClient") {
  static readonly layer = Layer.effect(
    LocalTxMonitorClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.LocalTxMonitor);
      const state = yield* Ref.make<MonitorState>("Idle");

      const sendMessage = (msg: Schemas.LocalTxMonitorMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      const guardState = (expected: MonitorState) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            current === expected
              ? Effect.void
              : Effect.fail(
                  new LocalTxMonitorError({
                    cause: `Invalid state: expected ${expected}, got ${current}`,
                  }),
                ),
          ),
        );

      /**
       * Transition to Busy, send the request, read the reply, transition
       * back to Acquired, then run the caller's extractor against the
       * response. `extract` only needs to narrow / handle the expected
       * reply variant; anything else falls through to `unexpected`.
       */
      const busyRequest = <A>(
        msg: Schemas.LocalTxMonitorMessageT,
        extract: (v: Schemas.LocalTxMonitorMessageT) => Effect.Effect<A, LocalTxMonitorError>,
      ) =>
        guardState("Acquired").pipe(
          Effect.andThen(Ref.set(state, "Busy")),
          Effect.andThen(sendMessage(msg)),
          Effect.andThen(requireReply(messages, makeError, "busyRequest")),
          Effect.tap(() => Ref.set(state, "Acquired")),
          Effect.flatMap(extract),
        );

      return LocalTxMonitorClient.of({
        acquire: () =>
          guardState("Idle").pipe(
            Effect.andThen(Ref.set(state, "Acquiring")),
            Effect.andThen(sendMessage(Schemas.LocalTxMonitorMessage.cases.Acquire.make({}))),
            Effect.andThen(requireReply(messages, makeError, "acquire")),
            Effect.flatMap((v) =>
              Schemas.LocalTxMonitorMessage.guards.Acquired(v)
                ? Ref.set(state, "Acquired").pipe(Effect.as(v.slot))
                : unexpected(v._tag),
            ),
          ),
        nextTx: () =>
          busyRequest(Schemas.LocalTxMonitorMessage.cases.NextTx.make({}), (v) =>
            Schemas.LocalTxMonitorMessage.guards.ReplyNextTx(v)
              ? Effect.succeed(v.tx !== undefined ? Option.some(v.tx) : Option.none())
              : unexpected(v._tag),
          ),
        hasTx: (txId) =>
          busyRequest(Schemas.LocalTxMonitorMessage.cases.HasTx.make({ txId }), (v) =>
            Schemas.LocalTxMonitorMessage.guards.ReplyHasTx(v)
              ? Effect.succeed(v.hasTx)
              : unexpected(v._tag),
          ),
        getSizes: () =>
          busyRequest(Schemas.LocalTxMonitorMessage.cases.GetSizes.make({}), (v) =>
            Schemas.LocalTxMonitorMessage.guards.ReplyGetSizes(v)
              ? Effect.succeed(v.sizes)
              : unexpected(v._tag),
          ),
        release: () =>
          guardState("Acquired").pipe(
            Effect.andThen(sendMessage(Schemas.LocalTxMonitorMessage.cases.Release.make({}))),
            Effect.andThen(Ref.set(state, "Idle")),
          ),
        done: () =>
          guardState("Idle").pipe(
            Effect.andThen(sendMessage(Schemas.LocalTxMonitorMessage.cases.Done.make({}))),
            Effect.andThen(Ref.set(state, "Done")),
          ),
      });
    }),
  );
}
