const std = @import("std");
const rp2040 = @import("rp2040");

// Although this function looks imperative, note that its job is to
// declaratively construct a build graph that will be executed by an external
// runner.
pub fn build(b: *std.Build) void {
    const microzig = @import("microzig").init(b, "microzig");
    const optimize = b.standardOptimizeOption(.{});

    // `addFirmware` basically works like addExecutable, but takes a
    // `microzig.Target` for target instead of a `std.zig.CrossTarget`.
    //
    // The target will convey all necessary information on the chip,
    // cpu and potentially the board as well.
    const firmware = microzig.addFirmware(b, .{
        .name = "GGTag",
        .target = rp2040.boards.raspberry_pi.pico,
        .optimize = optimize,
        .source_file = .{ .path = "src/main.zig" },
    });
    firmware.addIncludePath(.{ .path = "shared/include" });

    // `installFirmware()` is the MicroZig pendant to `Build.installArtifact()`
    // and allows installing the firmware as a typical firmware file.
    //
    // This will also install into `$prefix/firmware` instead of `$prefix/bin`.
    microzig.installFirmware(b, firmware, .{});

    // For debugging, we also always install the firmware as an ELF file
    microzig.installFirmware(b, firmware, .{ .format = .elf });
}
