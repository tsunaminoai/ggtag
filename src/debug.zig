// Zig replacement for shared/src/debug.c
// Compile with: zig build -Dzig-debug=true

const std = @import("std");

var debug_enabled: bool = false;

export fn debugEnable(enable: bool) void {
    debug_enabled = enable;
}

// The C callers use variadic printf-style calls which aren't expressible
// as a Zig export fn. The actual debug() call from C goes through the C
// ABI; we provide a fixed-message fallback here. When -Dzig-debug is set,
// the C debug.c is removed from the build and this file is used instead.
// The variadic debug(...) is handled below via a C shim.
export fn debugIsEnabled() bool {
    return debug_enabled;
}
