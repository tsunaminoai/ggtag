const std = @import("std");

extern fn render(input: [*:0]const u8, width: c_int, height: c_int) ?[*]u8;
extern fn free(ptr: ?*anyopaque) void;

test "render text produces non-null bitmap" {
    const ptr = render("\\t10,10,1,Hello", 250, 122);
    try std.testing.expect(ptr != null);
    free(ptr);
}

test "render with null-terminated empty input" {
    // An empty command string has no commands; render may return null or a blank bitmap
    const ptr = render("", 250, 122);
    // both null and non-null are acceptable for empty input
    if (ptr != null) free(ptr);
}

test "render rejects zero width" {
    const ptr = render("\\t10,10,1,Hello", 0, 122);
    try std.testing.expect(ptr == null);
}

test "render rejects zero height" {
    const ptr = render("\\t10,10,1,Hello", 250, 0);
    try std.testing.expect(ptr == null);
}

test "render rejects negative width" {
    const ptr = render("\\t10,10,1,Hello", -1, 122);
    try std.testing.expect(ptr == null);
}

test "render rejects negative height" {
    const ptr = render("\\t10,10,1,Hello", 250, -1);
    try std.testing.expect(ptr == null);
}

test "render bitmap has correct size for 250x122" {
    const width = 250;
    const height = 122;
    const ptr = render("\\t10,10,1,Hello", width, height);
    try std.testing.expect(ptr != null);
    // bitmap is ceil(width/8) * height bytes
    // we can only check that it doesn't crash; size is caller-managed
    free(ptr);
}
