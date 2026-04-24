import { Cause, Context, Effect, Layer, Ref, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import type { ChainPoint } from "../types/ChainPoint";
import { requireReply, unexpectedFor } from "../common";
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

const makeError = (cause: string) => new LocalStateQueryError({ cause });
const unexpected = unexpectedFor(makeError);

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
            current === expected
              ? Effect.void
              : Effect.fail(
                  new LocalStateQueryError({
                    cause: `Invalid state: expected ${expected}, got ${current}`,
                  }),
                ),
          ),
        );

      const handleAcquireResponse: Effect.Effect<
        void,
        AcquireFailure | LocalStateQueryError | Schema.SchemaError | Cause.TimeoutError,
        Scope.Scope
      > = requireReply(messages, makeError, "acquire").pipe(
        Effect.flatMap((v) =>
          Effect.gen(function* () {
            if (Schemas.LocalStateQueryMessage.guards.Acquired(v)) {
              yield* Ref.set(state, "Acquired");
              return;
            }
            if (Schemas.LocalStateQueryMessage.guards.Failure(v)) {
              yield* Ref.set(state, "Idle");
              return yield* Effect.fail(new AcquireFailure({ failure: v.failure }));
            }
            return yield* unexpected(v._tag);
          }),
        ),
      );

      return LocalStateQueryClient.of({
        acquire: (point?) =>
          guardState("Idle").pipe(
            Effect.andThen(Ref.set(state, "Acquiring")),
            Effect.andThen(
              sendMessage(Schemas.LocalStateQueryMessage.cases.Acquire.make({ point })),
            ),
            Effect.andThen(handleAcquireResponse),
          ),
        query: (query) =>
          guardState("Acquired").pipe(
            Effect.andThen(Ref.set(state, "Querying")),
            Effect.andThen(sendMessage(Schemas.LocalStateQueryMessage.cases.Query.make({ query }))),
            Effect.andThen(requireReply(messages, makeError, "query")),
            Effect.tap(() => Ref.set(state, "Acquired")),
            Effect.flatMap((v) =>
              Schemas.LocalStateQueryMessage.guards.Result(v)
                ? Effect.succeed(v.result)
                : unexpected(v._tag),
            ),
          ),
        reAcquire: (point?) =>
          guardState("Acquired").pipe(
            Effect.andThen(Ref.set(state, "Acquiring")),
            Effect.andThen(
              sendMessage(Schemas.LocalStateQueryMessage.cases.ReAcquire.make({ point })),
            ),
            Effect.andThen(handleAcquireResponse),
          ),
        release: () =>
          guardState("Acquired").pipe(
            Effect.andThen(sendMessage(Schemas.LocalStateQueryMessage.cases.Release.make({}))),
            Effect.andThen(Ref.set(state, "Idle")),
          ),
        done: () =>
          guardState("Idle").pipe(
            Effect.andThen(sendMessage(Schemas.LocalStateQueryMessage.cases.Done.make({}))),
            Effect.andThen(Ref.set(state, "Done")),
          ),
      });
    }),
  );
}
