// WASM freestanding entry point for ggtag.
//
// This file provides all the C stdlib functions that the C/C++ source files
// need, since wasm32-freestanding has no system libc.
//
// The C API functions (render, encode, etc.) are compiled from C/C++ source
// files alongside this module and are automatically exported via rdynamic.

const std = @import("std");

// ---------------------------------------------------------------------------
// Arena allocator — 4 MB static heap
// The badge renders one image at a time; a simple bump allocator is sufficient.
//
// Each allocation is preceded by a 4-byte size header so that realloc can
// copy the correct number of bytes when the buffer needs to grow (e.g.
// BitBuffer::ensureCapacity). The header is transparent to C callers.
// ---------------------------------------------------------------------------
var heap: [4 * 1024 * 1024]u8 align(16) = undefined;
var heap_pos: usize = 0;

const MALLOC_HEADER: usize = 4; // u32 size stored before each allocation

export fn malloc(size: usize) ?*anyopaque {
    const aligned = std.mem.alignForward(usize, heap_pos, 16);
    if (aligned + MALLOC_HEADER + size > heap.len) return null;
    // Store allocation size in header for use by realloc.
    std.mem.writeInt(u32, heap[aligned..][0..4], @intCast(size), .little);
    heap_pos = aligned + MALLOC_HEADER + size;
    return @ptrCast(&heap[aligned + MALLOC_HEADER]);
}

export fn calloc(nmemb: usize, size: usize) ?*anyopaque {
    const total = nmemb *| size; // saturating mul — prevents overflow
    if (total == 0) return malloc(1); // calloc(0) must return non-null per spec
    const ptr = malloc(total) orelse return null;
    @memset(@as([*]u8, @ptrCast(ptr))[0..total], 0);
    return ptr;
}

export fn realloc(ptr: ?*anyopaque, size: usize) ?*anyopaque {
    if (ptr == null) return malloc(size);
    // Read the old allocation size from the header that precedes the data.
    const data_addr = @intFromPtr(ptr.?);
    const old_size = std.mem.readInt(u32, @as(*const [4]u8, @ptrFromInt(data_addr - MALLOC_HEADER)), .little);
    const new_ptr = malloc(size) orelse return null;
    const copy_len = @min(@as(usize, old_size), size);
    @memcpy(@as([*]u8, @ptrCast(new_ptr))[0..copy_len], @as([*]const u8, @ptrCast(ptr.?))[0..copy_len]);
    return new_ptr;
}

export fn free(_: ?*anyopaque) void {}

// ---------------------------------------------------------------------------
// Memory operations
// ---------------------------------------------------------------------------

export fn memset(dest: ?*anyopaque, c: c_int, n: usize) ?*anyopaque {
    if (dest) |d| @memset(@as([*]u8, @ptrCast(d))[0..n], @intCast(c & 0xff));
    return dest;
}

export fn memcpy(dest: ?*anyopaque, src: ?*const anyopaque, n: usize) ?*anyopaque {
    if (dest != null and src != null and n > 0) {
        const d = @as([*]u8, @ptrCast(dest.?));
        const s = @as([*]const u8, @ptrCast(src.?));
        @memcpy(d[0..n], s[0..n]);
    }
    return dest;
}

export fn memmove(dest: ?*anyopaque, src: ?*const anyopaque, n: usize) ?*anyopaque {
    if (dest != null and src != null and n > 0) {
        const d = @as([*]u8, @ptrCast(dest.?));
        const s = @as([*]const u8, @ptrCast(src.?));
        std.mem.copyForwards(u8, d[0..n], s[0..n]);
    }
    return dest;
}

export fn memcmp(s1: ?*const anyopaque, s2: ?*const anyopaque, n: usize) c_int {
    if (n == 0 or s1 == null or s2 == null) return 0;
    const a = @as([*]const u8, @ptrCast(s1.?))[0..n];
    const b = @as([*]const u8, @ptrCast(s2.?))[0..n];
    return switch (std.mem.order(u8, a, b)) {
        .lt => -1,
        .eq => 0,
        .gt => 1,
    };
}

// ---------------------------------------------------------------------------
// String operations
// ---------------------------------------------------------------------------

export fn strlen(s: [*:0]const u8) usize {
    return std.mem.len(s);
}

export fn strncasecmp(s1: [*:0]const u8, s2: [*:0]const u8, n: usize) c_int {
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const c1 = std.ascii.toLower(s1[i]);
        const c2 = std.ascii.toLower(s2[i]);
        if (c1 != c2) return @as(c_int, c1) - @as(c_int, c2);
        if (c1 == 0) break;
    }
    return 0;
}

export fn strcmp(s1: [*:0]const u8, s2: [*:0]const u8) c_int {
    var i: usize = 0;
    while (true) : (i += 1) {
        if (s1[i] != s2[i]) return @as(c_int, s1[i]) - @as(c_int, s2[i]);
        if (s1[i] == 0) return 0;
    }
}

export fn strncmp(s1: [*:0]const u8, s2: [*:0]const u8, n: usize) c_int {
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (s1[i] != s2[i]) return @as(c_int, s1[i]) - @as(c_int, s2[i]);
        if (s1[i] == 0) return 0;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// printf / fprintf stubs — silent in WASM (no JS console wired yet)
// ---------------------------------------------------------------------------

export fn printf(_: [*:0]const u8, ...) c_int {
    return 0;
}

export fn vprintf(_: [*:0]const u8, _: *anyopaque) c_int {
    return 0;
}

export fn sprintf(buf: [*]u8, fmt: [*:0]const u8, ...) c_int {
    // All uses in ggtag.cpp pass constant strings with no format specifiers,
    // so copying fmt verbatim is sufficient.
    var i: usize = 0;
    while (fmt[i] != 0) : (i += 1) buf[i] = fmt[i];
    buf[i] = 0;
    return @intCast(i);
}

export fn snprintf(buf: [*]u8, n: usize, fmt: [*:0]const u8, ...) c_int {
    var i: usize = 0;
    while (fmt[i] != 0 and i + 1 < n) : (i += 1) buf[i] = fmt[i];
    if (n > 0) buf[i] = 0;
    return @intCast(i);
}

// stderr writes silently in WASM
export fn fprintf(_: *anyopaque, _: [*:0]const u8, ...) c_int {
    return 0;
}

// ---------------------------------------------------------------------------
// Integer arithmetic (stdlib.h)
// ---------------------------------------------------------------------------

export fn abs(x: c_int) c_int {
    return if (x < 0) -x else x;
}

export fn labs(x: c_long) c_long {
    return if (x < 0) -x else x;
}

// ---------------------------------------------------------------------------
// String search (string.h)
// ---------------------------------------------------------------------------

export fn strchr(s: [*:0]const u8, c: c_int) ?[*:0]const u8 {
    const ch: u8 = @intCast(c & 0xff);
    var i: usize = 0;
    while (true) : (i += 1) {
        if (s[i] == ch) return s + i;
        if (s[i] == 0) return null;
    }
}

export fn strcpy(dest: [*]u8, src: [*:0]const u8) [*]u8 {
    var i: usize = 0;
    while (src[i] != 0) : (i += 1) dest[i] = src[i];
    dest[i] = 0;
    return dest;
}

export fn strncpy(dest: [*]u8, src: [*:0]const u8, n: usize) [*]u8 {
    var i: usize = 0;
    while (i < n and src[i] != 0) : (i += 1) dest[i] = src[i];
    while (i < n) : (i += 1) dest[i] = 0;
    return dest;
}

// ---------------------------------------------------------------------------
// Math functions (math.h) — map to WASM built-in instructions via Zig builtins
// ---------------------------------------------------------------------------

export fn sqrt(x: f64) f64 {
    return @sqrt(x);
}

export fn sqrtf(x: f32) f32 {
    return @sqrt(x);
}

export fn fabs(x: f64) f64 {
    return @abs(x);
}

export fn fabsf(x: f32) f32 {
    return @abs(x);
}

export fn floor(x: f64) f64 {
    return @floor(x);
}

export fn floorf(x: f32) f32 {
    return @floor(x);
}

export fn ceil(x: f64) f64 {
    return @ceil(x);
}

export fn ceilf(x: f32) f32 {
    return @ceil(x);
}

export fn pow(base: f64, exp: f64) f64 {
    return std.math.pow(f64, base, exp);
}

export fn fmod(x: f64, y: f64) f64 {
    return @mod(x, y);
}

export fn fmodf(x: f32, y: f32) f32 {
    return @mod(x, y);
}

export fn acos(x: f64) f64 {
    return std.math.acos(x);
}

export fn cos(x: f64) f64 {
    return @cos(x);
}

export fn cosf(x: f32) f32 {
    return @cos(x);
}

export fn sin(x: f64) f64 {
    return @sin(x);
}

export fn sinf(x: f32) f32 {
    return @sin(x);
}

export fn atan2(y: f64, x: f64) f64 {
    return std.math.atan2(y, x);
}

// ---------------------------------------------------------------------------
// assert / abort
// ---------------------------------------------------------------------------

export fn __assert_fail(
    _: [*:0]const u8,
    _: [*:0]const u8,
    _: c_uint,
    _: [*:0]const u8,
) noreturn {
    @trap(); // WASM unreachable instruction
}

export fn abort() noreturn {
    @trap();
}

// ---------------------------------------------------------------------------
// Arena reset — call between renders to reclaim memory
// ---------------------------------------------------------------------------
export fn ggtag_arena_reset() void {
    heap_pos = 0;
}
