/* GHC RTS initialization for the lsm-ffi foreign library.
 * Compiled by Zig's C compiler (zig cc) — no system GCC or HsFFI.h needed.
 * Constructor attribute calls hs_init() when the .so is loaded. */

/* hs_init signature from GHC RTS — avoids requiring HsFFI.h at compile time */
extern void hs_init(int *argc, char ***argv);

static void library_init(void) __attribute__((constructor));

static void library_init(void) {
  static char *argv[] = { "lsm-ffi", 0 };
  static char **argv_ = argv;
  static int argc = 1;
  hs_init(&argc, &argv_);
}
