/**
 * wasm-plexer barrel — Ouroboros multiplexer framing.
 *
 * Preferred API: `MuxFraming` + `FrameBuffer` services.
 * Raw wasm-bindgen exports re-exported for back-compat with legacy
 * consumers; new code should go through the services.
 */

export * from "./errors.ts";
export * from "./schemas.ts";
export * from "./service.ts";

export {
  FramingError,
  MultiplexerBuffer,
  unwrap_multiplexer_message,
  wrap_multiplexer_message,
} from "../result/wasm_plexer.js";
