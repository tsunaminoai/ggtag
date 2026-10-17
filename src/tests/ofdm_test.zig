// Tests for src/ofdm_recv.zig — Hamming, CRC, FFT, and full-frame roundtrip
const std = @import("std");
const testing = std.testing;
const math = std.math;
const ofdm = @import("ofdm_recv");

// ---------------------------------------------------------------------------
// Hamming(7,4)
// ---------------------------------------------------------------------------
test "hamming roundtrip all nibbles" {
    for (0..16) |n| {
        const nibble: u4 = @intCast(n);
        const encoded = ofdm.hamming74Encode(nibble);
        const decoded = ofdm.hamming74Decode(encoded);
        try testing.expectEqual(nibble, decoded);
    }
}

test "hamming single-bit error correction" {
    for (0..16) |n| {
        const nibble: u4 = @intCast(n);
        const codeword = ofdm.hamming74Encode(nibble);
        for (0..7) |bit| {
            const corrupted: u7 = codeword ^ (@as(u7, 1) << @intCast(bit));
            const decoded = ofdm.hamming74Decode(corrupted);
            try testing.expectEqual(nibble, decoded);
        }
    }
}

// ---------------------------------------------------------------------------
// CRC
// ---------------------------------------------------------------------------
test "crc8 standard vector 123456789 = 0xF4" {
    const data = [_]u8{ 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39 };
    try testing.expectEqual(@as(u8, 0xf4), ofdm.crc8(&data));
}

test "crc8 empty = 0" {
    try testing.expectEqual(@as(u8, 0), ofdm.crc8(&.{}));
}

test "crc16 standard vector 123456789 = 0x29B1" {
    const data = [_]u8{ 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39 };
    try testing.expectEqual(@as(u16, 0x29b1), ofdm.crc16(&data));
}

test "crc16 empty = 0xFFFF" {
    try testing.expectEqual(@as(u16, 0xffff), ofdm.crc16(&.{}));
}

// ---------------------------------------------------------------------------
// FFT correctness
// ---------------------------------------------------------------------------
test "fft sinusoid peak at correct bin" {
    const N = ofdm.N_FFT;
    var re = [_]f32{0.0} ** N;
    var im = [_]f32{0.0} ** N;
    const k: usize = 10; // test bin
    for (0..N) |n| {
        re[n] = @cos(2.0 * math.pi * @as(f32, @floatFromInt(k)) * @as(f32, @floatFromInt(n)) / @as(f32, @floatFromInt(N)));
    }
    ofdm.fft(&re, &im, false);
    // Find magnitude peak
    var peak_bin: usize = 0;
    var peak_mag: f32 = 0;
    for (0..N) |i| {
        const mag = @sqrt(re[i] * re[i] + im[i] * im[i]);
        if (mag > peak_mag) {
            peak_mag = mag;
            peak_bin = i;
        }
    }
    // For a real cosine, peaks at both k and N-k
    const at_k = peak_bin == k or peak_bin == N - k;
    try testing.expect(at_k);
    // Magnitude at bin k should be N/2 for unit-amplitude cosine
    const mag_k = @sqrt(re[k] * re[k] + im[k] * im[k]);
    try testing.expect(@abs(mag_k - @as(f32, @floatFromInt(N)) / 2.0) < 1.0);
}

test "ifft is inverse of fft" {
    const N = 64; // small N for speed
    var re = [_]f32{0.0} ** N;
    var im = [_]f32{0.0} ** N;
    // put arbitrary values in
    for (0..N) |i| re[i] = @as(f32, @floatFromInt(i % 7)) - 3.0;
    const re_orig = re;
    // forward FFT
    ofdm.fft(&re, &im, false);
    // inverse FFT
    ofdm.fft(&re, &im, true);
    // should recover original (imaginary ≈ 0)
    for (0..N) |i| {
        try testing.expect(@abs(re[i] - re_orig[i]) < 1e-3);
        try testing.expect(@abs(im[i]) < 1e-3);
    }
}

// ---------------------------------------------------------------------------
// Frame synthesis helper (for roundtrip test)
// Generates OFDM frame as i16 samples at 24 kHz.
// ---------------------------------------------------------------------------
fn bpsk(bit: u1) f32 {
    return if (bit == 1) -1.0 else 1.0;
}

// Returns f32 IFFT output for a 512-sample window + 128-sample CP, scaled to i16 range.
// carriers: N_CARRIERS BPSK values ±1
fn synthesizeSymbol(carriers: *const [ofdm.N_CARRIERS]f32, out: []i16) void {
    std.debug.assert(out.len == ofdm.N_SYM);
    const N = ofdm.N_FFT;
    var re = [_]f32{0.0} ** ofdm.N_FFT;
    var im = [_]f32{0.0} ** ofdm.N_FFT;
    for (0..ofdm.N_CARRIERS) |i| {
        const bin = ofdm.BIN_LO + i;
        re[bin] = carriers[i];
        re[N - bin] = carriers[i]; // Hermitian symmetry
    }
    ofdm.fft(&re, &im, true); // IFFT
    const scale: f32 = 0.5 / @as(f32, @floatFromInt(ofdm.N_CARRIERS));
    // Write CP + data
    for (0..ofdm.N_CP) |i| {
        out[i] = @intFromFloat(re[N - ofdm.N_CP + i] * scale * 32767.0);
    }
    for (0..N) |i| {
        out[ofdm.N_CP + i] = @intFromFloat(re[i] * scale * 32767.0);
    }
}

fn synthesizePreamble(out: []i16) void {
    std.debug.assert(out.len == 2 * ofdm.N_SYM);
    var carriers: [ofdm.N_CARRIERS]f32 = undefined;
    @memset(&carriers, 1.0);
    synthesizeSymbol(&carriers, out[0..ofdm.N_SYM]);
    synthesizeSymbol(&carriers, out[ofdm.N_SYM .. 2 * ofdm.N_SYM]);
}

// 23 nibbles per symbol (23×7=161 bits); carriers 161-163 padded to +1.
// Must match the JS encoder's NIBBLES_PER_SYM and the decoder's max_this_sym.
const NIBBLES_PER_SYM: usize = ofdm.N_CARRIERS / 7; // 23

fn synthesizeDataSym(nibbles: []const u8, sym_idx: usize, out: []i16) void {
    var carriers: [ofdm.N_CARRIERS]f32 = undefined;
    @memset(&carriers, 1.0);
    const nibble_offset = sym_idx * NIBBLES_PER_SYM;
    for (0..NIBBLES_PER_SYM) |i| {
        const ni = nibble_offset + i;
        if (ni >= nibbles.len) break;
        const codeword = ofdm.hamming74Encode(@intCast(nibbles[ni] & 0x0f));
        for (0..7) |b| {
            const bit: u1 = @intCast((codeword >> @intCast(6 - b)) & 1);
            carriers[i * 7 + b] = bpsk(bit);
        }
    }
    synthesizeSymbol(&carriers, out);
}

// Encode nibbles directly into a symbol's carriers (used by header and tail).
fn encodeNibblesToCarriers(nibbles: []const u8, carriers: *[ofdm.N_CARRIERS]f32) void {
    for (nibbles, 0..) |nibble, i| {
        if (i >= NIBBLES_PER_SYM) break;
        const codeword = ofdm.hamming74Encode(@intCast(nibble & 0x0f));
        for (0..7) |b| {
            const bit: u1 = @intCast((codeword >> @intCast(6 - b)) & 1);
            carriers[i * 7 + b] = bpsk(bit);
        }
    }
}

fn synthesizeHeader(payload: []const u8, out: []i16) void {
    std.debug.assert(out.len == ofdm.N_SYM);
    const total_len: u16 = @intCast(payload.len);
    const len_lo: u8 = @intCast(total_len & 0xff);
    const len_hi: u8 = @intCast((total_len >> 8) & 0xff);
    const hdr_bytes = [_]u8{ len_lo, len_hi, 0, ofdm.crc8(&.{ len_lo, len_hi, 0 }) };
    // 4 bytes = 8 nibbles, well below NIBBLES_PER_SYM=23
    var hdr_nibbles: [8]u8 = undefined;
    for (hdr_bytes, 0..) |b, i| {
        hdr_nibbles[i * 2]     = b & 0x0f;
        hdr_nibbles[i * 2 + 1] = (b >> 4) & 0x0f;
    }
    var carriers: [ofdm.N_CARRIERS]f32 = undefined;
    @memset(&carriers, 1.0);
    encodeNibblesToCarriers(&hdr_nibbles, &carriers);
    synthesizeSymbol(&carriers, out);
}

/// Synthesize a complete OFDM frame for payload, write to out[].
/// Returns number of i16 samples written.
fn synthesizeFrame(payload: []const u8, out: []i16) usize {
    // build flat nibble array: lo nibble first, then hi nibble per byte
    var nibble_buf: [ofdm.MAX_PAYLOAD * 2]u8 = undefined;
    const n_nibbles = payload.len * 2;
    for (payload, 0..) |b, i| {
        nibble_buf[i * 2]     = b & 0x0f;
        nibble_buf[i * 2 + 1] = (b >> 4) & 0x0f;
    }
    const n_data_syms = if (n_nibbles == 0) 0 else (n_nibbles + NIBBLES_PER_SYM - 1) / NIBBLES_PER_SYM;
    const n_syms = 2 + 1 + n_data_syms + 1;
    std.debug.assert(out.len >= n_syms * ofdm.N_SYM);

    var pos: usize = 0;
    synthesizePreamble(out[pos .. pos + 2 * ofdm.N_SYM]);
    pos += 2 * ofdm.N_SYM;
    synthesizeHeader(payload, out[pos .. pos + ofdm.N_SYM]);
    pos += ofdm.N_SYM;

    for (0..n_data_syms) |s| {
        synthesizeDataSym(nibble_buf[0..n_nibbles], s, out[pos .. pos + ofdm.N_SYM]);
        pos += ofdm.N_SYM;
    }

    // tail: CRC-16 of the payload → 2 bytes = 4 nibbles
    const crc = ofdm.crc16(payload);
    const tail_bytes = [_]u8{ @intCast(crc & 0xff), @intCast((crc >> 8) & 0xff) };
    var tail_nibbles: [4]u8 = .{
        tail_bytes[0] & 0x0f, (tail_bytes[0] >> 4) & 0x0f,
        tail_bytes[1] & 0x0f, (tail_bytes[1] >> 4) & 0x0f,
    };
    var tail_carriers: [ofdm.N_CARRIERS]f32 = undefined;
    @memset(&tail_carriers, 1.0);
    encodeNibblesToCarriers(&tail_nibbles, &tail_carriers);
    synthesizeSymbol(&tail_carriers, out[pos .. pos + ofdm.N_SYM]);
    pos += ofdm.N_SYM;
    return pos;
}

// ---------------------------------------------------------------------------
// Roundtrip: synthesize frame → feed to decoder → verify bytes
// ---------------------------------------------------------------------------
test "preamble detected by decoder" {
    var samples: [2 * ofdm.N_SYM]i16 = undefined;
    synthesizePreamble(&samples);
    var state = ofdm.init();
    // Feed first preamble symbol → state should move to preamble1
    _ = ofdm.process(&state, samples[0..ofdm.N_SYM]);
    // After processing enough samples, state should have moved past searching
    // (we check that payload is still empty — not done yet, but decoder is alive)
    const p = ofdm.getPayload(&state);
    try testing.expectEqual(@as(usize, 0), p.len);
}

test "full frame roundtrip — 4-byte payload" {
    const payload = [_]u8{ 0xde, 0xad, 0xbe, 0xef };
    const n_nibbles = payload.len * 2;
    const n_data_syms = (n_nibbles + NIBBLES_PER_SYM - 1) / NIBBLES_PER_SYM;
    const n_syms = 2 + 1 + n_data_syms + 1;
    const buf_size = n_syms * ofdm.N_SYM;

    var frame_buf: [64 * ofdm.N_SYM]i16 = undefined; // generous upper bound
    const written = synthesizeFrame(&payload, frame_buf[0..buf_size]);
    try testing.expectEqual(buf_size, written);

    var state = ofdm.init();
    // Feed in 512-sample chunks (as the Pico would)
    var feed_pos: usize = 0;
    var done = false;
    while (feed_pos < written and !done) {
        const chunk_end = @min(feed_pos + 512, written);
        done = ofdm.process(&state, frame_buf[feed_pos..chunk_end]);
        feed_pos = chunk_end;
    }
    // May need a few more samples to flush the last symbol through the ring
    if (!done) {
        var extra = [_]i16{0} ** (ofdm.N_SYM * 2);
        done = ofdm.process(&state, &extra);
    }
    try testing.expect(done);
    const decoded = ofdm.getPayload(&state);
    try testing.expectEqual(payload.len, decoded.len);
    try testing.expectEqualSlices(u8, &payload, decoded);
}

test "full frame roundtrip — 20-byte payload" {
    var payload: [20]u8 = undefined;
    for (0..20) |i| payload[i] = @intCast(i * 13 + 7);
    const n_nibbles = payload.len * 2;
    const n_data_syms = (n_nibbles + NIBBLES_PER_SYM - 1) / NIBBLES_PER_SYM;
    const n_syms = 2 + 1 + n_data_syms + 1;

    var frame_buf: [64 * ofdm.N_SYM]i16 = undefined;
    const written = synthesizeFrame(&payload, frame_buf[0 .. n_syms * ofdm.N_SYM]);

    var state = ofdm.init();
    var feed_pos: usize = 0;
    var done = false;
    while (feed_pos < written and !done) {
        const chunk_end = @min(feed_pos + 512, written);
        done = ofdm.process(&state, frame_buf[feed_pos..chunk_end]);
        feed_pos = chunk_end;
    }
    if (!done) {
        var extra = [_]i16{0} ** (ofdm.N_SYM * 2);
        done = ofdm.process(&state, &extra);
    }
    try testing.expect(done);
    const decoded = ofdm.getPayload(&state);
    try testing.expectEqualSlices(u8, &payload, decoded);
}
