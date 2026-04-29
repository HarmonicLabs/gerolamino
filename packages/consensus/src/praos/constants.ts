/**
 * Shared Praos constants — referenced by `bridges/header.ts`,
 * `validate/header.ts`, and `praos/nonce.ts`. Centralizing here keeps
 * the wire-format magic bytes from drifting across files when the spec
 * evolves (e.g. a future era retags VRF outputs).
 */

/**
 * Babbage+ VRF output domain-separation tags. The leader-tagged output is
 * `blake2b-256(0x4c ∥ proofHash)`, the nonce-tagged output is
 * `blake2b-256(0x4e ∥ proofHash)`. ASCII `'L'` and `'N'` per Haskell
 * `ouroboros-consensus-protocol/.../Praos/VRF.hs:108-109`.
 */
export const VRF_LEADER_TAG = 0x4c;
export const VRF_NONCE_TAG = 0x4e;

/** Pre-allocated 1-byte tag prefixes — every Babbage+ block runs the
 *  tagging concat on the validation hot path, so module-level constants
 *  avoid `new Uint8Array(1)` allocations per call. */
export const VRF_LEADER_TAG_BYTE = new Uint8Array([VRF_LEADER_TAG]);
export const VRF_NONCE_TAG_BYTE = new Uint8Array([VRF_NONCE_TAG]);

/**
 * Denominator used to decompose `activeSlotsCoeff` (a JS `number` like
 * `0.05`) into an exact integer fraction. `coeffNum / COEFF_DENOMINATOR`
 * round-trips for every `f` value Cardano has ever shipped (`0.05` →
 * `50/1000`, `0.04` → `40/1000`, `0.025` → `25/1000`). Higher precision
 * than the older `100`-based decomposition so future fractional `f`
 * values that don't divide `100` (e.g. `0.0125 = 12.5/1000` rounded to
 * `13/1000`) survive without a config-time error.
 *
 * Used in:
 *   - `validate/header.ts` `assertLeaderStake` (VRF leader-threshold check)
 *   - `praos/nonce.ts` `isPastStabilizationWindow` (4k/f slots window)
 */
export const COEFF_DENOMINATOR = 1000;
