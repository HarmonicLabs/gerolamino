/// GHC RTS initialization for the lsm-ffi foreign library.
/// Uses Zig to compile C code that registers GHC RTS init as an ELF constructor.
///
/// Why C via Zig instead of pure Zig: GCC's __attribute__((constructor)) has
/// specific ordering guarantees with the GHC RTS that Zig's linksection(".init_array")
/// doesn't replicate — the RTS threads interfere with Vitest's fork model when
/// initialized via raw .init_array entries.
///
/// This file is compiled with: zig cc -c init.c -o zig-init.o
/// (See the companion init.c file)
///
/// Placeholder — actual init is in init.c, compiled by Zig's C compiler.
comptime {}
