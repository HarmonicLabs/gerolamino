/**
 * Bun implements `Uint8Array.prototype.toBuffer`; the @types/bun shipping now omits it from
 * its `Uint8Array` augmentation. Declare it once here so the project's `tsc` gate sees what
 * Bun actually provides at runtime.
 */
declare global {
    interface Uint8Array<A extends ArrayBufferLike = ArrayBufferLike> {
        toBuffer(): Buffer;
    }
}

export {};
