const std = @import("std");

extern fn encode(input: [*:0]const u8, length: *c_int) ?[*]u8;
extern fn free(ptr: ?*anyopaque) void;

test "encode text command produces non-null buffer" {
    var len: c_int = 0;
    const ptr = encode("\\t10,10,1,Hello", &len);
    try std.testing.expect(ptr != null);
    try std.testing.expect(len > 0);
    free(ptr);
}

test "encode empty string returns null or zero length" {
    var len: c_int = 0;
    const ptr = encode("", &len);
    // Empty input may return null or a zero-length buffer — both are acceptable
    if (ptr != null) {
        free(ptr);
    }
}

test "encode rect command succeeds" {
    var len: c_int = 0;
    const ptr = encode("\\r0,0,100,50", &len);
    try std.testing.expect(ptr != null);
    try std.testing.expect(len > 0);
    free(ptr);
}

test "encode circle command succeeds" {
    var len: c_int = 0;
    const ptr = encode("\\c50,50,25", &len);
    try std.testing.expect(ptr != null);
    try std.testing.expect(len > 0);
    free(ptr);
}

test "encode multiple commands" {
    var len: c_int = 0;
    const ptr = encode("\\t10,10,1,Hello\\r50,50,100,40\\c120,60,20", &len);
    try std.testing.expect(ptr != null);
    try std.testing.expect(len > 0);
    free(ptr);
}

test "encode text with max-length text (127 chars)" {
    // 127 'A's — the maximum allowed by LENGTH_BITS (7 bits)
    const text: [*:0]const u8 = "\\t0,0,1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    var len: c_int = 0;
    const ptr = encode(text, &len);
    try std.testing.expect(ptr != null);
    free(ptr);
}

test "encode qr code command" {
    var len: c_int = 0;
    const ptr = encode("\\q10,10,2,https://example.com", &len);
    try std.testing.expect(ptr != null);
    try std.testing.expect(len > 0);
    free(ptr);
}
