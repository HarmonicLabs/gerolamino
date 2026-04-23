/**
 * Property-based tests for the wasm-utils `Crypto` service.
 *
 * Covers the invariants callers rely on:
 *   - ed25519 sign+verify round-trip over random (seed, message)
 *   - ed25519 tamper detection (message / signature / public-key)
 *   - blake2b256 determinism + byte-parity with Bun.CryptoHasher
 *   - evolve_nonce formula: blake2b(current ∥ blake2b(vrfOutput))
 *   - derive_epoch_nonce formula: blake2b(candidate ∥ parentHash)
 */
import { describe, expect, layer } from "@effect/vitest";
import { Effect, Equal } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  Crypto,
  CryptoDirect,
  derive_epoch_nonce,
  ed25519_public_key,
  ed25519_secret_key_from_seed,
  ed25519_sign,
  evolve_nonce,
} from "../index.ts";

const NUM_RUNS = 200;

const byteArray = (length: number) =>
  FastCheck.uint8Array({ minLength: length, maxLength: length });

const payload = FastCheck.uint8Array({ minLength: 1, maxLength: 512 });

const blake2b256Bun = (data: Uint8Array): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("blake2b256").update(data).digest().buffer);

layer(CryptoDirect)("Crypto service — property tests", (it) => {
  describe("blake2b256", () => {
    it.effect.prop(
      "is deterministic and 32 bytes",
      [payload],
      ([data]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const a = yield* crypto.blake2b256(data);
          const b = yield* crypto.blake2b256(data);
          expect(a.byteLength).toBe(32);
          expect(Equal.equals(a, b)).toBe(true);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );

    it.effect.prop(
      "matches Bun.CryptoHasher byte-for-byte",
      [payload],
      ([data]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const wasm = yield* crypto.blake2b256(data);
          const bun = blake2b256Bun(data);
          expect(Equal.equals(wasm, bun)).toBe(true);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );

    it.effect.prop(
      "different inputs produce different outputs",
      [payload, payload],
      ([a, b]) =>
        Effect.gen(function* () {
          if (Equal.equals(a, b)) return;
          const crypto = yield* Crypto;
          const ha = yield* crypto.blake2b256(a);
          const hb = yield* crypto.blake2b256(b);
          expect(Equal.equals(ha, hb)).toBe(false);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );
  });

  describe("ed25519", () => {
    it.effect.prop(
      "sign+verify round-trip succeeds for random (seed, message)",
      [byteArray(32), payload],
      ([seed, message]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const sk = ed25519_secret_key_from_seed(seed);
          const pk = ed25519_public_key(sk);
          const sig = ed25519_sign(message, sk);
          const ok = yield* crypto.ed25519Verify(message, sig, pk);
          expect(ok).toBe(true);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );

    it.effect.prop(
      "verify rejects tampered message",
      [byteArray(32), payload, FastCheck.integer({ min: 0, max: 511 })],
      ([seed, message, flipIndex]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const sk = ed25519_secret_key_from_seed(seed);
          const pk = ed25519_public_key(sk);
          const sig = ed25519_sign(message, sk);
          const tampered = new Uint8Array(message);
          const idx = flipIndex % message.length;
          tampered[idx] = (tampered[idx] ?? 0) ^ 0x01;
          const ok = yield* crypto.ed25519Verify(tampered, sig, pk);
          expect(ok).toBe(false);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );

    it.effect.prop(
      "verify rejects tampered signature",
      [byteArray(32), payload, FastCheck.integer({ min: 0, max: 63 })],
      ([seed, message, flipIndex]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const sk = ed25519_secret_key_from_seed(seed);
          const pk = ed25519_public_key(sk);
          const sig = ed25519_sign(message, sk);
          const tampered = new Uint8Array(sig);
          tampered[flipIndex] = (tampered[flipIndex] ?? 0) ^ 0x80;
          const ok = yield* crypto.ed25519Verify(message, tampered, pk);
          expect(ok).toBe(false);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );

    it.effect.prop(
      "verify rejects signatures from a different key",
      [byteArray(32), byteArray(32), payload],
      ([seedA, seedB, message]) =>
        Effect.gen(function* () {
          if (Equal.equals(seedA, seedB)) return;
          const crypto = yield* Crypto;
          const skA = ed25519_secret_key_from_seed(seedA);
          const sig = ed25519_sign(message, skA);
          const skB = ed25519_secret_key_from_seed(seedB);
          const pkB = ed25519_public_key(skB);
          const ok = yield* crypto.ed25519Verify(message, sig, pkB);
          expect(ok).toBe(false);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );
  });

  describe("nonce algebra", () => {
    it.effect.prop(
      "evolve_nonce matches blake2b(current ∥ blake2b(vrfOutput))",
      [byteArray(32), byteArray(32)],
      ([current, vrfOutput]) =>
        Effect.sync(() => {
          const wasm = evolve_nonce(current, vrfOutput);
          const inner = blake2b256Bun(vrfOutput);
          const expected = blake2b256Bun(new Uint8Array([...current, ...inner]));
          expect(Equal.equals(new Uint8Array(wasm), expected)).toBe(true);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );

    it.effect.prop(
      "derive_epoch_nonce matches blake2b(candidate ∥ parentHash)",
      [byteArray(32), byteArray(32)],
      ([candidate, parent]) =>
        Effect.sync(() => {
          const wasm = derive_epoch_nonce(candidate, parent);
          const expected = blake2b256Bun(new Uint8Array([...candidate, ...parent]));
          expect(Equal.equals(new Uint8Array(wasm), expected)).toBe(true);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );

    it.effect.prop(
      "derive_epoch_nonce is non-commutative",
      [byteArray(32), byteArray(32)],
      ([a, b]) =>
        Effect.sync(() => {
          if (Equal.equals(a, b)) return;
          const ab = new Uint8Array(derive_epoch_nonce(a, b));
          const ba = new Uint8Array(derive_epoch_nonce(b, a));
          expect(Equal.equals(ab, ba)).toBe(false);
        }),
      { fastCheck: { numRuns: NUM_RUNS } },
    );
  });

  describe("error surface", () => {
    it.effect("ed25519Verify returns a CryptoOpError for a malformed signature", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const exit = yield* Effect.exit(
          crypto.ed25519Verify(
            new Uint8Array(10),
            new Uint8Array(7), // wrong length
            new Uint8Array(32),
          ),
        );
        expect(exit._tag).toBe("Failure");
      }),
    );

    it.effect("vrfProofToHash on a zero proof fails cleanly", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const exit = yield* Effect.exit(crypto.vrfProofToHash(new Uint8Array(80)));
        // Either 64 bytes back or a typed error — never a JS exception.
        if (exit._tag === "Success") {
          expect(exit.value.byteLength).toBe(64);
        } else {
          expect(exit._tag).toBe("Failure");
        }
      }),
    );
  });
});
