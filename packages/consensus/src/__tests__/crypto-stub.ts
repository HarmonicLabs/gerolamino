import { Effect, Layer } from "effect";
import { Crypto } from "wasm-utils";

const stubHash = (data: Uint8Array): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("blake2b256").update(data).digest().buffer);

export const CryptoStub: Layer.Layer<Crypto> = Layer.succeed(Crypto, {
  blake2b256: (data) => Effect.succeed(stubHash(data)),
  ed25519Verify: () => Effect.succeed(true),
  kesSum6Verify: () => Effect.succeed(true),
  checkVrfLeader: () => Effect.succeed(true),
  vrfVerifyProof: () => Effect.succeed(new Uint8Array(64)),
  vrfProofToHash: () => Effect.succeed(new Uint8Array(64)),
});
