/// GHC RTS initialization — see init.c (compiled by zig cc).
///
/// Pure Zig linksection(".init_array") doesn't work reliably with GHC RTS:
/// the RTS threads prevent clean process exit in Vitest's fork model.
/// Using C __attribute__((constructor)) via zig cc is the proven approach.
///
/// This file documents the intent; init.c is the actual implementation.
comptime {}
