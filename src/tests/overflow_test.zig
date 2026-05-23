const std = @import("std");

extern fn monoimage(rgba: ?[*]const u8, width: c_int, height: c_int, dither: bool) ?[*]u8;
extern fn encode(input: [*:0]const u8, length: *c_int) ?[*]u8;
extern fn free(ptr: ?*anyopaque) void;

test "monoimage rejects integer-overflow dimensions" {
    // 46341 * 46341 overflows int32 — must be rejected
    var dummy: [4]u8 = .{ 255, 255, 255, 255 };
    const ptr = monoimage(&dummy, 46341, 46341, false);
    try std.testing.expect(ptr == null);
}

test "monoimage rejects dimensions exceeding MAX_IMAGE_PIXELS" {
    // 300 * 300 = 90000 > 65536 — must be rejected
    var dummy: [4]u8 = .{ 255, 255, 255, 255 };
    const ptr = monoimage(&dummy, 300, 300, false);
    try std.testing.expect(ptr == null);
}

test "monoimage accepts valid dimensions" {
    // 250 * 122 = 30500 < 65536 — must succeed
    const pixel_count = 250 * 122;
    var rgba = [_]u8{255} ** (pixel_count * 4);
    const ptr = monoimage(&rgba, 250, 122, false);
    try std.testing.expect(ptr != null);
    free(ptr);
}

test "monoimage rejects null pointer" {
    const ptr = monoimage(null, 10, 10, false);
    try std.testing.expect(ptr == null);
}

test "encode image command with oversized dimensions is rejected" {
    // \i encodes a raw bitmap; w*h > MAX_IMAGE_PIXELS should be rejected
    // We pass a valid-length base64 but with giant dimensions
    // The encoded dimensions overflow the protocol anyway
    var len: c_int = 0;
    const ptr = encode("\\i0,0,512,512,AAAA", &len);
    // May succeed or fail depending on whether 512*512 > MAX_IMAGE_PIXELS (65536)
    // 512*512 = 262144 > 65536, so it must be rejected (null or zero-length)
    if (ptr != null) {
        // if non-null, the encoded length should be 0 (empty / error)
        try std.testing.expect(len == 0);
        free(ptr);
    }
}
