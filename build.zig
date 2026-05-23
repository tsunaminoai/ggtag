const std = @import("std");

pub fn build(b: *std.Build) void {
    // -------------------------------------------------------------------------
    // Standard options
    // -------------------------------------------------------------------------
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Feature flags for incremental Zig port
    const use_zig_debug = b.option(bool, "zig-debug", "Use src/debug.zig instead of shared/src/debug.c") orelse false;
    const use_zig_rfid = b.option(bool, "zig-rfid", "Use src/rfid_stub.zig instead of host/src/rfid.cpp") orelse false;

    // -------------------------------------------------------------------------
    // Source file lists — mirrors the Makefile exactly
    // -------------------------------------------------------------------------
    const font_sources = &[_][]const u8{
        "shared/src/font8.c",
        "shared/src/font12.c",
        "shared/src/font16.c",
        "shared/src/font20.c",
        "shared/src/font24.c",
        "shared/src/font28.c",
        "shared/src/font32.c",
        "shared/src/font36.c",
        "shared/src/fa.c",
    };

    const shared_c_sources = &[_][]const u8{
        "shared/src/GUI_Paint.c",
        "shared/src/qrcodegen.c",
    };

    const shared_cpp_sources = &[_][]const u8{
        "shared/src/protocol.cpp",
    };

    const host_cpp_sources = &[_][]const u8{
        "host/src/ggtag.cpp",
        "host/src/utils.cpp",
    };

    const cflags = &[_][]const u8{ "-Wall", "-O2" };
    const cppflags = &[_][]const u8{ "-Wall", "-O2", "-std=c++14" };
    const lib_cflags = &[_][]const u8{ "-Wall", "-O2", "-DGGTAG_LIBRARY" };
    const lib_cppflags = &[_][]const u8{ "-Wall", "-O2", "-std=c++14", "-DGGTAG_LIBRARY" };

    // -------------------------------------------------------------------------
    // libggtag — static library (no main(), for tests and future Python binding)
    // -------------------------------------------------------------------------
    const lib_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
    });
    lib_mod.link_libc = true;
    lib_mod.link_libcpp = true;

    const libggtag = b.addLibrary(.{
        .name = "ggtag",
        .linkage = .static,
        .root_module = lib_mod,
    });
    libggtag.addIncludePath(b.path("shared/include"));
    libggtag.addIncludePath(b.path("host/include"));
    libggtag.addCSourceFiles(.{
        .root = b.path("."),
        .files = font_sources,
        .flags = lib_cflags,
    });
    libggtag.addCSourceFiles(.{
        .root = b.path("."),
        .files = shared_c_sources,
        .flags = lib_cflags,
    });
    libggtag.addCSourceFiles(.{
        .root = b.path("."),
        .files = shared_cpp_sources,
        .flags = lib_cppflags,
    });
    libggtag.addCSourceFiles(.{
        .root = b.path("."),
        .files = host_cpp_sources,
        .flags = lib_cppflags,
    });

    // debug module (C or Zig)
    if (use_zig_debug) {
        const debug_mod = b.createModule(.{
            .root_source_file = b.path("src/debug.zig"),
            .target = target,
            .optimize = optimize,
        });
        libggtag.root_module.addImport("debug", debug_mod);
        libggtag.addCSourceFiles(.{
            .root = b.path("."),
            .files = &.{"src/debug_shim.c"},
            .flags = lib_cflags,
        });
    } else {
        libggtag.addCSourceFiles(.{
            .root = b.path("."),
            .files = &.{"shared/src/debug.c"},
            .flags = lib_cflags,
        });
    }

    // rfid module (C++ or Zig)
    if (use_zig_rfid) {
        const rfid_mod = b.createModule(.{
            .root_source_file = b.path("src/rfid_stub.zig"),
            .target = target,
            .optimize = optimize,
        });
        libggtag.root_module.addImport("rfid", rfid_mod);
    } else {
        libggtag.addCSourceFiles(.{
            .root = b.path("."),
            .files = &.{"host/src/rfid.cpp"},
            .flags = lib_cppflags,
        });
    }

    b.installArtifact(libggtag);

    // -------------------------------------------------------------------------
    // Native executable (includes main() from ggtag.cpp)
    // -------------------------------------------------------------------------
    const exe_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
    });
    exe_mod.link_libc = true;
    exe_mod.link_libcpp = true;

    const exe = b.addExecutable(.{
        .name = "ggtag",
        .root_module = exe_mod,
    });
    exe.addIncludePath(b.path("shared/include"));
    exe.addIncludePath(b.path("host/include"));
    exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = font_sources,
        .flags = cflags,
    });
    exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = shared_c_sources,
        .flags = cflags,
    });
    exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = shared_cpp_sources,
        .flags = cppflags,
    });
    exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = host_cpp_sources,
        .flags = cppflags,
    });
    exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = &.{"shared/src/debug.c"},
        .flags = cflags,
    });
    exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = &.{"host/src/rfid.cpp"},
        .flags = cppflags,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);
    const run_step = b.step("run", "Run the native ggtag binary");
    run_step.dependOn(&run_cmd.step);

    // -------------------------------------------------------------------------
    // WASM build (wasm32-freestanding, no system libc)
    // -------------------------------------------------------------------------
    buildWasm(b, optimize, font_sources, shared_c_sources, shared_cpp_sources, host_cpp_sources);

    // -------------------------------------------------------------------------
    // Debug build (AddressSanitizer + UBSan)
    // -------------------------------------------------------------------------
    buildDebug(b, target, font_sources, shared_c_sources, shared_cpp_sources, host_cpp_sources);

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------
    buildTests(b, target, optimize, libggtag);
}

fn buildWasm(
    b: *std.Build,
    optimize: std.builtin.OptimizeMode,
    font_sources: []const []const u8,
    shared_c_sources: []const []const u8,
    shared_cpp_sources: []const []const u8,
    host_cpp_sources: []const []const u8,
) void {
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .abi = .none,
    });

    const wasm_optimize = if (optimize == .Debug) .ReleaseSafe else optimize;

    const wasm_c = &[_][]const u8{
        "-Wall", "-O2", "-fno-builtin", "-DGGTAG_LIBRARY", "-DNDEBUG", "-D__WASM__",
    };
    const wasm_cpp = &[_][]const u8{
        "-Wall", "-O2", "-std=c++14", "-fno-builtin", "-fno-exceptions",
        "-DGGTAG_LIBRARY", "-DNDEBUG", "-D__WASM__",
    };

    const wasm_mod = b.createModule(.{
        .root_source_file = b.path("src/wasm_root.zig"),
        .target = wasm_target,
        .optimize = wasm_optimize,
    });

    // wasm32-freestanding doesn't support dynamic libraries.
    // Build as an "executable" — Zig produces a .wasm file.
    // The exported functions (malloc, free, render, encode, etc.) become WASM exports.
    const wasm_exe = b.addExecutable(.{
        .name = "ggtag",
        .root_module = wasm_mod,
    });
    wasm_exe.rdynamic = true;
    wasm_exe.entry = .disabled; // no _start entry point needed for browser WASM

    // libc_stubs MUST come first — provides stdlib.h, stdio.h, etc. for freestanding
    wasm_exe.addIncludePath(b.path("src/libc_stubs"));
    wasm_exe.addIncludePath(b.path("shared/include"));
    wasm_exe.addIncludePath(b.path("host/include"));
    wasm_exe.addIncludePath(b.path("src"));

    wasm_exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = font_sources,
        .flags = wasm_c,
    });
    wasm_exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = shared_c_sources,
        .flags = wasm_c,
    });
    wasm_exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = shared_cpp_sources,
        .flags = wasm_cpp,
    });
    wasm_exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = host_cpp_sources,
        .flags = wasm_cpp,
    });
    // debug.c uses printf which we shim; include it for WASM
    wasm_exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = &.{"shared/src/debug.c"},
        .flags = wasm_c,
    });
    // rfid stub (no-op on WASM too)
    wasm_exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = &.{"host/src/rfid.cpp"},
        .flags = wasm_cpp,
    });

    const wasm_install = b.addInstallArtifact(wasm_exe, .{
        .dest_dir = .{ .override = .{ .custom = "../docs/js" } },
    });
    const wasm_step = b.step("wasm", "Build WASM module for browser (output: docs/js/ggtag.wasm)");
    wasm_step.dependOn(&wasm_install.step);
}

fn buildDebug(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    font_sources: []const []const u8,
    shared_c_sources: []const []const u8,
    shared_cpp_sources: []const []const u8,
    host_cpp_sources: []const []const u8,
) void {
    const dbg_c = &[_][]const u8{ "-Wall", "-g", "-fsanitize=address,undefined" };
    const dbg_cpp = &[_][]const u8{ "-Wall", "-g", "-std=c++14", "-fsanitize=address,undefined" };

    const dbg_mod = b.createModule(.{
        .target = target,
        .optimize = .Debug,
    });
    dbg_mod.link_libc = true;
    dbg_mod.link_libcpp = true;

    const dbg_exe = b.addExecutable(.{
        .name = "ggtag-debug",
        .root_module = dbg_mod,
    });
    dbg_exe.addIncludePath(b.path("shared/include"));
    dbg_exe.addIncludePath(b.path("host/include"));
    dbg_exe.addCSourceFiles(.{ .root = b.path("."), .files = font_sources, .flags = dbg_c });
    dbg_exe.addCSourceFiles(.{ .root = b.path("."), .files = shared_c_sources, .flags = dbg_c });
    dbg_exe.addCSourceFiles(.{ .root = b.path("."), .files = shared_cpp_sources, .flags = dbg_cpp });
    dbg_exe.addCSourceFiles(.{ .root = b.path("."), .files = host_cpp_sources, .flags = dbg_cpp });
    dbg_exe.addCSourceFiles(.{
        .root = b.path("."),
        .files = &.{ "shared/src/debug.c", "host/src/rfid.cpp" },
        .flags = dbg_c,
    });

    const dbg_install = b.addInstallArtifact(dbg_exe, .{});
    const dbg_step = b.step("debug", "Build with AddressSanitizer + UBSanitizer");
    dbg_step.dependOn(&dbg_install.step);
}

fn buildTests(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    libggtag: *std.Build.Step.Compile,
) void {
    const test_mod = b.createModule(.{
        .root_source_file = b.path("src/tests/main_test.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_mod.link_libc = true;

    const test_exe = b.addTest(.{
        .root_module = test_mod,
    });
    test_exe.linkLibrary(libggtag);

    const run_tests = b.addRunArtifact(test_exe);
    const test_step = b.step("test", "Run all Zig tests (calls into C via FFI)");
    test_step.dependOn(&run_tests.step);
}
