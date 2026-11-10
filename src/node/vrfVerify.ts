/**
 * The single implementation of "verify one header's crypto", shared by the inline path and the worker.
 * Keeping it in one module is the point: the pool cannot invent a second opinion.
 */
import { parseHeaderCrypto, verifyHeaderCrypto, type HeaderCryptoResult } from "./headerVerify";

export interface VrfTask {
    headerBytes: Uint8Array;
    eraTag: number;
    nonce: Uint8Array;
    slotsPerKESPeriod: number;
    maxKESEvolutions: number;
}

export type HeaderVerdict = Pick<HeaderCryptoResult, "opcertOk" | "kesOk" | "vrfOk" | "detail">;

/** Verify on the calling thread. The reference behaviour every other path must match. */
export function verifyHeaderTask(task: VrfTask): HeaderVerdict {
    const hc = parseHeaderCrypto(task.headerBytes, task.eraTag);
    const r = verifyHeaderCrypto(hc, task.nonce, task.slotsPerKESPeriod, task.maxKESEvolutions);
    return { opcertOk: r.opcertOk, kesOk: r.kesOk, vrfOk: r.vrfOk, detail: r.detail };
}
