/**
 * IETF ECVRF-ED25519-SHA512-Elligator2 Draft-03 test vectors.
 *
 * Ported from libsodium's reference test harness:
 *   ~/code/reference/libsodium/test/default/vrf_03.c
 *   ~/code/reference/libsodium/test/default/vrf_03.exp
 *
 * These three vectors are the canonical Draft-03 interop vectors; the Rust
 * `vrf_verify_proof` wrapper uses the same `vrf_input` bytes as the VRF
 * alpha_string, so they apply directly without Cardano-specific tagging.
 */
import { describe, expect, layer } from "@effect/vitest";
import { Effect, Equal } from "effect";

import { Crypto, CryptoDirect } from "../index.ts";

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.replace(/\s/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

type Vector = {
  readonly name: string;
  readonly pk: string;
  readonly message: string;
  readonly proof: string;
  readonly output: string;
};

const vectors: ReadonlyArray<Vector> = [
  {
    name: "vector 1 — empty message",
    pk: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    proof:
      "b6b4699f87d56126c9117a7da55bd0085246f4c56dbc95d20172612e9d38e8d7ca65e573a126ed88d4e30a46f80a666854d675cf3ba81de0de043c3774f061560f55edc256a787afe701677c0f602900",
    output:
      "5b49b554d05c0cd5a5325376b3387de59d924fd1e13ded44648ab33c21349a603f25b84ec5ed887995b33da5e3bfcb87cd2f64521c4c62cf825cffabbe5d31cc",
  },
  {
    name: "vector 2 — one-byte message 0x72",
    pk: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    proof:
      "ae5b66bdf04b4c010bfe32b2fc126ead2107b697634f6f7337b9bff8785ee111200095ece87dde4dbe87343f6df3b107d91798c8a7eb1245d3bb9c5aafb093358c13e6ae1111a55717e895fd15f99f07",
    output:
      "94f4487e1b2fec954309ef1289ecb2e15043a2461ecc7b2ae7d4470607ef82eb1cfa97d84991fe4a7bfdfd715606bc27e2967a6c557cfb5875879b671740b7d8",
  },
  {
    name: "vector 3 — two-byte message 0xaf82",
    pk: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    message: "af82",
    proof:
      "dfa2cba34b611cc8c833a6ea83b8eb1bb5e2ef2dd1b0c481bc42ff36ae7847f6ab52b976cfd5def172fa412defde270c8b8bdfbaae1c7ece17d9833b1bcf31064fff78ef493f820055b561ece45e1009",
    output:
      "2031837f582cd17a9af9e0c7ef5a6540e3453ed894b62c293686ca3c1e319dde9d0aa489a4b59a9594fc2328bc3deff3c8a0929a369a72b1180a596e016b5ded",
  },
];

// Tamper positions from vrf_03.c: gamma (byte 0), c (byte 32), s (byte 48),
// and high-order bit of the last byte of s (byte 79).
const tamperPositions: ReadonlyArray<{ readonly label: string; readonly index: number; readonly mask: number }> = [
  { label: "gamma byte 0", index: 0, mask: 0x01 },
  { label: "c byte 32", index: 32, mask: 0x01 },
  { label: "s byte 48", index: 48, mask: 0x01 },
  { label: "high bit of byte 79", index: 79, mask: 0x80 },
];

layer(CryptoDirect)("VRF Draft-03 IETF vectors (libsodium vrf_03)", (it) => {
  for (const v of vectors) {
    describe(v.name, () => {
      const pk = hexToBytes(v.pk);
      const message = hexToBytes(v.message);
      const proof = hexToBytes(v.proof);
      const expected = hexToBytes(v.output);

      it.effect("vrfVerifyProof returns the expected 64-byte beta", () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const beta = yield* crypto.vrfVerifyProof(pk, proof, message);
          expect(beta.byteLength).toBe(64);
          expect(Equal.equals(beta, expected)).toBe(true);
        }),
      );

      it.effect("vrfProofToHash matches the verified beta", () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const beta = yield* crypto.vrfProofToHash(proof);
          expect(Equal.equals(beta, expected)).toBe(true);
        }),
      );

      for (const t of tamperPositions) {
        it.effect(`tampering ${t.label} causes verify to fail`, () =>
          Effect.gen(function* () {
            const crypto = yield* Crypto;
            const bad = new Uint8Array(proof);
            bad[t.index] = (bad[t.index] ?? 0) ^ t.mask;
            const exit = yield* Effect.exit(crypto.vrfVerifyProof(pk, bad, message));
            expect(exit._tag).toBe("Failure");
          }),
        );
      }
    });
  }
});
