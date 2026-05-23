// Test root — imports all sub-test files.
// Run with: zig build test

comptime {
    _ = @import("b64_test.zig");
    _ = @import("encode_test.zig");
    _ = @import("render_test.zig");
    _ = @import("overflow_test.zig");
    _ = @import("parser_test.zig");
    _ = @import("monoimage_test.zig");
}
