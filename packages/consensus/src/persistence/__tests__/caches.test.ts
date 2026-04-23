/**
 * `PersistedCache` scaffolding tests for header + VRF caches.
 *
 * Verifies:
 *   - A cache miss invokes the supplied lookup function exactly once.
 *   - A second `get(key)` with byte-identity inputs returns from cache
 *     (lookup fn not called again).
 *   - A persisted miss-result (decode error) is cached too — no repeat
 *     decodes on the same bad input.
 *   - Byte-identity keys with different `Uint8Array` instances still
 *     hash-equal via the hex `primaryKey`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { Persistence } from "effect/unstable/persistence";
import {
  HeaderCache,
  HeaderCacheKey,
  HeaderDecodeError,
  VrfCache,
  VrfCacheKey,
  VrfVerifyError,
  headerCacheLayer,
  vrfCacheLayer,
} from "../caches";

const mkHash = (n: number): Uint8Array => new Uint8Array(32).fill(n);

/**
 * The cache tests use shared module-level counters so the lookup
 * function injected into the Layer at build time stays in sync with
 * what the test body reads — Effect.provide runs the layer builder
 * before the test body, so any closures captured inside the test body
 * (via `yield* Ref.make`) would be invisible to the layer builder.
 */
const headerLookupCalls = { n: 0 };
const headerHits = { n: 0 };

const stubHeader = (hash: Uint8Array) => ({
  slot: BigInt(hash[0]!) * 100n,
  blockNo: BigInt(hash[0]!),
  hash,
  prevHash: new Uint8Array(32),
  issuerVk: new Uint8Array(32),
  vrfVk: new Uint8Array(32),
  vrfProof: new Uint8Array(80),
  vrfOutput: new Uint8Array(32),
  nonceVrfOutput: new Uint8Array(32),
  kesSig: new Uint8Array(64 * 6),
  kesPeriod: 0,
  opcertSig: new Uint8Array(64),
  opcertVkHot: new Uint8Array(32),
  opcertSeqNo: 0,
  opcertKesPeriod: 0,
  bodyHash: new Uint8Array(32),
  bodySize: 42,
  headerBodyCbor: new Uint8Array(128),
});

describe("HeaderCache — PersistedCache scaffold", () => {
  it.effect("dedupes byte-identical keys; different keys each trigger one lookup", () =>
    Effect.gen(function* () {
      headerLookupCalls.n = 0;
      const cache = yield* HeaderCache;
      const key1 = new HeaderCacheKey({ headerHash: mkHash(0xaa) });
      const key2 = new HeaderCacheKey({ headerHash: mkHash(0xaa) });
      const key3 = new HeaderCacheKey({ headerHash: mkHash(0xbb) });

      const a = yield* cache.get(key1);
      const b = yield* cache.get(key2);
      const c = yield* cache.get(key3);

      expect(a.slot).toBe(b.slot);
      expect(c.slot).not.toBe(a.slot);
      // Two distinct byte-keys → 2 distinct lookups (deduped per key).
      expect(headerLookupCalls.n).toBe(2);
    }).pipe(
      Effect.provide(
        headerCacheLayer((hash) => {
          headerLookupCalls.n += 1;
          return hash.length === 32
            ? Effect.succeed(stubHeader(hash))
            : Effect.fail(new HeaderDecodeError({ reason: "bad length" }));
        }),
      ),
      Effect.provide(Persistence.layerMemory),
    ),
  );
});

const vrfOkCalls = { n: 0 };
const vrfBadCalls = { n: 0 };

describe("VrfCache — PersistedCache scaffold", () => {
  it.effect("dedupes identical (pk, proof, msg) triples", () =>
    Effect.gen(function* () {
      vrfOkCalls.n = 0;
      const cache = yield* VrfCache;
      const pk = new Uint8Array(32).fill(1);
      const proof = new Uint8Array(80).fill(2);
      const msg = new Uint8Array(16).fill(3);

      const key = new VrfCacheKey({ publicKey: pk, proof, message: msg });
      const keyDup = new VrfCacheKey({
        publicKey: new Uint8Array(32).fill(1),
        proof: new Uint8Array(80).fill(2),
        message: new Uint8Array(16).fill(3),
      });

      const first = yield* cache.get(key);
      const second = yield* cache.get(keyDup);

      expect(first[0]).toBe(second[0]);
      expect(vrfOkCalls.n).toBe(1);
    }).pipe(
      Effect.provide(
        vrfCacheLayer((pk, proof) => {
          vrfOkCalls.n += 1;
          const out = new Uint8Array(64);
          out[0] = (pk[0]! ^ proof[0]!) & 0xff;
          return Effect.succeed(out);
        }),
      ),
      Effect.provide(Persistence.layerMemory),
    ),
  );

  it.effect("caches verify failures too — no repeat crypto on known-bad input", () =>
    Effect.gen(function* () {
      vrfBadCalls.n = 0;
      const cache = yield* VrfCache;
      const key = new VrfCacheKey({
        publicKey: new Uint8Array(32).fill(0xde),
        proof: new Uint8Array(80).fill(0xad),
        message: new Uint8Array(8).fill(0xbe),
      });

      const first = yield* Effect.flip(cache.get(key));
      const second = yield* Effect.flip(cache.get(key));

      expect(first._tag).toBe("consensus/VrfVerifyError");
      expect(second._tag).toBe("consensus/VrfVerifyError");
      // Second call MUST hit the cache; lookup invocations stay at 1.
      expect(vrfBadCalls.n).toBe(1);
    }).pipe(
      Effect.provide(
        vrfCacheLayer(() => {
          vrfBadCalls.n += 1;
          return Effect.fail(new VrfVerifyError({ reason: "synthetic-bad-proof" }));
        }),
      ),
      Effect.provide(Persistence.layerMemory),
    ),
  );
});
