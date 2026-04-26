/**
 * Persistence-backed caches — `PersistedCache` wrappers for expensive
 * header-decode + VRF-verify operations.
 *
 * Header cache keyed by block-header hash (32 bytes); VRF-output cache
 * keyed by `(publicKey, proof, message)` — the exact same inputs that
 * make VRF verification deterministic. Cache hits skip the WASM VRF
 * verify (~0.4ms/call) + the header CBOR decode (~0.5ms/call), which
 * translates directly to sync-loop throughput at the per-header level.
 *
 * Both caches are fronted by an in-memory LRU (`inMemoryCapacity`) and
 * backed by the `Persistence` service. Consumers compose:
 *
 *     const layer = PersistenceCachesLive.pipe(
 *       Layer.provide(Persistence.layerMemory)        // tests
 *       // Layer.provide(Persistence.layerBackingSql) // apps/bootstrap
 *     )
 *
 * On restart, hits on a persistent backend survive; the in-memory LRU
 * cold-starts empty but refills on demand.
 */
import { Context, Duration, Effect, Equal, Hash, Layer, PrimaryKey, Schema } from "effect";
import { Persistable, PersistedCache, Persistence } from "effect/unstable/persistence";

import { BlockHeader, type BlockHeader as BlockHeaderType } from "../validate/header";

// ---------------------------------------------------------------------------
// Header-hash key
// ---------------------------------------------------------------------------

// `hexOfBytes` was a hand-rolled hex-encode loop — replaced with the
// canonical `hex` helper from codecs (which is the ES2025 native
// `Uint8Array.prototype.toHex`). Identical semantics, ~10× faster.

export class HeaderDecodeError extends Schema.TaggedErrorClass<HeaderDecodeError>()(
  "consensus/HeaderDecodeError",
  { reason: Schema.String },
) {}

/**
 * Cache key for the header-hash→decoded-header cache. The `primaryKey`
 * is the hex-encoded 32-byte block header hash so byte-identity blocks
 * hit the cache regardless of reference-equality.
 */
class HeaderCacheKeyBase extends Persistable.Class<{
  payload: { readonly headerHash: Uint8Array };
}>()("consensus/HeaderCacheKey", {
  primaryKey: (payload) => payload.headerHash.toHex(),
  success: BlockHeader,
  error: HeaderDecodeError,
}) {}

/**
 * Override `Equal` + `Hash` on top of `Persistable.Class`'s default
 * `StructuralProto` — the default keys on field-names, which collapses
 * all instances with `Uint8Array` payloads into a single LRU bucket
 * regardless of byte contents. We key on the `PrimaryKey` string
 * (already derived from the bytes) so byte-distinct keys are treated
 * as distinct, and byte-identical keys hit the cache.
 */
export class HeaderCacheKey extends HeaderCacheKeyBase {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof HeaderCacheKey && PrimaryKey.value(this) === PrimaryKey.value(that);
  }
  [Hash.symbol](): number {
    return Hash.string(PrimaryKey.value(this));
  }
}

// ---------------------------------------------------------------------------
// VRF verify cache key — inputs are (pubkey || proof || message), all
// deterministic, so the VRF output is a pure function of them.
// ---------------------------------------------------------------------------

export class VrfVerifyError extends Schema.TaggedErrorClass<VrfVerifyError>()(
  "consensus/VrfVerifyError",
  { reason: Schema.String },
) {}

class VrfCacheKeyBase extends Persistable.Class<{
  payload: {
    readonly publicKey: Uint8Array;
    readonly proof: Uint8Array;
    readonly message: Uint8Array;
  };
}>()("consensus/VrfCacheKey", {
  primaryKey: (p) => `${p.publicKey.toHex()}:${p.proof.toHex()}:${p.message.toHex()}`,
  success: Schema.Uint8Array,
  error: VrfVerifyError,
}) {}

/** See `HeaderCacheKey` note — structural-equality override for byte payloads. */
export class VrfCacheKey extends VrfCacheKeyBase {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof VrfCacheKey && PrimaryKey.value(this) === PrimaryKey.value(that);
  }
  [Hash.symbol](): number {
    return Hash.string(PrimaryKey.value(this));
  }
}

// ---------------------------------------------------------------------------
// TTL constants — hoisted as module-level `Duration` values so neither the
// `PersistedCache.make` thunk nor the in-memory LRU timer re-constructs them
// on every cache instantiation. Documented rationale:
//
//   Header cache — TTL = 1h covers a full k=2160 rollback window without
//   prematurely evicting hot headers that the sync loop is about to revisit.
//   In-memory TTL = 5min matches the typical chain-sync worker's per-peer
//   batch cadence.
//
//   VRF cache — TTL = 24h so an epoch's (~120h on mainnet / ~2.5h on preprod)
//   leader checks + nonce contributions reuse the same cached outputs.
//   In-memory TTL = 15min matches the window of active per-slot verifications.
// ---------------------------------------------------------------------------

const HEADER_CACHE_TTL = Duration.hours(1);
const HEADER_INMEMORY_TTL = Duration.minutes(5);
const VRF_CACHE_TTL = Duration.hours(24);
const VRF_INMEMORY_TTL = Duration.minutes(15);

// ---------------------------------------------------------------------------
// Services — the cache surfaces consumers yield for
// `.get(key): Effect<Value, Error, ...>`.
// ---------------------------------------------------------------------------

export class HeaderCache extends Context.Service<
  HeaderCache,
  PersistedCache.PersistedCache<HeaderCacheKey>
>()("consensus/HeaderCache") {}

export class VrfCache extends Context.Service<
  VrfCache,
  PersistedCache.PersistedCache<VrfCacheKey>
>()("consensus/VrfCache") {}

// ---------------------------------------------------------------------------
// Factory — lookup functions are injected at layer build time by the
// integration point (consensus/validate/header.ts wires the real CBOR
// decoder; consensus/praos/engine.ts wires the WASM VRF verifier).
// For the default scaffold, both lookups fail loudly so a missing wire
// shows up as a runtime error instead of a silent no-op.
// ---------------------------------------------------------------------------

/**
 * Build a `HeaderCache` layer that calls `decode(hash)` on miss. Caller
 * supplies the decode function; production wiring comes from
 * `validate/header.ts` + `codecs` / `ledger` decoders.
 */
export const headerCacheLayer = (
  decode: (hash: Uint8Array) => Effect.Effect<BlockHeaderType, HeaderDecodeError>,
) =>
  Layer.effect(
    HeaderCache,
    PersistedCache.make((key: HeaderCacheKey) => decode(key.headerHash), {
      storeId: "consensus-header-cache",
      // Plan §3b: recent 1000 headers; k=2160 is the security window.
      timeToLive: () => HEADER_CACHE_TTL,
      inMemoryCapacity: 1024,
      inMemoryTTL: () => HEADER_INMEMORY_TTL,
    }),
  );

/**
 * Build a `VrfCache` layer. Consumer supplies the VRF verify routine
 * (typically bound to `wasm-utils`'s `Crypto.vrfVerify` — the WASM
 * module owns the curve math).
 */
export const vrfCacheLayer = (
  verify: (
    publicKey: Uint8Array,
    proof: Uint8Array,
    message: Uint8Array,
  ) => Effect.Effect<Uint8Array, VrfVerifyError>,
) =>
  Layer.effect(
    VrfCache,
    PersistedCache.make((key: VrfCacheKey) => verify(key.publicKey, key.proof, key.message), {
      storeId: "consensus-vrf-cache",
      timeToLive: () => VRF_CACHE_TTL,
      inMemoryCapacity: 4096,
      inMemoryTTL: () => VRF_INMEMORY_TTL,
    }),
  );

/**
 * `Persistence` service provider — the tests wire memory; apps wire a
 * SQL or Redis backend. Re-exported for call-site convenience.
 */
export const PersistenceLayerMemory = Persistence.layerMemory;
