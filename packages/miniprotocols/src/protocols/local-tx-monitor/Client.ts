import {
  Cause,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import * as Schemas from "./Schemas";

export class LocalTxMonitorError extends Schema.TaggedErrorClass<LocalTxMonitorError>()(
  "LocalTxMonitorError",
  { cause: Schema.Defect },
) {}

type MonitorState = "Idle" | "Acquiring" | "Acquired" | "Busy" | "Done";

const decodeMessage = Schema.decodeUnknownEffect(Schemas.LocalTxMonitorMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.LocalTxMonitorMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new LocalTxMonitorError({ cause: `Unexpected message: ${tag}` }));

export class LocalTxMonitorClient extends ServiceMap.Service<
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
            current !== expected
              ? Effect.fail(
                  new LocalTxMonitorError({
                    cause: `Invalid state: expected ${expected}, got ${current}`,
                  }),
                )
              : Effect.void,
          ),
        );

      // Helper: transition to Busy, send message, receive response, return to Acquired
      const busyRequest = <A>(
        msg: Schemas.LocalTxMonitorMessageT,
        extract: (v: Schemas.LocalTxMonitorMessageT) => Effect.Effect<A, LocalTxMonitorError>,
      ) =>
        guardState("Acquired").pipe(
          Effect.andThen(Ref.set(state, "Busy")),
          Effect.andThen(sendMessage(msg)),
          Effect.andThen(
            messages.pipe(
              Stream.runHead,
              Effect.timeout(Duration.seconds(10)),
              Effect.tap(() => Ref.set(state, "Acquired")),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(new LocalTxMonitorError({ cause: "No response received" })),
                  onSome: extract,
                }),
              ),
            ),
          ),
        );

      return LocalTxMonitorClient.of({
        acquire: () =>
          guardState("Idle").pipe(
            Effect.andThen(Ref.set(state, "Acquiring")),
            Effect.andThen(sendMessage({ _tag: Schemas.LocalTxMonitorMessageType.Acquire })),
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new LocalTxMonitorError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.LocalTxMonitorMessage.match(v, {
                        Acquired: (m) => Ref.set(state, "Acquired").pipe(Effect.as(m.slot)),
                        Acquire: (m) => unexpected(m._tag),
                        Release: (m) => unexpected(m._tag),
                        NextTx: (m) => unexpected(m._tag),
                        ReplyNextTx: (m) => unexpected(m._tag),
                        HasTx: (m) => unexpected(m._tag),
                        ReplyHasTx: (m) => unexpected(m._tag),
                        GetSizes: (m) => unexpected(m._tag),
                        ReplyGetSizes: (m) => unexpected(m._tag),
                        Done: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        nextTx: () =>
          busyRequest({ _tag: Schemas.LocalTxMonitorMessageType.NextTx }, (v) =>
            Schemas.LocalTxMonitorMessage.match(v, {
              ReplyNextTx: (m) =>
                Effect.succeed(m.tx !== undefined ? Option.some(m.tx) : Option.none()),
              Acquire: (m) => unexpected(m._tag),
              Acquired: (m) => unexpected(m._tag),
              Release: (m) => unexpected(m._tag),
              NextTx: (m) => unexpected(m._tag),
              HasTx: (m) => unexpected(m._tag),
              ReplyHasTx: (m) => unexpected(m._tag),
              GetSizes: (m) => unexpected(m._tag),
              ReplyGetSizes: (m) => unexpected(m._tag),
              Done: (m) => unexpected(m._tag),
            }),
          ),
        hasTx: (txId) =>
          busyRequest({ _tag: Schemas.LocalTxMonitorMessageType.HasTx, txId }, (v) =>
            Schemas.LocalTxMonitorMessage.match(v, {
              ReplyHasTx: (m) => Effect.succeed(m.hasTx),
              Acquire: (m) => unexpected(m._tag),
              Acquired: (m) => unexpected(m._tag),
              Release: (m) => unexpected(m._tag),
              NextTx: (m) => unexpected(m._tag),
              ReplyNextTx: (m) => unexpected(m._tag),
              HasTx: (m) => unexpected(m._tag),
              GetSizes: (m) => unexpected(m._tag),
              ReplyGetSizes: (m) => unexpected(m._tag),
              Done: (m) => unexpected(m._tag),
            }),
          ),
        getSizes: () =>
          busyRequest({ _tag: Schemas.LocalTxMonitorMessageType.GetSizes }, (v) =>
            Schemas.LocalTxMonitorMessage.match(v, {
              ReplyGetSizes: (m) => Effect.succeed(m.sizes),
              Acquire: (m) => unexpected(m._tag),
              Acquired: (m) => unexpected(m._tag),
              Release: (m) => unexpected(m._tag),
              NextTx: (m) => unexpected(m._tag),
              ReplyNextTx: (m) => unexpected(m._tag),
              HasTx: (m) => unexpected(m._tag),
              ReplyHasTx: (m) => unexpected(m._tag),
              GetSizes: (m) => unexpected(m._tag),
              Done: (m) => unexpected(m._tag),
            }),
          ),
        release: () =>
          guardState("Acquired").pipe(
            Effect.andThen(sendMessage({ _tag: Schemas.LocalTxMonitorMessageType.Release })),
            Effect.andThen(Ref.set(state, "Idle")),
          ),
        done: () =>
          guardState("Idle").pipe(
            Effect.andThen(sendMessage({ _tag: Schemas.LocalTxMonitorMessageType.Done })),
            Effect.andThen(Ref.set(state, "Done")),
          ),
      });
    }),
  );
}
