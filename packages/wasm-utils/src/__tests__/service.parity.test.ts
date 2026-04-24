/**
 * Cross-layer parity regression — the `Crypto` service must produce
 * byte-identical outputs whether resolved against the in-process
 * `CryptoDirect` layer or the Bun-Worker-backed `CryptoWorkerBun`.
 *
 * Any drift signals a bug in:
 *   - `RpcSerialization.layerMsgPack` round-trip
 *   - `Transferable.schema` zero-copy pickling (ArrayBuffer hand-off)
 *   - worker-side `initWasm` bootstrap
 *   - raw wasm-bindgen argument marshalling
 */
import { describe, expect, layer } from "@effect/vitest";
import { Context, Effect, Equal, Layer } from "effect";
import * as FastCheck from "effect/testing/FastCheck";

import {
  Crypto,
  CryptoDirect,
  ed25519_public_key,
  ed25519_secret_key_from_seed,
  ed25519_sign,
} from "../index.ts";
// `CryptoWorkerBun` lives at the Bun-specific subpath so the default barrel
// stays free of `@effect/platform-bun` imports (browser compatibility).
import { CryptoWorkerBun } from "../rpc/bun.ts";

// Two distinct Service tags, each re-wired to one backend. Lets a single
// test body yield *both* services without resolving the same Crypto tag
// twice with ambiguous precedence.
class CryptoDirectTag extends Context.Service<CryptoDirectTag, Crypto["Service"]>()(
  "wasm-utils/test/CryptoDirectTag",
) {}
class CryptoWorkerTag extends Context.Service<CryptoWorkerTag, Crypto["Service"]>()(
  "wasm-utils/test/CryptoWorkerTag",
) {}

const CryptoDirectTagLive: Layer.Layer<CryptoDirectTag> = Layer.effect(
  CryptoDirectTag,
  Effect.service(Crypto),
).pipe(Layer.provide(CryptoDirect));

const CryptoWorkerTagLive: Layer.Layer<CryptoWorkerTag> = Layer.effect(
  CryptoWorkerTag,
  Effect.service(Crypto),
).pipe(Layer.provide(CryptoWorkerBun), Layer.orDie);

const Pair: Layer.Layer<CryptoDirectTag | CryptoWorkerTag> = Layer.mergeAll(
  CryptoDirectTagLive,
  CryptoWorkerTagLive,
);

const payload = FastCheck.uint8Array({ minLength: 1, maxLength: 512 });
const seed32 = FastCheck.uint8Array({ minLength: 32, maxLength: 32 });

// Draft03 IETF test vector #2 — canonical interop values ported from
// libsodium's `vrf_03.c` harness; used here as a known-good VRF input so
// we can compare the raw 64-byte beta output across both layers.
const hexToBytes = (h: string): Uint8Array => {
  const clean = h.replace(/\s/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
const VRF_PK_HEX = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const VRF_MSG_HEX = "72";
const VRF_PROOF_HEX =
  "ae5b66bdf04b4c010bfe32b2fc126ead2107b697634f6f7337b9bff8785ee111" +
  "200095ece87dde4dbe87343f6df3b107d91798c8a7eb1245d3bb9c5aafb09335" +
  "8c13e6ae1111a55717e895fd15f99f07";
// Each call produces a freshly-allocated `Uint8Array` — the worker path
// uses `Transferable.schema`, which *detaches* the source buffer when the
// payload crosses the Worker boundary. Sharing a single module-level
// constant across tests causes "ArrayBuffer detached" failures once the
// first worker call transfers it away.
const vrfPk = () => hexToBytes(VRF_PK_HEX);
const vrfMsg = () => hexToBytes(VRF_MSG_HEX);
const vrfProof = () => hexToBytes(VRF_PROOF_HEX);

// `check_vrf_leader` takes a 64-byte (128-hex-char) VRF output string.
const vrfOutputHex = (bytes: Uint8Array): string => {
  const padded = new Uint8Array(64);
  padded.set(bytes.slice(0, 64), 0);
  return Array.from(padded, (b) => b.toString(16).padStart(2, "0")).join("");
};

layer(Pair)("Crypto parity — CryptoDirect vs CryptoWorkerBun", (it) => {
  describe("blake2b256", () => {
    it.effect.prop(
      "byte-identical 32-byte digest",
      [payload],
      ([data]) =>
        Effect.gen(function* () {
          const direct = yield* CryptoDirectTag;
          const worker = yield* CryptoWorkerTag;
          const a = yield* direct.blake2b256(data);
          const b = yield* worker.blake2b256(data);
          expect(a.byteLength).toBe(32);
          expect(b.byteLength).toBe(32);
          expect(Equal.equals(a, b)).toBe(true);
        }),
      { fastCheck: { numRuns: 40 } },
    );
  });

  describe("ed25519Verify", () => {
    it.effect.prop(
      "agrees on the positive branch (valid sign+verify)",
      [seed32, payload],
      ([seed, message]) =>
        Effect.gen(function* () {
          const direct = yield* CryptoDirectTag;
          const worker = yield* CryptoWorkerTag;
          const sk = ed25519_secret_key_from_seed(seed);
          const pk = ed25519_public_key(sk);
          const sig = ed25519_sign(message, sk);
          const a = yield* direct.ed25519Verify(message, sig, pk);
          const b = yield* worker.ed25519Verify(message, sig, pk);
          expect(a).toBe(true);
          expect(b).toBe(true);
        }),
      { fastCheck: { numRuns: 30 } },
    );

    it.effect.prop(
      "agrees on the negative branch (tampered signature)",
      [seed32, payload, FastCheck.integer({ min: 0, max: 63 })],
      ([seed, message, flipIndex]) =>
        Effect.gen(function* () {
          const direct = yield* CryptoDirectTag;
          const worker = yield* CryptoWorkerTag;
          const sk = ed25519_secret_key_from_seed(seed);
          const pk = ed25519_public_key(sk);
          const sig = ed25519_sign(message, sk);
          const tampered = new Uint8Array(sig);
          tampered[flipIndex] = (tampered[flipIndex] ?? 0) ^ 0x80;
          const a = yield* direct.ed25519Verify(message, tampered, pk);
          const b = yield* worker.ed25519Verify(message, tampered, pk);
          expect(a).toBe(false);
          expect(b).toBe(false);
        }),
      { fastCheck: { numRuns: 30 } },
    );
  });

  describe("vrfVerifyProof", () => {
    it.effect("byte-identical 64-byte beta for the Draft03 vector-2 proof", () =>
      Effect.gen(function* () {
        const direct = yield* CryptoDirectTag;
        const worker = yield* CryptoWorkerTag;
        const a = yield* direct.vrfVerifyProof(vrfPk(), vrfProof(), vrfMsg());
        const b = yield* worker.vrfVerifyProof(vrfPk(), vrfProof(), vrfMsg());
        expect(a.byteLength).toBe(64);
        expect(b.byteLength).toBe(64);
        expect(Equal.equals(a, b)).toBe(true);
      }),
    );
  });

  describe("vrfProofToHash", () => {
    it.effect("byte-identical hash for the Draft03 vector-2 proof", () =>
      Effect.gen(function* () {
        const direct = yield* CryptoDirectTag;
        const worker = yield* CryptoWorkerTag;
        const a = yield* direct.vrfProofToHash(vrfProof());
        const b = yield* worker.vrfProofToHash(vrfProof());
        expect(a.byteLength).toBe(64);
        expect(b.byteLength).toBe(64);
        expect(Equal.equals(a, b)).toBe(true);
      }),
    );
  });

  describe("checkVrfLeader", () => {
    const positiveFraction = FastCheck.tuple(
      FastCheck.integer({ min: 1, max: 1_000_000 }),
      FastCheck.integer({ min: 1, max: 1_000_000 }),
    );

    it.effect.prop(
      "agrees on random stake / active-slot coefficient fractions",
      [FastCheck.uint8Array({ minLength: 64, maxLength: 64 }), positiveFraction, positiveFraction],
      ([vrfOut, [sn, sd], [cn, cd]]) =>
        Effect.gen(function* () {
          const direct = yield* CryptoDirectTag;
          const worker = yield* CryptoWorkerTag;
          const hex = vrfOutputHex(vrfOut);
          const [sns, sds, cns, cds] = [sn, sd, cn, cd].map(String);
          const a = yield* direct
            .checkVrfLeader(hex, sns!, sds!, cns!, cds!)
            .pipe(Effect.option);
          const b = yield* worker
            .checkVrfLeader(hex, sns!, sds!, cns!, cds!)
            .pipe(Effect.option);
          expect(a).toEqual(b);
        }),
      { fastCheck: { numRuns: 20 } },
    );
  });
});
