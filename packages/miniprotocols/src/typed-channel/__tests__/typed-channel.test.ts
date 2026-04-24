/**
 * Property tests for the `TypedChannel` primitive.
 *
 * We model a tiny two-state ping / pong protocol:
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *               Idle  ──MsgPing──►  Busy
 *               Done  ◄─MsgPong──   Busy
 *               Done  (Neither — terminal)
 *
 * Against this table we assert:
 *   - send from the wrong side fails with `TypedChannelError`
 *   - recv when we have agency fails with `TypedChannelError`
 *   - recv from a terminal state fails with `TypedChannelError`
 *   - a legitimate ping/pong round-trip advances the FSM on both sides
 *     (paired `MockBearer` routes bytes between the two TypedChannels)
 */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

import { MockBearer, ProtocolState, makeTypedChannel } from "../index.ts";
import type { Transition } from "../index.ts";

const state_Idle = ProtocolState.make("Idle", "Client");
const state_Busy = ProtocolState.make("Busy", "Server");
const state_Done = ProtocolState.make("Done", "Neither");

// Single-byte tag codecs — 0x01 = MsgPing, 0x02 = MsgPong.
const msgCodec = <const Msg extends string>(tag: number, name: Msg) =>
  Schema.Uint8Array.pipe(
    Schema.decodeTo(Schema.Literal(name), {
      decode: SchemaGetter.transformOrFail<Uint8Array, Msg>((bytes) =>
        bytes.byteLength === 1 && bytes[0] === tag
          ? Effect.succeed(name)
          : Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(bytes), { message: `not ${name}` }),
            ),
      ),
      encode: SchemaGetter.transform<Msg, Uint8Array>(() => new Uint8Array([tag])),
    }),
  );

const MsgPingCodec = msgCodec(0x01, "MsgPing");
const MsgPongCodec = msgCodec(0x02, "MsgPong");

const tPing: Transition<typeof state_Idle, "MsgPing", typeof state_Busy> = {
  from: state_Idle,
  to: state_Busy,
  message: MsgPingCodec,
};
const tPong: Transition<typeof state_Busy, "MsgPong", typeof state_Done> = {
  from: state_Busy,
  to: state_Done,
  message: MsgPongCodec,
};

const transitions = [tPing, tPong] as const;

const extractError = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) ? failure.value : cause;
};

describe("TypedChannel", () => {
  it.effect("send from Idle with Client agency advances to Busy", () =>
    Effect.gen(function* () {
      const { clientLayer } = yield* MockBearer.pair();
      const ch = yield* makeTypedChannel({
        transitions,
        side: "Client",
        initialState: state_Idle,
      });
      yield* ch.send(tPing, "MsgPing").pipe(Effect.provide(clientLayer));
      const state = yield* ch.state;
      expect(state.name).toBe("Busy");
      expect(state.agency).toBe("Server");
    }),
  );

  it.effect("send fails when wrong side has agency", () =>
    Effect.gen(function* () {
      const { clientLayer } = yield* MockBearer.pair();
      const ch = yield* makeTypedChannel({
        transitions,
        side: "Server",
        initialState: state_Idle,
      });
      const exit = yield* ch.send(tPing, "MsgPing").pipe(Effect.provide(clientLayer), Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = extractError(exit.cause) as { op?: string };
        expect(err.op).toBe("send");
      }
    }),
  );

  it.effect("recv fails when we are the agency holder", () =>
    Effect.gen(function* () {
      const { clientLayer } = yield* MockBearer.pair();
      const ch = yield* makeTypedChannel({
        transitions,
        side: "Client",
        initialState: state_Idle,
      });
      const exit = yield* ch.recv(state_Idle).pipe(Effect.provide(clientLayer), Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = extractError(exit.cause) as { op?: string };
        expect(err.op).toBe("recv");
      }
    }),
  );

  it.effect("recv from a Neither terminal state fails", () =>
    Effect.gen(function* () {
      const { clientLayer } = yield* MockBearer.pair();
      const ch = yield* makeTypedChannel({
        transitions,
        side: "Client",
        initialState: state_Done,
      });
      const exit = yield* ch.recv(state_Done).pipe(Effect.provide(clientLayer), Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = extractError(exit.cause) as { op?: string };
        expect(err.op).toBe("recv");
      }
    }),
  );

  it.effect("paired client + server complete a ping/pong round-trip", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions,
        side: "Client",
        initialState: state_Idle,
      });
      const server = yield* makeTypedChannel({
        transitions,
        side: "Server",
        initialState: state_Idle,
      });

      yield* client.send(tPing, "MsgPing").pipe(Effect.provide(clientLayer));
      const heardPing = yield* server.recv(state_Idle).pipe(Effect.provide(serverLayer));
      expect(heardPing.message).toBe("MsgPing");
      expect(heardPing.nextState.name).toBe("Busy");

      yield* server.send(tPong, "MsgPong").pipe(Effect.provide(serverLayer));
      const heardPong = yield* client.recv(state_Busy).pipe(Effect.provide(clientLayer));
      expect(heardPong.message).toBe("MsgPong");
      expect(heardPong.nextState.name).toBe("Done");
      expect(heardPong.nextState.agency).toBe("Neither");

      expect((yield* client.state).name).toBe("Done");
      expect((yield* server.state).name).toBe("Done");
    }),
  );
});
