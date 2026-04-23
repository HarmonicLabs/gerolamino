import { Context, Effect, Layer, Ref, Schema, Scope, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import { Multiplexer } from "../../multiplexer/Multiplexer";
import { MultiplexerEncodingError } from "../../multiplexer/Errors";
import { MiniProtocol } from "../../MiniProtocol";
import { MAX_UNACKED_TX_IDS } from "./limits";
import * as Schemas from "./Schemas";

export class TxSubmissionError extends Schema.TaggedErrorClass<TxSubmissionError>()(
  "TxSubmissionError",
  { cause: Schema.Defect },
) {}

/**
 * Ack-window violation — the peer asked us to acknowledge more ids than
 * are outstanding, OR requested more ids than the window allows. Spec
 * §3.9.2 + `limits.ts:MAX_UNACKED_TX_IDS` mandate disconnect on violation.
 */
export class TxSubmissionAckWindowError extends Schema.TaggedErrorClass<TxSubmissionAckWindowError>()(
  "TxSubmissionAckWindowError",
  {
    reason: Schema.String,
    outstanding: Schema.Number,
    ack: Schema.Number,
    req: Schema.Number,
  },
) {}

export interface TxSubmissionHandlers {
  readonly onRequestTxIds: (
    ack: number,
    req: number,
    blocking: boolean,
  ) => Effect.Effect<ReadonlyArray<Schemas.TxIdAndSize>>;
  readonly onRequestTxs: (
    txIds: ReadonlyArray<Uint8Array>,
  ) => Effect.Effect<ReadonlyArray<Uint8Array>>;
}

const decodeMessage = Schema.decodeUnknownEffect(Schemas.TxSubmissionMessageBytes);
const encodeMessage = Schema.encodeUnknownEffect(Schemas.TxSubmissionMessageBytes);

const unexpected = (tag: string) =>
  Effect.fail(new TxSubmissionError({ cause: `Unexpected server message: ${tag}` }));

export class TxSubmissionClient extends Context.Service<
  TxSubmissionClient,
  {
    run: (
      handlers: TxSubmissionHandlers,
    ) => Effect.Effect<
      void,
      | TxSubmissionError
      | TxSubmissionAckWindowError
      | MultiplexerEncodingError
      | Socket.SocketError
      | Schema.SchemaError,
      Scope.Scope
    >;
    done: () => Effect.Effect<
      void,
      TxSubmissionError | MultiplexerEncodingError | Socket.SocketError | Schema.SchemaError,
      Scope.Scope
    >;
  }
>()("@harmoniclabs/ouroboros-miniprotocols-ts/TxSubmissionClient") {
  static readonly layer = Layer.effect(
    TxSubmissionClient,
    Effect.gen(function* () {
      const multiplexer = yield* Multiplexer;
      const channel = yield* multiplexer.getProtocolChannel(MiniProtocol.TxSubmission);

      const sendMessage = (msg: Schemas.TxSubmissionMessageT) =>
        encodeMessage(msg).pipe(Effect.flatMap(channel.send));

      const messages = Stream.fromPubSub(channel.pubsub).pipe(
        Stream.mapEffect((bytes) => decodeMessage(bytes)),
      );

      // Track outstanding (replied-but-unacknowledged) tx-id count per
      // peer connection. Ack-window enforcement per spec §3.9.2 + the
      // Haskell `txSubmissionMaxUnacked = 10` invariant — violation ⇒
      // protocol error ⇒ disconnect.
      const outstanding = yield* Ref.make(0);

      const enforceAckWindow = (ack: number, req: number) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(outstanding);
          if (ack > current) {
            return yield* Effect.fail(
              new TxSubmissionAckWindowError({
                reason: "peer asked to acknowledge more ids than outstanding",
                outstanding: current,
                ack,
                req,
              }),
            );
          }
          if (current - ack + req > MAX_UNACKED_TX_IDS) {
            return yield* Effect.fail(
              new TxSubmissionAckWindowError({
                reason: `peer requested window > ${MAX_UNACKED_TX_IDS}`,
                outstanding: current,
                ack,
                req,
              }),
            );
          }
          yield* Ref.update(outstanding, (n) => n - ack);
        });

      return TxSubmissionClient.of({
        run: (handlers) =>
          sendMessage({ _tag: Schemas.TxSubmissionMessageType.Init }).pipe(
            Effect.andThen(
              messages.pipe(
                Stream.mapEffect((msg) =>
                  Schemas.TxSubmissionMessage.match(msg, {
                    RequestTxIds: (m) =>
                      enforceAckWindow(m.ack, m.req).pipe(
                        Effect.andThen(handlers.onRequestTxIds(m.ack, m.req, m.blocking)),
                        Effect.flatMap((ids) =>
                          // Tally the outgoing ids BEFORE sending — if the
                          // handler replied with more than `req`, clamp to
                          // `req` and only count what we actually send.
                          Effect.gen(function* () {
                            const capped = ids.slice(0, m.req);
                            yield* Ref.update(outstanding, (n) => n + capped.length);
                            yield* sendMessage({
                              _tag: Schemas.TxSubmissionMessageType.ReplyTxIds,
                              ids: [...capped],
                            });
                          }),
                        ),
                      ),
                    RequestTxs: (m) =>
                      handlers.onRequestTxs(m.txIds).pipe(
                        Effect.flatMap((txs) =>
                          sendMessage({
                            _tag: Schemas.TxSubmissionMessageType.ReplyTxs,
                            txs: [...txs],
                          }),
                        ),
                      ),
                    Done: () => Effect.void,
                    Init: (m) => unexpected(m._tag),
                    ReplyTxIds: (m) => unexpected(m._tag),
                    ReplyTxs: (m) => unexpected(m._tag),
                  }),
                ),
                Stream.runDrain,
              ),
            ),
          ),
        done: () => sendMessage({ _tag: Schemas.TxSubmissionMessageType.Done }),
      });
    }),
  );
}
