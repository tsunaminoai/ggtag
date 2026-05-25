// OFDM encoder for ggtag badge acoustic programming
// 1024-pt IFFT @ 48 kHz, 256-sample CP, 164 carriers (bins 7-170)
// Hamming(7,4) FEC, BPSK modulation, real-valued output via Hermitian symmetry
const OfdmEncoder = (() => {
    const SAMPLE_RATE  = 48000;
    const N_FFT        = 1024;    // IFFT size
    const N_CP         = 256;     // cyclic prefix length
    const N_SYM        = N_FFT + N_CP;  // 1280 samples per symbol @ 48 kHz = 26.7 ms
    const BIN_LO       = 7;       // first carrier bin (≈328 Hz)
    const BIN_HI       = 170;     // last carrier bin (≈7969 Hz)
    const N_CARRIERS   = BIN_HI - BIN_LO + 1;  // 164
    // Worst-case coherent peak (all 164 carriers = +1): N_CARRIERS * (2/N_FFT) after IFFT.
    // SCALE = 1 / (N_CARRIERS * 2/N_FFT * 2) = N_FFT / (4 * N_CARRIERS) ≈ 1.56 → peak = ±0.5
    const SCALE        = N_FFT / (4 * N_CARRIERS);

    // --- Hamming(7,4) --------------------------------------------------
    // G matrix (systematic form): each row is the 7-bit codeword for data bits d3..d0
    // p0 = d3^d2^d0, p1 = d3^d1^d0, p2 = d2^d1^d0
    // codeword bit order: p0 p1 d3 p2 d2 d1 d0
    function hamming74Encode(nibble) {
        const d0 = (nibble >> 0) & 1;
        const d1 = (nibble >> 1) & 1;
        const d2 = (nibble >> 2) & 1;
        const d3 = (nibble >> 3) & 1;
        const p0 = d3 ^ d2 ^ d0;
        const p1 = d3 ^ d1 ^ d0;
        const p2 = d2 ^ d1 ^ d0;
        return (p0 << 6) | (p1 << 5) | (d3 << 4) | (p2 << 3) | (d2 << 2) | (d1 << 1) | d0;
    }

    function hamming74Decode(codeword) {
        const b = (codeword >>> 0) & 0x7f;
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
        let word = b;
        if (syndrome !== 0) {
            // correct single-bit error (bit positions 1-indexed in standard Hamming)
            const pos = syndrome - 1;  // 0-indexed from MSB of 7-bit word
            word ^= (1 << (6 - pos));
        }
        return ((word >> 4) & 1) << 3 | ((word >> 2) & 1) << 2 |
               ((word >> 1) & 1) << 1 | ((word >> 0) & 1);
    }

    // --- CRC -----------------------------------------------------------
    function crc8(data) {
        let crc = 0;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let b = 0; b < 8; b++)
                crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
        return crc;
    }

    function crc16(data) {
        let crc = 0xffff;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i] << 8;
            for (let b = 0; b < 8; b++)
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
        return crc;
    }

    // --- Radix-2 Cooley-Tukey FFT/IFFT ---------------------------------
    // in-place, N must be power of 2
    // inverse=true → IFFT (divide by N at end)
    function fft(re, im, inverse) {
        const N = re.length;
        // bit-reversal permutation
        let j = 0;
        for (let i = 1; i < N; i++) {
            let bit = N >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        // butterfly passes
        const sign = inverse ? 1 : -1;
        for (let len = 2; len <= N; len <<= 1) {
            const half = len >> 1;
            const ang = sign * 2 * Math.PI / len;
            const wRe = Math.cos(ang);
            const wIm = Math.sin(ang);
            for (let i = 0; i < N; i += len) {
                let curRe = 1, curIm = 0;
                for (let k = 0; k < half; k++) {
                    const uRe = re[i + k], uIm = im[i + k];
                    const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
                    const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
                    re[i + k]        = uRe + vRe;
                    im[i + k]        = uIm + vIm;
                    re[i + k + half] = uRe - vRe;
                    im[i + k + half] = uIm - vIm;
                    const nextRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = nextRe;
                }
            }
        }
        if (inverse) {
            for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
        }
    }

    // --- BPSK ----------------------------------------------------------
    function bpsk(bit) { return bit ? -1.0 : 1.0; }

    // --- Symbol synthesis ----------------------------------------------
    // carriers: Float64Array[N_CARRIERS], values ±1 (BPSK)
    // Returns Float32Array[N_SYM] = CP + IFFT output, scaled to ±0.5
    function makeSymbol(carriers) {
        const re = new Float64Array(N_FFT);
        const im = new Float64Array(N_FFT);
        for (let i = 0; i < N_CARRIERS; i++) {
            const bin = BIN_LO + i;
            const v = carriers[i];
            re[bin] = v;               // Hermitian: positive frequencies
            re[N_FFT - bin] = v;       // mirror (conjugate of real = real)
            // imaginary parts stay 0 → real-valued output
        }
        fft(re, im, true);  // IFFT
        const out = new Float32Array(N_SYM);
        // cyclic prefix = last N_CP samples
        for (let i = 0; i < N_CP; i++)
            out[i] = re[N_FFT - N_CP + i] * SCALE;
        for (let i = 0; i < N_FFT; i++)
            out[N_CP + i] = re[i] * SCALE;
        return out;
    }

    // --- Frame assembly helpers ----------------------------------------
    function makePreamble() {
        const carriers = new Float64Array(N_CARRIERS).fill(1.0);
        const sym = makeSymbol(carriers);
        const out = new Float32Array(2 * N_SYM);
        out.set(sym, 0);
        out.set(sym, N_SYM);
        return out;
    }

    // Pack Hamming-encoded bits into carrier array, starting at carrier offset.
    // Returns number of carriers consumed.
    function packBits(bits, carriers, offset) {
        let pos = offset;
        for (let i = 0; i < bits.length && pos < N_CARRIERS; i++, pos++)
            carriers[pos] = bpsk(bits[i]);
        return pos - offset;
    }

    // Hamming-encode a byte array, return bit array (one entry per coded bit)
    function hammingEncodeBits(bytes) {
        const bits = [];
        for (let i = 0; i < bytes.length; i++) {
            const lo = bytes[i] & 0x0f;
            const hi = (bytes[i] >> 4) & 0x0f;
            const clo = hamming74Encode(lo);
            const chi = hamming74Encode(hi);
            for (let b = 6; b >= 0; b--) bits.push((clo >> b) & 1);
            for (let b = 6; b >= 0; b--) bits.push((chi >> b) & 1);
        }
        return bits;
    }

    function makeHeader(totalLen, frameIdx, payload) {
        const chk = crc8(new Uint8Array([totalLen & 0xff, (totalLen >> 8) & 0xff, frameIdx]));
        const hdrBytes = new Uint8Array([totalLen & 0xff, (totalLen >> 8) & 0xff, frameIdx, chk]);
        const bits = hammingEncodeBits(hdrBytes);  // 4 bytes → 56 Hamming bits
        const carriers = new Float64Array(N_CARRIERS).fill(1.0);  // unset carriers = +1 for equalization
        for (let i = 0; i < bits.length && i < N_CARRIERS; i++)
            carriers[i] = bpsk(bits[i]);
        return makeSymbol(carriers);
    }

    // 23 complete Hamming codewords per symbol (23×7=161 bits).
    // Carriers 161-163 padded to +1; decoder also extracts 23 nibbles/symbol → boundaries align.
    const NIBBLES_PER_SYM = Math.floor(N_CARRIERS / 7); // 23

    function makeDataSymbols(payload) {
        // flat nibble array: lo nibble first, then hi nibble, for each byte
        const nibbles = [];
        for (let i = 0; i < payload.length; i++) {
            nibbles.push(payload[i] & 0x0f);
            nibbles.push((payload[i] >> 4) & 0x0f);
        }
        const nSymbols = nibbles.length === 0 ? 0 : Math.ceil(nibbles.length / NIBBLES_PER_SYM);
        const out = new Float32Array(nSymbols * N_SYM);
        for (let s = 0; s < nSymbols; s++) {
            const carriers = new Float64Array(N_CARRIERS).fill(1.0);
            for (let i = 0; i < NIBBLES_PER_SYM; i++) {
                const ni = s * NIBBLES_PER_SYM + i;
                if (ni >= nibbles.length) break;
                const codeword = hamming74Encode(nibbles[ni]);
                for (let b = 0; b < 7; b++)
                    carriers[i * 7 + b] = bpsk((codeword >> (6 - b)) & 1);
            }
            out.set(makeSymbol(carriers), s * N_SYM);
        }
        return out;
    }

    function makeTail(payload) {
        const chk = crc16(payload);
        const tailBytes = new Uint8Array([chk & 0xff, (chk >> 8) & 0xff]);
        const bits = hammingEncodeBits(tailBytes);  // 2 bytes → 28 Hamming bits
        const carriers = new Float64Array(N_CARRIERS).fill(1.0);
        for (let i = 0; i < bits.length && i < N_CARRIERS; i++)
            carriers[i] = bpsk(bits[i]);
        return makeSymbol(carriers);
    }

    // --- Public API ----------------------------------------------------
    function ofdmEncode(data) {
        const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
        const preamble   = makePreamble();
        const header     = makeHeader(payload.length, 0, payload);
        const dataSyms   = makeDataSymbols(payload);
        const tail       = makeTail(payload);
        const total = preamble.length + header.length + dataSyms.length + tail.length;
        const out = new Float32Array(total);
        let pos = 0;
        out.set(preamble,  pos); pos += preamble.length;
        out.set(header,    pos); pos += header.length;
        out.set(dataSyms,  pos); pos += dataSyms.length;
        out.set(tail,      pos);
        return out;
    }

    return {
        ofdmEncode,
        // expose internals for testing
        hamming74Encode, hamming74Decode,
        crc8, crc16,
        fft,
        makeSymbol,
        makePreamble,
        SAMPLE_RATE, N_FFT, N_CP, N_SYM, BIN_LO, BIN_HI, N_CARRIERS, SCALE,
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = OfdmEncoder;
