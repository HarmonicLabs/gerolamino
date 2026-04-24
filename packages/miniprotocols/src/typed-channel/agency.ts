/**
 * Agency primitive — TypeScript port of Haskell `typed-protocols`
 * (`~/code/reference/IntersectMBO/ouroboros-network/typed-protocols/`).
 *
 * Every Ouroboros mini-protocol is a finite state machine where each state
 * assigns "agency" (the right to send the next message) to one of three
 * parties: the initiator/client, the responder/server, or neither (terminal
 * states after `MsgDone`). This module encodes agency at the type level so
 * a misplaced `send` / `recv` is a compile error — no runtime guard needed.
 *
 * Research citations:
 *   - Haskell GADT: `typed-protocols/src/Network/TypedProtocol/Core.hs`
 *   - Plan Tier-1 §2a + wave-2 Correction #24 (3-way agency, terminal states
 *     carry `Neither`, not erased).
 */
import { Data, Schema } from "effect";

/**
 * 3-way agency kind. `Neither` denotes a terminal state (reached via
 * `MsgDone` / `MsgClosed`); both parties are prohibited from sending.
 */
export type Agency = "Client" | "Server" | "Neither";

/**
 * A typed protocol state — `name` is a string literal identifying the
 * state machine vertex; `agency` selects which party (if any) may send
 * the next message from this vertex.
 */
export class ProtocolState<
  const State extends string,
  const A extends Agency,
> extends Data.Class<{
  readonly name: State;
  readonly agency: A;
}> {
  static make<const S extends string, const A extends Agency>(
    name: S,
    agency: A,
  ): ProtocolState<S, A> {
    return new ProtocolState<S, A>({ name, agency });
  }
}

/**
 * A labelled transition in a protocol's state machine. `from` is the
 * pre-state (must have non-`Neither` agency — you can't send from a
 * terminal state), `to` is the post-state, `message` is the wire-schema
 * that encodes the transition payload.
 *
 * The `from` agency type determines which side executes the transition:
 *   - `from.agency === "Client"` → client calls `send`, server calls `recv`
 *   - `from.agency === "Server"` → server calls `send`, client calls `recv`
 */
export interface Transition<
  FromState extends ProtocolState<string, "Client" | "Server">,
  Message,
  ToState extends ProtocolState<string, Agency>,
> {
  readonly from: FromState;
  readonly to: ToState;
  /**
   * Wire codec — encodes `Message` to a byte payload, decodes a byte
   * payload to `Message`. Shape matches the existing `cborSyncCodec`
   * consumers (e.g. `Schemas.HandshakeMessageBytes`) so protocols can
   * reuse their current message schemas unchanged.
   */
  readonly message: Schema.Codec<Message, Uint8Array>;
}

/**
 * Narrowing alias — a transition fires by the client.
 */
export type ClientTransition<
  From extends ProtocolState<string, "Client">,
  M,
  To extends ProtocolState<string, Agency>,
> = Transition<From, M, To>;

/**
 * Narrowing alias — a transition fires by the server.
 */
export type ServerTransition<
  From extends ProtocolState<string, "Server">,
  M,
  To extends ProtocolState<string, Agency>,
> = Transition<From, M, To>;
