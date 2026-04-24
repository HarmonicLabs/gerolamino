/**
 * Raw bun:ffi binding for liblsm-bridge.so.
 *
 * The Zig bridge wraps Haskell lsm-ffi exports with a buffer-based API.
 * Owns the dlopen symbol table + typed error + Config key.
 */
import { dlopen, FFIType } from "bun:ffi";
import { Config, Effect, Schema } from "effect";
import type { ConfigError } from "effect/Config";

/** Enumerates every FFI entry point into the Zig → Haskell V2LSM bridge. */
export const LsmBridgeOperation = Schema.Literals([
  "init",
  "init_from_snapshot",
  "get",
  "cursor_open",
  "cursor_read",
  "snapshot",
  "lsm_bridge_put",
  "lsm_bridge_delete",
  "lsm_bridge_get",
  "lsm_bridge_snapshot",
  "snapshot_restore",
  "lsm_session_open",
]);
export type LsmBridgeOperation = typeof LsmBridgeOperation.Type;

/** Typed error for LSM bridge FFI failures. */
export class LsmBridgeError extends Schema.TaggedErrorClass<LsmBridgeError>()("LsmBridgeError", {
  operation: LsmBridgeOperation,
  cause: Schema.Defect,
}) {}

/** Config key for the path to liblsm-bridge.so. Yieldable in Effect.gen. */
export const LsmBridgePath = Config.string("LIBLSM_BRIDGE_PATH");

export const BRIDGE_SYMBOLS = {
  lsm_bridge_init: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_init_from_snapshot: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_open_snapshot: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_put: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_get: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_bridge_delete: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_scan: {
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.int,
  },
  lsm_bridge_snapshot: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_cursor_open: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_bridge_cursor_close: {
    args: [FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_cursor_read: {
    args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
} as const;

export type BridgeLib = ReturnType<typeof dlopen<typeof BRIDGE_SYMBOLS>>["symbols"];

/** Open liblsm-bridge.so at the path resolved from LIBLSM_BRIDGE_PATH config. */
export const openBridge: Effect.Effect<BridgeLib, ConfigError, never> = Effect.gen(function* () {
  const libPath = yield* LsmBridgePath;
  return dlopen(libPath, BRIDGE_SYMBOLS).symbols;
});
