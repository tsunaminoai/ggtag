const std = @import("std");
const fonts = @import("fonts.zig");
const c = @cImport({
    @cDefine("STB_TRUETYPE_IMPLEMENTATION", "");
    @cInclude("stb_truetype.h");
});

pub fn renderCodepoint(codepoint: i32, height: i32, out_width: *i32, out_height: *i32) *u8 {
    _ = codepoint; // autofix
    _ = height; // autofix
    _ = out_width; // autofix
    _ = out_height; // autofix
    var info: c.stbtt_fontinfo = undefined;
    c.stbtt_InitFont(&info, fonts.fa_solid_900_ttf, 0) catch |e| {
        _ = e; // autofix
        std.debug.print("failed to load ttf font\n", .{});
        return 0;
    };
}

test "renderCodepoint" {
    var out_width: i32 = 0;
    var out_height: i32 = 0;
    var result = renderCodepoint(65, 10, &out_width, &out_height);
    try std.testing.expect(result.* != 0);
    try std.testing.expectEqual(out_width, 10);
    try std.testing.expectEqual(out_height, 20);
}
