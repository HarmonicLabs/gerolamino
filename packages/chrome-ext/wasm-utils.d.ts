/**
 * Type declarations for wasm-utils (wasm-bindgen generated JS).
 * The actual .wasm module is loaded at runtime via init().
 */
declare module "wasm-utils" {
  export default function init(): Promise<void>;
  export function blake2b_256(data: Uint8Array): Uint8Array;
  export function ed25519_verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
  export function kes_sum6_verify(signature: Uint8Array, period: number, publicKey: Uint8Array, message: Uint8Array): boolean;
  export function vrf_verify_proof(vrfVkey: Uint8Array, vrfProof: Uint8Array, vrfInput: Uint8Array): Uint8Array;
  export function vrf_proof_to_hash(vrfProof: Uint8Array): Uint8Array;
  export function check_vrf_leader(
    vrfOutputHex: string,
    sigmaNumerator: string,
    sigmaDenominator: string,
    activeSlotCoeffNum: string,
    activeSlotCoeffDen: string,
  ): boolean;
}
