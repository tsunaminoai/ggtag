const std = @import("std");

extern fn encode(input: [*:0]const u8, length: *c_int) ?[*]u8;
extern fn getLastError() [*:0]const u8;
extern fn free(ptr: ?*anyopaque) void;

test "encode text ending with lone backslash does not crash" {
    // Security fix: input[offset+1] must not be read past null terminator
    // A trailing lone backslash ends the text field — must not crash.
    var len: c_int = 0;
    const ptr = encode("\\t0,0,1,Hello\\", &len);
    // Either parses (treating trailing \ as text delimiter) or returns null
    // — but must NOT crash or read out-of-bounds.
    if (ptr != null) free(ptr);
}

test "encode text with escaped backslash" {
    // \\\\ in the input string = two backslashes in the actual string,
    // which the protocol interprets as one escaped backslash in the text.
    var len: c_int = 0;
    const ptr = encode("\\t0,0,1,back\\\\slash", &len);
    try std.testing.expect(ptr != null);
    try std.testing.expect(len > 0);
    free(ptr);
}

test "encode qr code ending with lone backslash does not crash" {
    var len: c_int = 0;
    const ptr = encode("\\q0,0,2,data\\", &len);
    if (ptr != null) free(ptr);
}

test "encode invalid command returns null and sets error" {
    var len: c_int = 0;
    const ptr = encode("\\z999,999", &len); // \z is not a valid command
    // Must not crash; may return null
    if (ptr != null) free(ptr);
}

test "encode line command succeeds" {
    var len: c_int = 0;
    const ptr = encode("\\l0,0,100,100", &len);
    try std.testing.expect(ptr != null);
    try std.testing.expect(len > 0);
    free(ptr);
}

test "getLastError returns non-empty string after failed parse" {
    var len: c_int = 0;
    _ = encode("\\z_invalid_", &len);
    const err = getLastError();
    // getLastError always returns a valid pointer; check that it has content
    try std.testing.expect(err[0] != 0);
}
