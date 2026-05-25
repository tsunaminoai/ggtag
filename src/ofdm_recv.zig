// OFDM decoder for ggtag badge acoustic programming (Pico-side, 24 kHz)
// Matches JS encoder: 512-pt FFT, 128-sample CP, carriers 7-170 (164 bins)
// Hamming(7,4) FEC, BPSK, CRC-8 header / CRC-16 payload verification
const std = @import("std");
const math = std.math;

pub const SAMPLE_RATE: usize = 24000;
pub const N_FFT: usize = 512;
pub const N_CP: usize = 128;
pub const N_SYM: usize = N_FFT + N_CP; // 640 samples per symbol
pub const BIN_LO: usize = 7;
pub const BIN_HI: usize = 170;
pub const N_CARRIERS: usize = BIN_HI - BIN_LO + 1; // 164
pub const MAX_PAYLOAD: usize = 2048;
// Ring buffer holds 6 symbol periods so we can search for sync with head room
const RING_SIZE: usize = N_SYM * 6;
// Minimum carrier energy ratio to consider a symbol a preamble candidate
const PREAMBLE_ENERGY_RATIO: f32 = 0.3;

const DecodeState = enum { searching, preamble1, header, data, tail, done, error_crc };

pub const OfdmState = struct {
    ring: [RING_SIZE]i16 = [_]i16{0} ** RING_SIZE,
    ring_fill: usize = 0,       // how many samples are valid
    ring_head: usize = 0,       // read position (oldest sample)
    state: DecodeState = .searching,
    chan_eq: [N_CARRIERS]f32 = [_]f32{1.0} ** N_CARRIERS,
    total_len: usize = 0,
    frame_idx: u8 = 0,
    nibble_buf: [MAX_PAYLOAD * 2]u8 = [_]u8{0} ** (MAX_PAYLOAD * 2),
    nibbles_needed: usize = 0,  // 2 * total_len
    nibbles_done: usize = 0,
    payload: [MAX_PAYLOAD]u8 = [_]u8{0} ** MAX_PAYLOAD,
    payload_len: usize = 0,
    // tail: 2 bytes → 4 nibbles
    tail_nibbles: [4]u8 = [_]u8{0} ** 4,
    tail_nibbles_done: usize = 0,
};

// ---------------------------------------------------------------------------
// CRC
// ---------------------------------------------------------------------------
pub fn crc8(data: []const u8) u8 {
    var crc: u8 = 0;
    for (data) |b| {
        crc ^= b;
        for (0..8) |_| {
            if (crc & 0x80 != 0) crc = (crc << 1) ^ 0x07
            else crc <<= 1;
        }
    }
    return crc;
}

pub fn crc16(data: []const u8) u16 {
    var crc: u16 = 0xffff;
    for (data) |b| {
        crc ^= @as(u16, b) << 8;
        for (0..8) |_| {
            if (crc & 0x8000 != 0) crc = (crc << 1) ^ 0x1021
            else crc <<= 1;
        }
    }
    return crc;
}

// ---------------------------------------------------------------------------
// Hamming(7,4) decode — syndrome correction, returns nibble 0..15
// codeword bit order (MSB first): p0 p1 d3 p2 d2 d1 d0
// ---------------------------------------------------------------------------
pub fn hamming74Decode(codeword: u7) u4 {
    const b = @as(u7, codeword);
    const p0 = (b >> 6) & 1;
    const p1 = (b >> 5) & 1;
    const d3 = (b >> 4) & 1;
    const p2 = (b >> 3) & 1;
    const d2 = (b >> 2) & 1;
    const d1 = (b >> 1) & 1;
    const d0 = (b >> 0) & 1;
    const s0 = p0 ^ d3 ^ d2 ^ d0;
    const s1 = p1 ^ d3 ^ d1 ^ d0;
    const s2 = p2 ^ d2 ^ d1 ^ d0;
    const syndrome = (s2 << 2) | (s1 << 1) | s0;
    var word = b;
    if (syndrome != 0) {
        // flip the errored bit (syndrome is 1-indexed position from MSB)
        const pos: u3 = @intCast(syndrome - 1);
        word ^= @as(u7, 1) << (6 - pos);
    }
    return @intCast(
        (((word >> 4) & 1) << 3) |
        (((word >> 2) & 1) << 2) |
        (((word >> 1) & 1) << 1) |
        ((word >> 0) & 1),
    );
}

// ---------------------------------------------------------------------------
// Hamming(7,4) encode — for test synthesis use
// ---------------------------------------------------------------------------
pub fn hamming74Encode(nibble: u4) u7 {
    const d0: u7 = (nibble >> 0) & 1;
    const d1: u7 = (nibble >> 1) & 1;
    const d2: u7 = (nibble >> 2) & 1;
    const d3: u7 = (nibble >> 3) & 1;
    const p0 = d3 ^ d2 ^ d0;
    const p1 = d3 ^ d1 ^ d0;
    const p2 = d2 ^ d1 ^ d0;
    return (p0 << 6) | (p1 << 5) | (d3 << 4) | (p2 << 3) | (d2 << 2) | (d1 << 1) | d0;
}

// ---------------------------------------------------------------------------
// Radix-2 Cooley-Tukey FFT, in-place, N must be power of 2
// inverse=true → IFFT (divides by N)
// ---------------------------------------------------------------------------
pub fn fft(re: []f32, im: []f32, inverse: bool) void {
    const N = re.len;
    std.debug.assert(N == im.len);
    std.debug.assert(N > 0 and (N & (N - 1)) == 0); // power of 2
    // bit-reversal permutation
    var j: usize = 0;
    var i: usize = 1;
    while (i < N) : (i += 1) {
        var bit = N >> 1;
        while (j & bit != 0) : (bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            std.mem.swap(f32, &re[i], &re[j]);
            std.mem.swap(f32, &im[i], &im[j]);
        }
    }
    // butterfly passes
    const sign: f32 = if (inverse) 1.0 else -1.0;
    var len: usize = 2;
    while (len <= N) : (len <<= 1) {
        const half = len >> 1;
        const ang = sign * 2.0 * math.pi / @as(f32, @floatFromInt(len));
        const w_re = @cos(ang);
        const w_im = @sin(ang);
        var start: usize = 0;
        while (start < N) : (start += len) {
            var cur_re: f32 = 1.0;
            var cur_im: f32 = 0.0;
            for (0..half) |k| {
                const u_re = re[start + k];
                const u_im = im[start + k];
                const v_re = re[start + k + half] * cur_re - im[start + k + half] * cur_im;
                const v_im = re[start + k + half] * cur_im + im[start + k + half] * cur_re;
                re[start + k]        = u_re + v_re;
                im[start + k]        = u_im + v_im;
                re[start + k + half] = u_re - v_re;
                im[start + k + half] = u_im - v_im;
                const nxt_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = nxt_re;
            }
        }
    }
    if (inverse) {
        const inv_n = 1.0 / @as(f32, @floatFromInt(N));
        for (0..N) |k| {
            re[k] *= inv_n;
            im[k] *= inv_n;
        }
    }
}

// ---------------------------------------------------------------------------
// Extract BPSK carrier values from one symbol in the ring buffer.
// offset = index of first CP sample in the ring buffer.
// Returns sign(real) per carrier after FFT + channel equalization.
// ---------------------------------------------------------------------------
fn extractCarriers(state: *const OfdmState, ring_offset: usize) [N_CARRIERS]f32 {
    var re = [_]f32{0.0} ** N_FFT;
    var im = [_]f32{0.0} ** N_FFT;
    // copy N_FFT samples starting after CP
    const data_start = ring_offset + N_CP;
    for (0..N_FFT) |k| {
        re[k] = @floatFromInt(state.ring[(data_start + k) % RING_SIZE]);
    }
    fft(&re, &im, false); // forward FFT
    var carriers: [N_CARRIERS]f32 = undefined;
    for (0..N_CARRIERS) |i| {
        const bin = BIN_LO + i;
        // divide by channel estimate (equalize amplitude)
        const eq = if (state.chan_eq[i] > 1e-6) state.chan_eq[i] else 1.0;
        carriers[i] = re[bin] / eq;
    }
    return carriers;
}

// Measure total energy in carrier bins (unnormalized, for preamble detection)
fn carrierEnergy(state: *const OfdmState, ring_offset: usize) f32 {
    var re = [_]f32{0.0} ** N_FFT;
    var im = [_]f32{0.0} ** N_FFT;
    const data_start = ring_offset + N_CP;
    for (0..N_FFT) |k| {
        re[k] = @floatFromInt(state.ring[(data_start + k) % RING_SIZE]);
    }
    fft(&re, &im, false);
    var carrier_e: f32 = 0;
    var total_e: f32 = 0;
    for (0..N_FFT / 2) |bin| {
        const e = re[bin] * re[bin] + im[bin] * im[bin];
        total_e += e;
        if (bin >= BIN_LO and bin <= BIN_HI) carrier_e += e;
    }
    if (total_e < 1.0) return 0;
    return carrier_e / total_e;
}

// Record channel estimate from a preamble symbol (all carriers = +1)
fn estimateChannel(state: *OfdmState, ring_offset: usize) void {
    var re = [_]f32{0.0} ** N_FFT;
    var im = [_]f32{0.0} ** N_FFT;
    const data_start = ring_offset + N_CP;
    for (0..N_FFT) |k| {
        re[k] = @floatFromInt(state.ring[(data_start + k) % RING_SIZE]);
    }
    fft(&re, &im, false);
    for (0..N_CARRIERS) |i| {
        const bin = BIN_LO + i;
        const mag = @sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
        state.chan_eq[i] = if (mag > 1.0) mag else 1.0;
    }
}

// Decode Hamming-encoded bits from carrier values into nibbles.
// Returns number of nibbles decoded (0..N_CARRIERS/7).
fn decodeBits(carriers: *const [N_CARRIERS]f32, nibbles_out: []u8, max_nibbles: usize) usize {
    var out_idx: usize = 0;
    var bit_pos: usize = 0;
    while (bit_pos + 7 <= N_CARRIERS and out_idx < max_nibbles) {
        var codeword: u7 = 0;
        for (0..7) |b| {
            const bit: u1 = if (carriers[bit_pos + b] < 0.0) 1 else 0;
            codeword = (codeword << 1) | bit;
        }
        nibbles_out[out_idx] = hamming74Decode(codeword);
        out_idx += 1;
        bit_pos += 7;
    }
    return out_idx;
}

// ---------------------------------------------------------------------------
// Ring buffer helpers
// ---------------------------------------------------------------------------
fn ringPush(state: *OfdmState, samples: []const i16) void {
    for (samples) |s| {
        const write_pos = (state.ring_head + state.ring_fill) % RING_SIZE;
        state.ring[write_pos] = s;
        if (state.ring_fill < RING_SIZE) {
            state.ring_fill += 1;
        } else {
            // overflow: drop oldest sample
            state.ring_head = (state.ring_head + 1) % RING_SIZE;
        }
    }
}

fn ringConsume(state: *OfdmState, n: usize) void {
    const consume = @min(n, state.ring_fill);
    state.ring_head = (state.ring_head + consume) % RING_SIZE;
    state.ring_fill -= consume;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
pub fn init() OfdmState {
    return .{};
}

pub fn reset(state: *OfdmState) void {
    state.* = .{};
}

/// Feed incoming i16 samples (any batch size).
/// Returns true when a complete valid payload has been decoded.
pub fn process(state: *OfdmState, samples: []const i16) bool {
    ringPush(state, samples);

    while (true) {
        switch (state.state) {
            .done, .error_crc => return state.state == .done,

            .searching => {
                if (state.ring_fill < N_SYM) return false;
                const ratio = carrierEnergy(state, state.ring_head);
                if (ratio >= PREAMBLE_ENERGY_RATIO) {
                    // Looks like a preamble symbol — use it for channel estimation
                    estimateChannel(state, state.ring_head);
                    ringConsume(state, N_SYM);
                    state.state = .preamble1;
                } else {
                    // Advance one sample to slide the window
                    ringConsume(state, 1);
                }
            },

            .preamble1 => {
                if (state.ring_fill < N_SYM) return false;
                const ratio = carrierEnergy(state, state.ring_head);
                if (ratio >= PREAMBLE_ENERGY_RATIO) {
                    // Second preamble symbol — refine channel estimate
                    estimateChannel(state, state.ring_head);
                    ringConsume(state, N_SYM);
                    state.state = .header;
                } else {
                    // False alarm — go back to searching
                    state.state = .searching;
                }
            },

            .header => {
                if (state.ring_fill < N_SYM) return false;
                const carriers = extractCarriers(state, state.ring_head);
                var nibbles: [8]u8 = undefined;
                const n = decodeBits(&carriers, &nibbles, nibbles.len);
                if (n < 8) { state.state = .searching; return false; }
                // Nibbles 0-1 = lo/hi of total_len LSB, 2-3 = total_len MSB, 4-5 = frame_idx, 6-7 = crc8
                const len_lo: u8 = (nibbles[1] << 4) | nibbles[0];
                const len_hi: u8 = (nibbles[3] << 4) | nibbles[2];
                const fi_byte: u8 = (nibbles[5] << 4) | nibbles[4];
                const chk_byte: u8 = (nibbles[7] << 4) | nibbles[6];
                const expected_crc = crc8(&.{ len_lo, len_hi, fi_byte });
                if (chk_byte != expected_crc or len_lo == 0 and len_hi == 0) {
                    state.state = .searching;
                    return false;
                }
                state.total_len = @as(usize, len_hi) << 8 | len_lo;
                state.frame_idx = fi_byte;
                state.nibbles_needed = state.total_len * 2; // 2 nibbles per byte
                state.nibbles_done = 0;
                state.state = .data;
                ringConsume(state, N_SYM);
            },

            .data => {
                if (state.ring_fill < N_SYM) return false;
                const carriers = extractCarriers(state, state.ring_head);
                const remaining = state.nibbles_needed - state.nibbles_done;
                const max_this_sym = N_CARRIERS / 7; // 23 nibbles per symbol
                const want = @min(remaining, max_this_sym);
                const n = decodeBits(&carriers, state.nibble_buf[state.nibbles_done..], want);
                state.nibbles_done += n;
                ringConsume(state, N_SYM);
                if (state.nibbles_done >= state.nibbles_needed) {
                    state.state = .tail;
                }
            },

            .tail => {
                if (state.ring_fill < N_SYM) return false;
                const carriers = extractCarriers(state, state.ring_head);
                var tail_nibbles: [8]u8 = undefined;
                _ = decodeBits(&carriers, &tail_nibbles, 4);
                ringConsume(state, N_SYM);
                const rx_crc: u16 = (@as(u16, (tail_nibbles[1] << 4) | tail_nibbles[0])) |
                    (@as(u16, (tail_nibbles[3] << 4) | tail_nibbles[2]) << 8);
                // Pack nibbles → payload bytes
                const len = state.total_len;
                if (len > MAX_PAYLOAD) { state.state = .searching; return false; }
                for (0..len) |i| {
                    state.payload[i] = (state.nibble_buf[i * 2 + 1] << 4) | state.nibble_buf[i * 2];
                }
                state.payload_len = len;
                const computed_crc = crc16(state.payload[0..len]);
                if (computed_crc != rx_crc) {
                    state.state = .error_crc;
                    return false;
                }
                state.state = .done;
                return true;
            },
        }
    }
}

pub fn getPayload(state: *const OfdmState) []const u8 {
    return state.payload[0..state.payload_len];
}

// C-ABI exports for future use (WASM or cross-compiled host)
export fn ofdm_recv_process(state: *OfdmState, samples: [*]const i16, n: c_int) bool {
    return process(state, samples[0..@intCast(n)]);
}

export fn ofdm_recv_get_payload(state: *const OfdmState, out: [*]u8, max: c_int) c_int {
    const p = getPayload(state);
    const copy_len = @min(p.len, @as(usize, @intCast(max)));
    @memcpy(out[0..copy_len], p[0..copy_len]);
    return @intCast(copy_len);
}

export fn ofdm_recv_reset(state: *OfdmState) void {
    reset(state);
}
