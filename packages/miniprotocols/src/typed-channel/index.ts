/**
 * Typed-channel primitive — type-safe Ouroboros mini-protocol driver over
 * an abstract `Bearer`. See individual module docstrings for detail:
 *
 *   - `agency.ts`       — 3-way `Agency` kind + `ProtocolState` + `Transition`
 *   - `bearer.ts`       — `Bearer` service + `MockBearer.pair()` for tests
 *   - `typed-channel.ts` — `TypedChannel.make(...)` + send/recv drivers
 */
export {
  type Agency,
  ProtocolState,
  type Transition,
  type ClientTransition,
  type ServerTransition,
} from "./agency.ts";
export { Bearer, BearerError, MockBearer, type BearerPair } from "./bearer.ts";
export {
  make as makeTypedChannel,
  type TypedChannel,
  type ProtocolSide,
  TypedChannelError,
} from "./typed-channel.ts";
export { filteredCodec } from "./filtered-codec.ts";
