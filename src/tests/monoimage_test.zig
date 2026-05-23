const std = @import("std");

extern fn monoimage(rgba: ?[*]const u8, width: c_int, height: c_int, dither: bool) ?[*]u8;
extern fn free(ptr: ?*anyopaque) void;

test "monoimage all-white RGBA produces all-zero bitmap" {
    // White pixels (255,255,255,255) → luminance ≈ 255 → newpixel=255 → bit=0
    const w: usize = 8;
    const h: usize = 4;
    var rgba = [_]u8{255} ** (w * h * 4);
    const ptr = monoimage(&rgba, w, h, false);
    try std.testing.expect(ptr != null);
    // bitmap is ceil(w*h/8) bytes = 4 bytes for 32 pixels
    const bitmap: [*]const u8 = @ptrCast(ptr.?);
    const byte_count = (w * h + 7) / 8;
    for (bitmap[0..byte_count]) |byte| {
        try std.testing.expectEqual(@as(u8, 0), byte);
    }
    free(ptr);
}

test "monoimage all-black RGBA produces all-ones bitmap" {
    // Black pixels (0,0,0,255) → luminance = 0 → bit=1
    const w: usize = 8;
    const h: usize = 4;
    var rgba = [_]u8{0} ** (w * h * 4);
    // Set alpha to 255
    var i: usize = 3;
    while (i < rgba.len) : (i += 4) rgba[i] = 255;
    const ptr = monoimage(&rgba, w, h, false);
    try std.testing.expect(ptr != null);
    const bitmap: [*]const u8 = @ptrCast(ptr.?);
    const byte_count = (w * h + 7) / 8;
    for (bitmap[0..byte_count]) |byte| {
        try std.testing.expectEqual(@as(u8, 0xff), byte);
    }
    free(ptr);
}

test "monoimage dithered differs from non-dithered for gray" {
    // Mid-gray (128,128,128,255) should produce different results with/without dither
    const w: usize = 16;
    const h: usize = 8;
    var rgba = [_]u8{0} ** (w * h * 4);
    var i: usize = 0;
    while (i < rgba.len) : (i += 4) {
        rgba[i] = 128; // R
        rgba[i + 1] = 128; // G
        rgba[i + 2] = 128; // B
        rgba[i + 3] = 255; // A
    }
    const no_dither = monoimage(&rgba, w, h, false);
    const with_dither = monoimage(&rgba, w, h, true);
    try std.testing.expect(no_dither != null);
    try std.testing.expect(with_dither != null);
    const byte_count = (w * h + 7) / 8;
    const nd: [*]const u8 = @ptrCast(no_dither.?);
    const wd: [*]const u8 = @ptrCast(with_dither.?);
    // At least one byte should differ
    var differs = false;
    for (nd[0..byte_count], wd[0..byte_count]) |a, b| {
        if (a != b) {
            differs = true;
            break;
        }
    }
    try std.testing.expect(differs);
    free(no_dither);
    free(with_dither);
}

test "monoimage rejects zero dimensions" {
    var rgba: [4]u8 = .{ 0, 0, 0, 255 };
    try std.testing.expect(monoimage(&rgba, 0, 10, false) == null);
    try std.testing.expect(monoimage(&rgba, 10, 0, false) == null);
}
