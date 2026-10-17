"use strict";
const OfdmEncoder = require("./ofdm_encoder.js");
const { ofdmEncode, hamming74Encode, hamming74Decode, crc8, crc16,
        fft, makeSymbol, makePreamble,
        N_FFT, N_CP, N_SYM, BIN_LO, BIN_HI, N_CARRIERS, SCALE } = OfdmEncoder;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  PASS:", msg); }
    else       { fail++; console.error("  FAIL:", msg); }
}
function assertEq(a, b, msg) {
    if (a === b) { pass++; console.log("  PASS:", msg); }
    else         { fail++; console.error("  FAIL:", msg, `(got ${a}, expected ${b})`); }
}
function assertNear(a, b, eps, msg) {
    if (Math.abs(a - b) <= eps) { pass++; console.log("  PASS:", msg); }
    else                         { fail++; console.error("  FAIL:", msg, `(got ${a}, expected ~${b})`); }
}

// -----------------------------------------------------------------------
console.log("\n--- Hamming(7,4) encode ---");
// p0=d3^d2^d0, p1=d3^d1^d0, p2=d2^d1^d0; codeword: p0 p1 d3 p2 d2 d1 d0
assertEq(hamming74Encode(0b0000), 0b0000000, "encode nibble 0");
assertEq(hamming74Encode(0b1111), 0b1111111, "encode nibble 0xf");  // 127
assertEq(hamming74Encode(0b1010), 0b1011010, "encode nibble 0xa");  // 90
assertEq(hamming74Encode(0b0101), 0b0100101, "encode nibble 0x5");  // 37

console.log("\n--- Hamming(7,4) roundtrip ---");
for (let n = 0; n < 16; n++) {
    const decoded = hamming74Decode(hamming74Encode(n));
    assertEq(decoded, n, `roundtrip nibble ${n}`);
}

console.log("\n--- Hamming(7,4) single-bit error correction ---");
for (let n = 0; n < 16; n++) {
    const codeword = hamming74Encode(n);
    for (let b = 0; b < 7; b++) {
        const corrupted = codeword ^ (1 << b);
        const decoded = hamming74Decode(corrupted);
        assert(decoded === n, `correct bit ${b} flip in nibble ${n}`);
    }
}

console.log("\n--- CRC-8 ---");
assertEq(crc8(new Uint8Array([0x00])), 0x00, "crc8([0x00])");
// Standard CRC-8/SMBUS (poly 0x07, init 0) test vector: "123456789" → 0xF4
assertEq(crc8(new Uint8Array([0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39])), 0xf4, "crc8 standard '123456789' vector");
// Verify crc8 is deterministic and non-trivial
assert(crc8(new Uint8Array([0x01])) !== 0, "crc8([0x01]) != 0");
assert(crc8(new Uint8Array([0xab, 0xcd])) === crc8(new Uint8Array([0xab, 0xcd])), "crc8 is deterministic");

console.log("\n--- CRC-16/CCITT ---");
// Standard CRC-16/CCITT (poly 0x1021, init 0xFFFF) test vector: "123456789" → 0x29B1
assertEq(crc16(new Uint8Array([0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39])), 0x29b1, "crc16 standard '123456789' vector");
assertEq(crc16(new Uint8Array([])), 0xffff, "crc16([]) = init value");
assert(crc16(new Uint8Array([0xab, 0xcd])) === crc16(new Uint8Array([0xab, 0xcd])), "crc16 is deterministic");

console.log("\n--- FFT basic ---");
{
    // Feed a complex sinusoid at bin k=5 in a 16-pt FFT, verify peak
    const N = 16;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const k = 5;
    for (let n = 0; n < N; n++) {
        re[n] = Math.cos(2 * Math.PI * k * n / N);
        im[n] = Math.sin(2 * Math.PI * k * n / N);
    }
    fft(re, im, false);
    // Bin k should have magnitude N, all others ≈ 0
    const mag = (i) => Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    assertNear(mag(k), N, 1e-6, `FFT peak at bin ${k}`);
    let otherMax = 0;
    for (let i = 0; i < N; i++) if (i !== k) otherMax = Math.max(otherMax, mag(i));
    assert(otherMax < 1e-6, "FFT bins other than peak are near zero");
}

console.log("\n--- Preamble structure ---");
{
    const preamble = makePreamble();
    assertEq(preamble.length, 2 * N_SYM, "preamble is 2 symbols");
    // FFT the first symbol's data portion (skip CP) and check carrier magnitudes
    const sym0 = Array.from(preamble.slice(N_CP, N_CP + N_FFT));
    const re = new Float64Array(sym0);
    const im = new Float64Array(N_FFT);
    fft(re, im, false);
    // All carrier bins should have equal magnitude (all +1 → real DFT coefficients)
    let allPositive = true;
    for (let i = 0; i < N_CARRIERS; i++) {
        const bin = BIN_LO + i;
        if (re[bin] <= 0) { allPositive = false; break; }
    }
    assert(allPositive, "preamble: all carrier bins have positive real DFT value");
    // non-carrier bins near DC and above BIN_HI should be near zero
    assertNear(re[1], 0, 0.01, "preamble: bin 1 (below carrier range) is near zero");
    assertNear(re[200], 0, 0.01, "preamble: bin 200 (above carrier range) is near zero");
}

console.log("\n--- makeSymbol amplitude ---");
{
    // All-+1 carriers = worst-case coherent peak; SCALE is chosen so peak ≈ ±0.5
    const carriers = new Float64Array(N_CARRIERS).fill(1.0);
    const sym = makeSymbol(carriers);
    assertEq(sym.length, N_SYM, "symbol length = N_SYM");
    let maxAmp = 0;
    for (let i = 0; i < sym.length; i++) maxAmp = Math.max(maxAmp, Math.abs(sym[i]));
    assert(maxAmp >= 0.3,  `max amplitude ${maxAmp.toFixed(4)} >= 0.3 (audible signal, not near-zero)`);
    assert(maxAmp <= 0.501, `max amplitude ${maxAmp.toFixed(4)} <= 0.5 (no clipping)`);
}

console.log("\n--- ofdmEncode output length ---");
{
    // Empty payload: 2 preamble + 1 header + 0 data + 1 tail = 4 symbols
    const empty = ofdmEncode(new Uint8Array(0));
    assertEq(empty.length, 4 * N_SYM, "empty payload → 4 symbols");

    // 1 byte payload: 1 byte = 2 nibbles = 14 Hamming bits < 164 carriers → 1 data symbol
    const one = ofdmEncode(new Uint8Array(1));
    assertEq(one.length, 5 * N_SYM, "1-byte payload → 5 symbols (2+1+1+1)");

    // 500 bytes = 1000 nibbles, 23 nibbles/symbol → ceil(1000/23)=44 data symbols → 48 total
    const big = ofdmEncode(new Uint8Array(500));
    assertEq(big.length, 48 * N_SYM, "500-byte payload → 48 symbols");

    assert(big instanceof Float32Array, "output is Float32Array");
}

console.log("\n--- ofdmEncode amplitude ---");
{
    const out = ofdmEncode(new Uint8Array(100).fill(0xab));
    let maxAmp = 0;
    for (let i = 0; i < out.length; i++) maxAmp = Math.max(maxAmp, Math.abs(out[i]));
    assert(maxAmp >= 0.1,  `max amplitude ${maxAmp.toFixed(4)} >= 0.1 (audible, not near-zero)`);
    assert(maxAmp <= 0.501, `max amplitude ${maxAmp.toFixed(4)} stays within ±0.5`);
}

console.log("\n--- Known BPSK pattern in first data symbol ---");
{
    // Encode [0x00]: nibbles 0x0, 0x0 → Hamming(0b0000)=0b0000000 twice → all bits 0 → all +1
    const out = ofdmEncode(new Uint8Array([0x00]));
    const symOffset = 3 * N_SYM;  // skip 2 preamble + 1 header
    const re = new Float64Array(N_FFT);
    const im = new Float64Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) re[i] = out[symOffset + N_CP + i];
    fft(re, im, false);
    // First 14 carriers (the two Hamming codewords) should be positive (bit 0 → +1)
    let first14Positive = true;
    for (let i = 0; i < 14; i++) {
        if (re[BIN_LO + i] <= 0) { first14Positive = false; break; }
    }
    assert(first14Positive, "0x00 payload: first 14 data carriers are positive (all-zero Hamming bits → +1)");
}

// -----------------------------------------------------------------------
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
