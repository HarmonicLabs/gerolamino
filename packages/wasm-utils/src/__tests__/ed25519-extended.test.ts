/**
 * Test-coverage gap (no test file at all) — `ed25519_extended_*`.
 *
 * `ed25519_extended_public_key` and `ed25519_extended_sign` are the
 * BIP-Ed25519 / CIP-3 64-byte extended-secret-key paths used by HD
 * wallets. The 64-byte format is `[scalar(32) || chainCode(32)]` with
 * specific bit tweaks per pallas `SecretKeyExtended::check_structure`:
 *
 *   - `byte[0] & 0b0000_0111 == 0` — lowest 3 bits cleared
 *   - `byte[31] & 0b0100_0000 == 0b0100_0000` — bit 6 set
 *   - `byte[31] & 0b1000_0000 == 0` — bit 7 cleared
 *
 * Without these tests, a regression in pallas-crypto's
 * `extended_to_public` or `sign(msg)` codepath would only surface in
 * production at the point a hardware wallet emits invalid signatures.
 */
import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  CryptoDirect,
  Crypto,
  ed25519_extended_public_key,
  ed25519_extended_sign,
} from "../index.ts";

/** Build a valid extended secret key by clamping arbitrary bytes per
 *  the BIP-Ed25519 bit-tweak rules. */
const clampedExtendedSk = (filler: number): Uint8Array => {
  const bytes = new Uint8Array(64).fill(filler);
  bytes[0] = bytes[0]! & 0b1111_1000;
  bytes[31] = (bytes[31]! & 0b0011_1111) | 0b0100_0000;
  return bytes;
};

layer(CryptoDirect)("ed25519_extended_*", (it) => {
  describe("ed25519_extended_public_key", () => {
    it.effect("returns a 32-byte public key for a valid extended SK", () =>
      Effect.sync(() => {
        const esk = clampedExtendedSk(0x42);
        const pk = ed25519_extended_public_key(esk);
        expect(pk).toBeInstanceOf(Uint8Array);
        expect(pk.length).toBe(32);
      }),
    );

    it.effect("is deterministic — same ESK → same PK", () =>
      Effect.sync(() => {
        const esk = clampedExtendedSk(0x77);
        const pk1 = ed25519_extended_public_key(esk);
        const pk2 = ed25519_extended_public_key(esk);
        expect(pk1).toEqual(pk2);
      }),
    );

    it.effect("different ESKs produce different PKs", () =>
      Effect.sync(() => {
        const pk1 = ed25519_extended_public_key(clampedExtendedSk(0x01));
        const pk2 = ed25519_extended_public_key(clampedExtendedSk(0x02));
        // Astronomically unlikely for two distinct clamped scalars to
        // map to the same point, so a true collision indicates a real bug.
        expect(pk1).not.toEqual(pk2);
      }),
    );

    it.effect("rejects ESK of wrong length (32 bytes)", () =>
      Effect.sync(() => {
        // pallas's wasm-bindgen wrapper raises a CryptoError for bad
        // length — surfaces as a thrown JS error here.
        expect(() =>
          ed25519_extended_public_key(new Uint8Array(32).fill(0x42)),
        ).toThrow();
      }),
    );

    it.effect("rejects ESK that fails the bit-tweak check", () =>
      Effect.sync(() => {
        // 64 random-looking bytes that aren't clamped — bit 7 of byte[31]
        // is set, which violates `byte[31] & 0b1000_0000 == 0`.
        const bad = new Uint8Array(64).fill(0xff);
        expect(() => ed25519_extended_public_key(bad)).toThrow();
      }),
    );
  });

  describe("ed25519_extended_sign", () => {
    it.effect("returns a 64-byte signature", () =>
      Effect.sync(() => {
        const esk = clampedExtendedSk(0x42);
        const sig = ed25519_extended_sign(new Uint8Array([1, 2, 3]), esk);
        expect(sig).toBeInstanceOf(Uint8Array);
        expect(sig.length).toBe(64);
      }),
    );

    it.effect("is deterministic — same (msg, ESK) → same sig", () =>
      Effect.sync(() => {
        const esk = clampedExtendedSk(0x55);
        const msg = new Uint8Array([0xaa, 0xbb, 0xcc]);
        const a = ed25519_extended_sign(msg, esk);
        const b = ed25519_extended_sign(msg, esk);
        expect(a).toEqual(b);
      }),
    );

    it.effect("different messages produce different signatures", () =>
      Effect.sync(() => {
        const esk = clampedExtendedSk(0x33);
        const a = ed25519_extended_sign(new Uint8Array([1]), esk);
        const b = ed25519_extended_sign(new Uint8Array([2]), esk);
        expect(a).not.toEqual(b);
      }),
    );

    it.effect("rejects ESK of wrong length", () =>
      Effect.sync(() => {
        expect(() =>
          ed25519_extended_sign(new Uint8Array([1]), new Uint8Array(32)),
        ).toThrow();
      }),
    );
  });

  describe("sign + verify round-trip", () => {
    // The Crypto service exposes `ed25519Verify` (which goes through the
    // same WASM module). Pair a signature emitted by `extended_sign`
    // with the public key from `extended_public_key` and assert that
    // `ed25519Verify` accepts it.
    it.effect("extended_sign output verifies under extended_public_key", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const esk = clampedExtendedSk(0x99);
        const pk = ed25519_extended_public_key(esk);
        const msg = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
        const sig = ed25519_extended_sign(msg, esk);
        const ok = yield* crypto.ed25519Verify(msg, sig, pk);
        expect(ok).toBe(true);
      }),
    );

    it.effect("verify rejects a tampered message", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const esk = clampedExtendedSk(0x99);
        const pk = ed25519_extended_public_key(esk);
        const msg = new Uint8Array([0x10, 0x20, 0x30]);
        const sig = ed25519_extended_sign(msg, esk);
        const tamperedMsg = new Uint8Array([0x10, 0x20, 0x31]);
        const ok = yield* crypto.ed25519Verify(tamperedMsg, sig, pk);
        expect(ok).toBe(false);
      }),
    );

    it.effect("verify rejects a tampered signature", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const esk = clampedExtendedSk(0x99);
        const pk = ed25519_extended_public_key(esk);
        const msg = new Uint8Array([0x10, 0x20, 0x30]);
        const sig = ed25519_extended_sign(msg, esk);
        const tamperedSig = new Uint8Array(sig);
        tamperedSig[0]! ^= 0x01;
        const ok = yield* crypto.ed25519Verify(msg, tamperedSig, pk);
        expect(ok).toBe(false);
      }),
    );

    it.effect("verify rejects under a different public key", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const esk1 = clampedExtendedSk(0x11);
        const esk2 = clampedExtendedSk(0x22);
        const pk2 = ed25519_extended_public_key(esk2);
        const msg = new Uint8Array([0xaa]);
        const sig = ed25519_extended_sign(msg, esk1); // signed with esk1
        const ok = yield* crypto.ed25519Verify(msg, sig, pk2);
        expect(ok).toBe(false);
      }),
    );
  });
});
