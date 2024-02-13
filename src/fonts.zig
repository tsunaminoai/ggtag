const std = @import("std");

pub const Max_Height = 41;
pub const Max_Width = 32;

pub const Offset_Bitmap = struct {};

/// ASCII
pub const sFont = struct {
    table: []u8,
    width: u8,
    height: u8,
};

/// GB2312
pub const CH_CN = struct {
    index: [2]u8,
    matrix: [Max_Height * Max_Height / 8 + 2]u8,
};

pub const cFont = struct {
    table: *CH_CN,
    size: u16,
    ascii_width: u16,
    width: u16,
    height: u16,
};

pub const Font8 = @import("fonts/font8.zig");
// pub const Font12 = sFont;
// pub const Font16 = sFont;
// pub const Font20 = sFont;
// pub const Font24 = sFont;
// pub const Font28 = sFont;
// pub const Font32 = sFont;
// pub const Font36 = sFont;

pub const fa_solid_900_ttf = @embedFile("./fonts/fa-solid-900.ttf");
