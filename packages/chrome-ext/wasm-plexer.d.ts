/**
 * Type declarations for wasm-plexer (wasm-bindgen generated JS).
 * The actual .wasm module provides the Ouroboros multiplexer.
 */
declare module "wasm-plexer" {
  export class MultiplexerBuffer {
    constructor();
    free(): void;
    append_chunk(data: Uint8Array): void;
    process_frames(): unknown;
    buffer_len(): number;
  }

  export function wrap_multiplexer_message(
    data: Uint8Array,
    miniProtocol: number,
    isResponder: boolean,
  ): Uint8Array;
  export function unwrap_multiplexer_message(data: Uint8Array): unknown;
}
