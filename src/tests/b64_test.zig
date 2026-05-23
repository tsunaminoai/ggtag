const std = @import("std");

// C functions under test
extern fn b64_decode(in: [*]const u8, in_len: c_int, out: [*]u8, out_capacity: c_int) bool;

test "b64 decodes hello" {
    const input = "aGVsbG8="; // "hello"
    var out: [16]u8 = [_]u8{0} ** 16;
    const ok = b64_decode(input, input.len, &out, out.len);
    try std.testing.expect(ok);
    try std.testing.expectEqualSlices(u8, "hello", out[0..5]);
}

test "b64 decodes empty string" {
    var out: [4]u8 = [_]u8{0} ** 4;
    const ok = b64_decode("".ptr, 0, &out, out.len);
    try std.testing.expect(ok);
}

test "b64 rejects odd-length input" {
    var out: [4]u8 = [_]u8{0} ** 4;
    // "YQ==" is valid (1 byte), "YQ=" is 3 chars (invalid, not multiple of 4)
    const ok = b64_decode("YQ=", 3, &out, out.len);
    try std.testing.expect(!ok);
}

test "b64 rejects negative length" {
    var out: [4]u8 = [_]u8{0} ** 4;
    const ok = b64_decode("YQ==", -1, &out, out.len);
    try std.testing.expect(!ok);
}

test "b64 rejects insufficient output capacity" {
    // "aGVsbG8=" decodes to 6 bytes (hello + padding), need at least 6
    var out: [3]u8 = [_]u8{0} ** 3; // only 3 bytes — too small
    const input = "aGVsbG8="; // 8 base64 chars → up to 6 output bytes
    const ok = b64_decode(input, input.len, &out, out.len);
    try std.testing.expect(!ok); // must refuse to write
}

test "b64 decodes two padding bytes" {
    // "YQ==" → "a" (1 byte)
    var out: [4]u8 = [_]u8{0} ** 4;
    const ok = b64_decode("YQ==", 4, &out, out.len);
    try std.testing.expect(ok);
    try std.testing.expectEqual(@as(u8, 'a'), out[0]);
}

test "b64 decodes one padding byte" {
    // "YWI=" → "ab" (2 bytes)
    var out: [4]u8 = [_]u8{0} ** 4;
    const ok = b64_decode("YWI=", 4, &out, out.len);
    try std.testing.expect(ok);
    try std.testing.expectEqualSlices(u8, "ab", out[0..2]);
}
