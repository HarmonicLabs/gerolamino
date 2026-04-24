/**
 * `TypedChannel` — a type-safe Ouroboros mini-protocol driver.
 *
 * Mini-protocols are finite state machines where each state has an "owner"
 * (the party with agency to send the next message). Given a transition
 * table (`agency.ts`) and a `Bearer`, this module exposes `send` / `recv`
 * that refuse — at compile time — to do the wrong thing from a given
 * state: `send` is only callable when the current state's agency matches
 * the caller's side, and `recv` is only callable when the other side has
 * agency.
 *
 * Encoding: each `Transition.message` is a `Schema.Codec<Msg, Uint8Array>`.
 * Decode on receipt uses a pre-computed per-state transition index so
 * dispatch is O(outgoing-edges) per frame instead of O(total-transitions).
 * The first transition whose codec parses wins — well-formed protocols
 * have exactly one matching tag per inbound chunk, so iteration order is
 * immaterial.
 */
import { Effect, HashMap, Option, Ref, Schema, Stream } from "effect";

import { type Agency, type ProtocolState, type Transition } from "./agency.ts";
import { type BearerError, Bearer } from "./bearer.ts";

/** Which side of the protocol we represent. */
export type ProtocolSide = "Client" | "Server";

/** Operation tag for all `TypedChannelError`s. */
const TypedChannelOp = Schema.Literals(["send", "recv", "state"]);
type TypedChannelOp = typeof TypedChannelOp.Type;

export class TypedChannelError extends Schema.TaggedErrorClass<TypedChannelError>()(
  "miniprotocols/TypedChannelError",
  {
    op: TypedChannelOp,
    reason: Schema.String,
  },
) {}

const fail = (op: TypedChannelOp, reason: string): Effect.Effect<never, TypedChannelError> =>
  Effect.fail(new TypedChannelError({ op, reason }));

// ---------------------------------------------------------------------------
// TypedChannel surface
// ---------------------------------------------------------------------------

export interface TypedChannel<Transitions extends ReadonlyArray<Transition<any, any, any>>> {
  readonly transitions: Transitions;
  readonly side: ProtocolSide;
  readonly state: Effect.Effect<ProtocolState<string, Agency>>;
  readonly send: <T extends Extract<Transitions[number], { from: { agency: ProtocolSide } }>>(
    transition: T & { from: { agency: TypedChannel<Transitions>["side"] } },
    message: T extends Transition<any, infer M, any> ? M : never,
  ) => Effect.Effect<void, TypedChannelError | Schema.SchemaError | BearerError, Bearer>;
  readonly recv: <From extends ProtocolState<string, Agency>>(
    from: From,
  ) => Effect.Effect<
    {
      readonly message: unknown;
      readonly nextState: ProtocolState<string, Agency>;
    },
    TypedChannelError | Schema.SchemaError | BearerError,
    Bearer
  >;
}

/**
 * Pre-compute state-name → outgoing-transitions index. Built once at
 * construction; every `recv` resolves candidates in O(1).
 */
const indexTransitions = <Ts extends ReadonlyArray<Transition<any, any, any>>>(
  transitions: Ts,
): HashMap.HashMap<string, ReadonlyArray<Ts[number]>> =>
  transitions.reduce(
    (acc, t) =>
      HashMap.modifyAt(acc, t.from.name, (existing) =>
        Option.some([...Option.getOrElse(existing, (): ReadonlyArray<Ts[number]> => []), t]),
      ),
    HashMap.empty<string, ReadonlyArray<Ts[number]>>(),
  );

/**
 * Try each candidate transition's codec in order; yield the first
 * decoded match. Short-circuits on the first `Some`; the remaining
 * candidates are never touched.
 */
const firstDecodingMatch = <T extends Transition<any, any, any>>(
  candidates: ReadonlyArray<T>,
  chunk: Uint8Array,
): Effect.Effect<Option.Option<{ readonly t: T; readonly value: unknown }>> =>
  Effect.gen(function* () {
    for (const t of candidates) {
      const parsed = yield* Effect.option(Schema.decodeUnknownEffect(t.message)(chunk));
      if (Option.isSome(parsed)) {
        return Option.some<{ readonly t: T; readonly value: unknown }>({
          t,
          value: parsed.value,
        });
      }
    }
    return Option.none<{ readonly t: T; readonly value: unknown }>();
  });

/**
 * Read exactly one chunk off the bearer's incoming stream; fail typed if
 * the stream has closed.
 */
const readNextChunk: Effect.Effect<Uint8Array, TypedChannelError | BearerError, Bearer> =
  Effect.gen(function* () {
    const bearer = yield* Bearer;
    const head = yield* Stream.runHead(bearer.incoming);
    return yield* Option.match(head, {
      onNone: () => fail("recv", "bearer closed before message"),
      onSome: Effect.succeed,
    });
  });

/**
 * Construct a `TypedChannel` bound to the supplied transition table.
 * `initialState` must reference one of the vertices named in
 * `transitions` — callers typically pass the agreed "start" state
 * (e.g. `state_Idle` for ChainSync, `state_Propose` for Handshake).
 */
export const make = <Transitions extends ReadonlyArray<Transition<any, any, any>>>(options: {
  readonly transitions: Transitions;
  readonly side: ProtocolSide;
  readonly initialState: ProtocolState<string, Agency>;
}): Effect.Effect<TypedChannel<Transitions>, never, never> =>
  Effect.gen(function* () {
    const cursor = yield* Ref.make<ProtocolState<string, Agency>>(options.initialState);
    const byState = indexTransitions(options.transitions);

    const candidatesFor = (s: ProtocolState<string, Agency>): ReadonlyArray<Transitions[number]> =>
      Option.getOrElse(HashMap.get(byState, s.name), (): ReadonlyArray<Transitions[number]> => []);

    const send: TypedChannel<Transitions>["send"] = (transition, message) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(cursor);
        // Compile-time agency checks already prevent most misuse; the
        // runtime guards catch a desync cursor (unexpected reply flipped
        // agency, test harness injected a bad state, etc.).
        if (current.name !== transition.from.name) {
          return yield* fail(
            "send",
            `cannot send from '${current.name}': transition leaves from '${transition.from.name}'`,
          );
        }
        if (current.agency !== options.side) {
          return yield* fail(
            "send",
            `no agency: current state '${current.name}' has agency '${current.agency}', we are '${options.side}'`,
          );
        }
        const bearer = yield* Bearer;
        const bytes = yield* Schema.encodeUnknownEffect(transition.message)(message);
        yield* bearer.send(bytes);
        yield* Ref.set(cursor, transition.to);
      });

    const recv: TypedChannel<Transitions>["recv"] = (from) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(cursor);
        if (current.name !== from.name) {
          return yield* fail(
            "recv",
            `cursor at '${current.name}' but caller expected '${from.name}'`,
          );
        }
        if (current.agency === options.side) {
          return yield* fail(
            "recv",
            `we (${options.side}) have agency at '${current.name}' — recv would deadlock`,
          );
        }
        if (current.agency === "Neither") {
          return yield* fail(
            "recv",
            `'${current.name}' is terminal (Neither agency) — no inbound to await`,
          );
        }

        const chunk = yield* readNextChunk;
        const hit = yield* firstDecodingMatch(candidatesFor(current), chunk);
        return yield* Option.match(hit, {
          onNone: () => fail("recv", `no transition from '${current.name}' matches inbound bytes`),
          onSome: ({ t, value }) =>
            Ref.set(cursor, t.to).pipe(Effect.as({ message: value, nextState: t.to })),
        });
      });

    return {
      transitions: options.transitions,
      side: options.side,
      state: Ref.get(cursor),
      send,
      recv,
    };
  });
