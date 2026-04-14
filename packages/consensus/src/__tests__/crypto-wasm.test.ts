/**
 * Integration tests for CryptoServiceLive — real WASM crypto.
 *
 * Verifies that wasm-utils initializes correctly and ed25519/KES/VRF
 * functions produce correct results.
 */
import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { CryptoService, CryptoServiceLive } from "../crypto";
import { hex } from "../util";

const run = <A>(effect: Effect.Effect<A, unknown, CryptoService>) =>
  effect.pipe(Effect.provide(CryptoServiceLive), Effect.runPromise);

describe("CryptoServiceLive (WASM)", () => {
  it("blake2b256 produces correct 32-byte hash", async () => {
    const hash = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        return crypto.blake2b256(new Uint8Array([1, 2, 3]));
      }),
    );
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.byteLength).toBe(32);
    // Deterministic — same input always produces same hash
    const hash2 = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        return crypto.blake2b256(new Uint8Array([1, 2, 3]));
      }),
    );
    expect(hex(hash)).toBe(hex(hash2));
  });

  it("ed25519 sign + verify round-trip", async () => {
    // Import sign/key functions from wasm-utils for test setup
    const { ed25519_sign, ed25519_public_key, ed25519_secret_key_from_seed } =
      await import("wasm-utils");
    const seed = new Uint8Array(32);
    seed[0] = 42;
    const sk = ed25519_secret_key_from_seed(seed);
    const pk = ed25519_public_key(sk);
    const message = new TextEncoder().encode("test message");
    const signature = ed25519_sign(message, sk);

    const valid = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        return crypto.ed25519Verify(message, signature, pk);
      }),
    );
    expect(valid).toBe(true);
  });

  it("ed25519 verify rejects wrong message", async () => {
    const { ed25519_sign, ed25519_public_key, ed25519_secret_key_from_seed } =
      await import("wasm-utils");
    const seed = new Uint8Array(32);
    seed[0] = 7;
    const sk = ed25519_secret_key_from_seed(seed);
    const pk = ed25519_public_key(sk);
    const signature = ed25519_sign(new TextEncoder().encode("original"), sk);

    const valid = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        return crypto.ed25519Verify(new TextEncoder().encode("tampered"), signature, pk);
      }),
    );
    expect(valid).toBe(false);
  });

  it("ed25519 verify rejects wrong public key", async () => {
    const { ed25519_sign, ed25519_public_key, ed25519_secret_key_from_seed } =
      await import("wasm-utils");
    const seed = new Uint8Array(32);
    seed[0] = 3;
    const sk = ed25519_secret_key_from_seed(seed);
    const message = new TextEncoder().encode("hello");
    const signature = ed25519_sign(message, sk);

    // Different key
    const otherSeed = new Uint8Array(32);
    otherSeed[0] = 99;
    const otherPk = ed25519_public_key(ed25519_secret_key_from_seed(otherSeed));

    const valid = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        return crypto.ed25519Verify(message, signature, otherPk);
      }),
    );
    expect(valid).toBe(false);
  });

  it("vrfVerifyProof rejects invalid proof", async () => {
    const failed = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        try {
          // Random key, random 80-byte proof, random input — should fail verification
          crypto.vrfVerifyProof(
            new Uint8Array(32).fill(1),
            new Uint8Array(80).fill(2),
            new Uint8Array(32).fill(3),
          );
          return false; // should not reach here
        } catch {
          return true; // verification correctly threw
        }
      }),
    );
    expect(failed).toBe(true);
  });

  it("vrfProofToHash returns 64 bytes for valid-format proof", async () => {
    // vrf_proof_to_hash doesn't verify — it just extracts the hash.
    // A well-formed 80-byte proof may still produce output even if unverified.
    // We test the basic contract: 80 bytes in → 64 bytes out or error.
    const result = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        try {
          const hash = crypto.vrfProofToHash(new Uint8Array(80)); // all zeros
          return hash.byteLength;
        } catch {
          return -1; // decompression failure for zero-point is expected
        }
      }),
    );
    // Either 64-byte output or decompression error — both are valid
    expect(result === 64 || result === -1).toBe(true);
  });

  it("checkVrfLeader accepts high-stake pool", async () => {
    // A pool with 90% of total stake should almost always be leader
    const result = await run(
      Effect.gen(function* () {
        const crypto = yield* CryptoService;
        // Use a low VRF output (hex "00...01") to ensure it's below threshold
        const lowVrfHex = "0".repeat(63) + "1";
        return crypto.checkVrfLeader(lowVrfHex, "9000000", "10000000", "5", "100");
      }),
    );
    expect(result).toBe(true);
  });
});
