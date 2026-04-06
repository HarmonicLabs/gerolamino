/// Zig bridge between Haskell lsm-tree and Bun/TypeScript.
///
/// This replaces the Bun FFI dlopen approach with a Zig shared library
/// that wraps the Haskell FFI exports. Zig handles pointer arithmetic
/// and memory management, exposing a simpler buffer-based API to JS.
///
/// Build: zig build-lib -target x86_64-linux-gnu -OReleaseSafe bridge.zig
///
/// The Zig layer eliminates the need for `as never` Pointer casts in TypeScript
/// by managing pointer lifecycle internally and returning plain byte buffers.
const std = @import("std");

// Haskell FFI imports (from liblsm-ffi.so)
extern fn hs_init(argc: *c_int, argv: *?[*][*:0]u8) void;
extern fn lsm_session_open(path: [*:0]const u8, out: *?*anyopaque) c_int;
extern fn lsm_session_close(session: *anyopaque) c_int;
extern fn lsm_table_new(session: *anyopaque, out: *?*anyopaque) c_int;
extern fn lsm_table_close(table: *anyopaque) c_int;
extern fn lsm_insert(table: *anyopaque, key: [*]const u8, key_len: usize, val: [*]const u8, val_len: usize) c_int;
extern fn lsm_lookup(table: *anyopaque, key: [*]const u8, key_len: usize, out_buf: *?[*]const u8, out_len: *usize) c_int;
extern fn lsm_delete(table: *anyopaque, key: [*]const u8, key_len: usize) c_int;
extern fn lsm_range_lookup(table: *anyopaque, lo: [*]const u8, lo_len: usize, hi: [*]const u8, hi_len: usize, out_buf: *?[*]u8, out_len: *usize, out_count: *usize) c_int;
extern fn lsm_snapshot_save(session: *anyopaque, table: *anyopaque, name: [*:0]const u8) c_int;

// Global state — initialized once on library load
var session: ?*anyopaque = null;
var table: ?*anyopaque = null;

/// Initialize the LSM session and table.
/// Called from TypeScript before any operations.
/// Returns 0 on success, negative on error.
export fn lsm_bridge_init(path_ptr: [*]const u8, path_len: usize) callconv(.C) c_int {
    // Initialize GHC RTS
    var argc: c_int = 0;
    var argv: ?[*][*:0]u8 = null;
    hs_init(&argc, &argv);

    // Null-terminate the path
    var path_buf: [4096]u8 = undefined;
    if (path_len >= path_buf.len) return -1;
    @memcpy(path_buf[0..path_len], path_ptr[0..path_len]);
    path_buf[path_len] = 0;

    // Open session
    var sess: ?*anyopaque = null;
    const sess_rc = lsm_session_open(@ptrCast(&path_buf), &sess);
    if (sess_rc != 0) return sess_rc;
    session = sess;

    // Create table
    var tbl: ?*anyopaque = null;
    const tbl_rc = lsm_table_new(sess.?, &tbl);
    if (tbl_rc != 0) return tbl_rc;
    table = tbl;

    return 0;
}

/// Insert a key-value pair.
export fn lsm_bridge_put(key_ptr: [*]const u8, key_len: usize, val_ptr: [*]const u8, val_len: usize) callconv(.C) c_int {
    return lsm_insert(table.?, key_ptr, key_len, val_ptr, val_len);
}

/// Look up a key. Returns 0=found (writes to out), 1=not found, -1=error.
/// The output buffer is allocated by Zig and must be freed by calling lsm_bridge_free.
export fn lsm_bridge_get(key_ptr: [*]const u8, key_len: usize, out_ptr: *?[*]u8, out_len: *usize) callconv(.C) c_int {
    var haskell_buf: ?[*]const u8 = null;
    var haskell_len: usize = 0;
    const rc = lsm_lookup(table.?, key_ptr, key_len, &haskell_buf, &haskell_len);
    if (rc != 0) {
        out_ptr.* = null;
        out_len.* = 0;
        return rc;
    }

    // Copy from GHC-managed memory to Zig-allocated memory (safe from GC)
    const buf = std.heap.c_allocator.alloc(u8, haskell_len) catch return -2;
    @memcpy(buf, haskell_buf.?[0..haskell_len]);
    out_ptr.* = buf.ptr;
    out_len.* = haskell_len;
    return 0;
}

/// Free a buffer allocated by lsm_bridge_get.
export fn lsm_bridge_free(buf_ptr: [*]u8, buf_len: usize) callconv(.C) void {
    std.heap.c_allocator.free(buf_ptr[0..buf_len]);
}

/// Delete a key.
export fn lsm_bridge_delete(key_ptr: [*]const u8, key_len: usize) callconv(.C) c_int {
    return lsm_delete(table.?, key_ptr, key_len);
}

/// Range lookup. Returns entries as a flat buffer.
/// Caller must free the result buffer via lsm_bridge_free.
export fn lsm_bridge_scan(lo_ptr: [*]const u8, lo_len: usize, hi_ptr: [*]const u8, hi_len: usize, out_ptr: *?[*]u8, out_len: *usize, out_count: *usize) callconv(.C) c_int {
    return lsm_range_lookup(table.?, lo_ptr, lo_len, hi_ptr, hi_len, out_ptr, out_len, out_count);
}

/// Save a snapshot.
export fn lsm_bridge_snapshot(name_ptr: [*]const u8, name_len: usize) callconv(.C) c_int {
    var name_buf: [256]u8 = undefined;
    if (name_len >= name_buf.len) return -1;
    @memcpy(name_buf[0..name_len], name_ptr[0..name_len]);
    name_buf[name_len] = 0;
    return lsm_snapshot_save(session.?, table.?, @ptrCast(&name_buf));
}
