const std = @import("std");
const testing = std.testing;
const microzig = @import("microzig");
const rp2040 = microzig.hal;
const gpio = rp2040.gpio;
const adc = rp2040.adc;
const time = rp2040.time;

pub const Protocol = @import("protocol.zig");
