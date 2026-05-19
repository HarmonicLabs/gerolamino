/**
 * Property tests for the Praos nonce-evolution primitives.
 *
 * Sister to wave-35's example-based `nonce.test.ts`. Adds fast-check
 * coverage of:
 *
 *   - **Determinism**: `evolveNonce(η, y)` over arbitrary 32-byte η and y
 *     yields the same 32-byte output across repeated calls.
 *   - **Strong injectivity (current nonce held)**: distinct VRF outputs
 *     produce distinct evolved nonces. With probability ~1 - 2^{-256}
 *     the blake2b digests differ for distinct preimages — pinning this
 *     guards against a regression that accidentally normalised inputs
 *     before hashing.
 *   - **Strong injectivity (VRF output held)**: distinct current nonces
 *     produce distinct evolved nonces.
 *   - Same properties for `deriveEpochNonce(candidate, parentHash)`.
 */
import { describe, expect, it, layer } from "@effect/vitest";
import { Effect, Equal } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { CryptoDirect } from "wasm-utils/service.ts";

import { evolveNonce, deriveEpochNonce } from "../praos/nonce.ts";

const NUM_RUNS = 200;
const arb32 = FastCheck.uint8Array({ minLength: 32, maxLength: 32 });

const distinctPair = (a: Uint8Array, b: Uint8Array): boolean =>
  !a.every((v, i) => v === b[i]);

layer(CryptoDirect)("nonce evolution — property tests", (it) => {
  describe("evolveNonce", () => {
    it.effect("output length is always exactly 32 bytes", () =>
      Effect.gen(function* () {
        // FastCheck-driven Effect property — collect arbitraries by
        // generating a fixed sample inside the Effect (effect/testing
        // FastCheck integration uses synchronous predicates, but the
        // inner call is Effect-typed, so we sample N random pairs and
        // assert each via yield* inside a forEach).
        const samples = FastCheck.sample(FastCheck.tuple(arb32, arb32), NUM_RUNS);
        for (const [n, v] of samples) {
          const out = yield* evolveNonce(n, v);
          expect(out.length).toBe(32);
        }
      }),
    );

    it.effect("is deterministic across distinct random pairs", () =>
      Effect.gen(function* () {
        const samples = FastCheck.sample(FastCheck.tuple(arb32, arb32), NUM_RUNS);
        for (const [n, v] of samples) {
          const a = yield* evolveNonce(n, v);
          const b = yield* evolveNonce(n, v);
          expect(Equal.equals(a, b)).toBe(true);
        }
      }),
    );

    it.effect("distinct VRF outputs (fixed nonce) produce distinct evolved nonces", () =>
      Effect.gen(function* () {
        // Sample 100 (nonce, vrf1, vrf2) triples; for each non-equal
        // (vrf1, vrf2) pair, assert evolveNonce yields distinct outputs.
        const samples = FastCheck.sample(
          FastCheck.tuple(arb32, arb32, arb32),
          100,
        );
        for (const [n, v1, v2] of samples) {
          if (!distinctPair(v1, v2)) continue; // skip rare equal pair
          const o1 = yield* evolveNonce(n, v1);
          const o2 = yield* evolveNonce(n, v2);
          expect(Equal.equals(o1, o2)).toBe(false);
        }
      }),
    );

    it.effect("distinct current nonces (fixed VRF) produce distinct evolved nonces", () =>
      Effect.gen(function* () {
        const samples = FastCheck.sample(
          FastCheck.tuple(arb32, arb32, arb32),
          100,
        );
        for (const [n1, n2, v] of samples) {
          if (!distinctPair(n1, n2)) continue;
          const o1 = yield* evolveNonce(n1, v);
          const o2 = yield* evolveNonce(n2, v);
          expect(Equal.equals(o1, o2)).toBe(false);
        }
      }),
    );
  });

  describe("deriveEpochNonce", () => {
    it.effect("output length is always exactly 32 bytes", () =>
      Effect.gen(function* () {
        const samples = FastCheck.sample(FastCheck.tuple(arb32, arb32), NUM_RUNS);
        for (const [c, p] of samples) {
          const out = yield* deriveEpochNonce(c, p);
          expect(out.length).toBe(32);
        }
      }),
    );

    it.effect("is deterministic across distinct random pairs", () =>
      Effect.gen(function* () {
        const samples = FastCheck.sample(FastCheck.tuple(arb32, arb32), NUM_RUNS);
        for (const [c, p] of samples) {
          const a = yield* deriveEpochNonce(c, p);
          const b = yield* deriveEpochNonce(c, p);
          expect(Equal.equals(a, b)).toBe(true);
        }
      }),
    );

    it.effect("distinct parent hashes (fixed candidate) produce distinct epoch nonces", () =>
      Effect.gen(function* () {
        const samples = FastCheck.sample(
          FastCheck.tuple(arb32, arb32, arb32),
          100,
        );
        for (const [c, p1, p2] of samples) {
          if (!distinctPair(p1, p2)) continue;
          const o1 = yield* deriveEpochNonce(c, p1);
          const o2 = yield* deriveEpochNonce(c, p2);
          expect(Equal.equals(o1, o2)).toBe(false);
        }
      }),
    );

    it.effect("distinct candidates (fixed parent hash) produce distinct epoch nonces", () =>
      Effect.gen(function* () {
        const samples = FastCheck.sample(
          FastCheck.tuple(arb32, arb32, arb32),
          100,
        );
        for (const [c1, c2, p] of samples) {
          if (!distinctPair(c1, c2)) continue;
          const o1 = yield* deriveEpochNonce(c1, p);
          const o2 = yield* deriveEpochNonce(c2, p);
          expect(Equal.equals(o1, o2)).toBe(false);
        }
      }),
    );
  });
});
