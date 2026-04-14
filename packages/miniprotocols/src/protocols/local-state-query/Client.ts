import {
  Cause,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Context,
  Stream,
} from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import type { ChainPoint } from "../types/ChainPoint";
import * as Schemas from "./Schemas";

export class LocalStateQueryError extends Schema.TaggedErrorClass<LocalStateQueryError>()(
  "LocalStateQueryError",
  { cause: Schema.Defect },
) {}

export class AcquireFailure extends Schema.TaggedErrorClass<AcquireFailure>()("AcquireFailure", {
  failure: Schema.Uint8Array,
}) {}

type QueryState = "Idle" | "Acquiring" | "Acquired" | "Querying" | "Done";

const decodeMessage = Schema.decodeUnknownEffect(Schemas.LocalStateQueryMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.LocalStateQueryMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new LocalStateQueryError({ cause: `Unexpected message: ${tag}` }));

export class LocalStateQueryClient extends Context.Service<
  LocalStateQueryClient,
  {
    acquire: (
      point?: ChainPoint,
    ) => Effect.Effect<
      void,
      | AcquireFailure
      | LocalStateQueryError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    query: (
      query: Uint8Array,
    ) => Effect.Effect<
      Uint8Array,
      | LocalStateQueryError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    reAcquire: (
      point?: ChainPoint,
    ) => Effect.Effect<
      void,
      | AcquireFailure
      | LocalStateQueryError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError
      | Cause.TimeoutError,
      Scope.Scope
    >;
    release: () => Effect.Effect<
      void,
      LocalStateQueryError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      LocalStateQueryError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/LocalStateQueryClient") {
  static readonly layer = Layer.effect(
    LocalStateQueryClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.LocalStateQuery);
      const state = yield* Ref.make<QueryState>("Idle");

      const sendMessage = (msg: Schemas.LocalStateQueryMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      const guardState = (expected: QueryState) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            current !== expected
              ? Effect.fail(
                  new LocalStateQueryError({
                    cause: `Invalid state: expected ${expected}, got ${current}`,
                  }),
                )
              : Effect.void,
          ),
        );

      const handleAcquireResponse = messages.pipe(
        Stream.runHead,
        Effect.timeout(Duration.seconds(10)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new LocalStateQueryError({ cause: "No response received" })),
            onSome: (v) =>
              Schemas.LocalStateQueryMessage.match(v, {
                Acquired: () => Ref.set(state, "Acquired"),
                Failure: (m) =>
                  Ref.set(state, "Idle").pipe(
                    Effect.andThen(Effect.fail(new AcquireFailure({ failure: m.failure }))),
                  ),
                Acquire: (m) => unexpected(m._tag),
                Query: (m) => unexpected(m._tag),
                Result: (m) => unexpected(m._tag),
                ReAcquire: (m) => unexpected(m._tag),
                Release: (m) => unexpected(m._tag),
                Done: (m) => unexpected(m._tag),
              }),
          }),
        ),
      );

      return LocalStateQueryClient.of({
        acquire: (point?) =>
          guardState("Idle").pipe(
            Effect.andThen(Ref.set(state, "Acquiring")),
            Effect.andThen(
              sendMessage({ _tag: Schemas.LocalStateQueryMessageType.Acquire, point }),
            ),
            Effect.andThen(handleAcquireResponse),
          ),
        query: (query) =>
          guardState("Acquired").pipe(
            Effect.andThen(Ref.set(state, "Querying")),
            Effect.andThen(sendMessage({ _tag: Schemas.LocalStateQueryMessageType.Query, query })),
            Effect.andThen(
              messages.pipe(
                Stream.runHead,
                Effect.timeout(Duration.seconds(10)),
                Effect.tap(() => Ref.set(state, "Acquired")),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new LocalStateQueryError({ cause: "No response received" })),
                    onSome: (v) =>
                      Schemas.LocalStateQueryMessage.match(v, {
                        Result: (m) => Effect.succeed(m.result),
                        Acquire: (m) => unexpected(m._tag),
                        Acquired: (m) => unexpected(m._tag),
                        Failure: (m) => unexpected(m._tag),
                        Query: (m) => unexpected(m._tag),
                        ReAcquire: (m) => unexpected(m._tag),
                        Release: (m) => unexpected(m._tag),
                        Done: (m) => unexpected(m._tag),
                      }),
                  }),
                ),
              ),
            ),
          ),
        reAcquire: (point?) =>
          guardState("Acquired").pipe(
            Effect.andThen(Ref.set(state, "Acquiring")),
            Effect.andThen(
              sendMessage({ _tag: Schemas.LocalStateQueryMessageType.ReAcquire, point }),
            ),
            Effect.andThen(handleAcquireResponse),
          ),
        release: () =>
          guardState("Acquired").pipe(
            Effect.andThen(sendMessage({ _tag: Schemas.LocalStateQueryMessageType.Release })),
            Effect.andThen(Ref.set(state, "Idle")),
          ),
        done: () =>
          guardState("Idle").pipe(
            Effect.andThen(sendMessage({ _tag: Schemas.LocalStateQueryMessageType.Done })),
            Effect.andThen(Ref.set(state, "Done")),
          ),
      });
    }),
  );
}
