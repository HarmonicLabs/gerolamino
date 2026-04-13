/// GHC RTS initialization — handled by bridge.zig.
///
/// Both lsm_bridge_init() and lsm_bridge_init_from_snapshot() call hs_init()
/// explicitly before any Haskell FFI calls. No ELF constructor is needed
/// because all code paths go through one of these bridge init functions
/// before touching the Haskell FFI.
///
/// Previously, init.c used __attribute__((constructor)) to call hs_init()
/// at .so load time. This was removed because it was redundant with the
/// explicit calls and caused issues with Vitest's fork model (GHC RTS
/// threads prevented clean process exit).
comptime {}
