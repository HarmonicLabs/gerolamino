const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "lsm-bridge",
        .root_module = b.createModule(.{
            .root_source_file = b.path("bridge.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    // lsm-ffi shared library path — injected from Nix via -Dlsm-ffi-path
    if (b.option([]const u8, "lsm-ffi-path", "Path to lsm-ffi lib directory")) |ffi_path| {
        lib.addLibraryPath(.{ .cwd_relative = ffi_path });
        lib.addRPath(.{ .cwd_relative = ffi_path });
    }
    lib.linkSystemLibrary("lsm-ffi");

    b.installArtifact(lib);
}
