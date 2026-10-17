#include "ofdm_recv.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define N_FFT        512
#define N_CP         128
#define N_SYM        640   // N_FFT + N_CP
#define BIN_LO       7
#define BIN_HI       170
#define N_CARRIERS   164   // BIN_HI - BIN_LO + 1
#define MAX_PAYLOAD  2048
#define RING_SIZE    (N_SYM * 6)  // 6 symbol periods of buffer
#define NIBBLES_PER_SYM  (N_CARRIERS / 7)  // 23
#define PREAMBLE_ENERGY_RATIO  0.3f

typedef enum {
    ST_SEARCHING,
    ST_PREAMBLE1,
    ST_HEADER,
    ST_DATA,
    ST_TAIL,
    ST_DONE,
    ST_ERROR_CRC,
} DecodeState;

struct OfdmState {
    int16_t  ring[RING_SIZE];
    int      ring_fill;
    int      ring_head;
    DecodeState state;
    float    chan_eq[N_CARRIERS];
    int      total_len;
    uint8_t  frame_idx;
    uint8_t  nibble_buf[MAX_PAYLOAD * 2];
    int      nibbles_needed;
    int      nibbles_done;
    uint8_t  payload[MAX_PAYLOAD];
    int      payload_len;
};

// ---------------------------------------------------------------------------
// CRC
// ---------------------------------------------------------------------------
static uint8_t crc8(const uint8_t *data, int len) {
    uint8_t crc = 0;
    for (int i = 0; i < len; i++) {
        crc ^= data[i];
        for (int b = 0; b < 8; b++)
            crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1);
    }
    return crc;
}

static uint16_t crc16(const uint8_t *data, int len) {
    uint16_t crc = 0xffff;
    for (int i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++)
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
    return crc;
}

// ---------------------------------------------------------------------------
// Hamming(7,4) decode — syndrome correction
// codeword bit order (MSB first): p0 p1 d3 p2 d2 d1 d0
// ---------------------------------------------------------------------------
static uint8_t hamming74_decode(uint8_t codeword) {
    codeword &= 0x7f;
    uint8_t p0 = (codeword >> 6) & 1;
    uint8_t p1 = (codeword >> 5) & 1;
    uint8_t d3 = (codeword >> 4) & 1;
    uint8_t p2 = (codeword >> 3) & 1;
    uint8_t d2 = (codeword >> 2) & 1;
    uint8_t d1 = (codeword >> 1) & 1;
    uint8_t d0 = (codeword >> 0) & 1;
    uint8_t s0 = p0 ^ d3 ^ d2 ^ d0;
    uint8_t s1 = p1 ^ d3 ^ d1 ^ d0;
    uint8_t s2 = p2 ^ d2 ^ d1 ^ d0;
    int syndrome = (s2 << 2) | (s1 << 1) | s0;
    if (syndrome) codeword ^= (1 << (6 - (syndrome - 1)));
    return ((codeword >> 4) & 1) << 3 | ((codeword >> 2) & 1) << 2 |
           ((codeword >> 1) & 1) << 1 | ((codeword >> 0) & 1);
}

// ---------------------------------------------------------------------------
// Radix-2 Cooley-Tukey FFT, in-place; inverse divides by N
// ---------------------------------------------------------------------------
static void fft512(float *re, float *im, int inverse) {
    const int N = N_FFT;
    // bit-reversal permutation
    int j = 0;
    for (int i = 1; i < N; i++) {
        int bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float t; t = re[i]; re[i] = re[j]; re[j] = t;
                     t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    const float sign = inverse ? 1.0f : -1.0f;
    for (int len = 2; len <= N; len <<= 1) {
        int half = len >> 1;
        float ang = sign * 2.0f * (float)M_PI / (float)len;
        float w_re = cosf(ang), w_im = sinf(ang);
        for (int start = 0; start < N; start += len) {
            float cur_re = 1.0f, cur_im = 0.0f;
            for (int k = 0; k < half; k++) {
                float u_re = re[start+k], u_im = im[start+k];
                float v_re = re[start+k+half]*cur_re - im[start+k+half]*cur_im;
                float v_im = re[start+k+half]*cur_im + im[start+k+half]*cur_re;
                re[start+k]       = u_re + v_re; im[start+k]       = u_im + v_im;
                re[start+k+half]  = u_re - v_re; im[start+k+half]  = u_im - v_im;
                float nxt = cur_re*w_re - cur_im*w_im;
                cur_im = cur_re*w_im + cur_im*w_re;
                cur_re = nxt;
            }
        }
    }
    if (inverse) {
        float inv = 1.0f / (float)N;
        for (int i = 0; i < N; i++) { re[i] *= inv; im[i] *= inv; }
    }
}

// ---------------------------------------------------------------------------
// Ring buffer helpers
// ---------------------------------------------------------------------------
static void ring_push(OfdmState *s, const int16_t *samples, int n) {
    for (int i = 0; i < n; i++) {
        int wp = (s->ring_head + s->ring_fill) % RING_SIZE;
        s->ring[wp] = samples[i];
        if (s->ring_fill < RING_SIZE) {
            s->ring_fill++;
        } else {
            s->ring_head = (s->ring_head + 1) % RING_SIZE;
        }
    }
}

static void ring_consume(OfdmState *s, int n) {
    if (n > s->ring_fill) n = s->ring_fill;
    s->ring_head = (s->ring_head + n) % RING_SIZE;
    s->ring_fill -= n;
}

// ---------------------------------------------------------------------------
// FFT a symbol window from ring buffer, return carrier energy ratio
// ---------------------------------------------------------------------------
static float carrier_energy(OfdmState *s, int ring_off) {
    float re[N_FFT] = {0}, im[N_FFT] = {0};
    int start = (ring_off + N_CP) % RING_SIZE;
    for (int k = 0; k < N_FFT; k++)
        re[k] = (float)s->ring[(start + k) % RING_SIZE];
    fft512(re, im, 0);
    float carrier_e = 0, total_e = 0;
    for (int b = 0; b < N_FFT/2; b++) {
        float e = re[b]*re[b] + im[b]*im[b];
        total_e += e;
        if (b >= BIN_LO && b <= BIN_HI) carrier_e += e;
    }
    return (total_e < 1.0f) ? 0.0f : carrier_e / total_e;
}

static void estimate_channel(OfdmState *s, int ring_off) {
    float re[N_FFT] = {0}, im[N_FFT] = {0};
    int start = (ring_off + N_CP) % RING_SIZE;
    for (int k = 0; k < N_FFT; k++)
        re[k] = (float)s->ring[(start + k) % RING_SIZE];
    fft512(re, im, 0);
    for (int i = 0; i < N_CARRIERS; i++) {
        int bin = BIN_LO + i;
        float mag = sqrtf(re[bin]*re[bin] + im[bin]*im[bin]);
        s->chan_eq[i] = (mag > 1.0f) ? mag : 1.0f;
    }
}

// Extract BPSK values after equalization; returns N_CARRIERS floats in 'out'.
static void extract_carriers(OfdmState *s, int ring_off, float *out) {
    float re[N_FFT] = {0}, im[N_FFT] = {0};
    int start = (ring_off + N_CP) % RING_SIZE;
    for (int k = 0; k < N_FFT; k++)
        re[k] = (float)s->ring[(start + k) % RING_SIZE];
    fft512(re, im, 0);
    for (int i = 0; i < N_CARRIERS; i++) {
        int bin = BIN_LO + i;
        float eq = (s->chan_eq[i] > 1e-6f) ? s->chan_eq[i] : 1.0f;
        out[i] = re[bin] / eq;
    }
}

// Decode Hamming codewords from carrier values into nibbles.
// Returns number of nibbles decoded (up to max_nibbles).
static int decode_bits(const float *carriers, uint8_t *nibbles, int max_nibbles) {
    int out = 0, bit_pos = 0;
    while (bit_pos + 7 <= N_CARRIERS && out < max_nibbles) {
        uint8_t cw = 0;
        for (int b = 0; b < 7; b++)
            cw = (cw << 1) | (carriers[bit_pos + b] < 0.0f ? 1 : 0);
        nibbles[out++] = hamming74_decode(cw);
        bit_pos += 7;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
OfdmState *ofdm_recv_init(void) {
    OfdmState *s = (OfdmState *)malloc(sizeof(OfdmState));
    if (!s) return NULL;
    ofdm_recv_reset(s);
    return s;
}

void ofdm_recv_reset(OfdmState *s) {
    memset(s, 0, sizeof(OfdmState));
    for (int i = 0; i < N_CARRIERS; i++) s->chan_eq[i] = 1.0f;
}

bool ofdm_recv_process(OfdmState *s, const int16_t *samples, int n) {
    ring_push(s, samples, n);
    float carriers[N_CARRIERS];

    while (1) {
        switch (s->state) {
        case ST_DONE:
        case ST_ERROR_CRC:
            return s->state == ST_DONE;

        case ST_SEARCHING:
            if (s->ring_fill < N_SYM) return false;
            if (carrier_energy(s, s->ring_head) >= PREAMBLE_ENERGY_RATIO) {
                estimate_channel(s, s->ring_head);
                ring_consume(s, N_SYM);
                s->state = ST_PREAMBLE1;
            } else {
                ring_consume(s, 1);
            }
            break;

        case ST_PREAMBLE1:
            if (s->ring_fill < N_SYM) return false;
            if (carrier_energy(s, s->ring_head) >= PREAMBLE_ENERGY_RATIO) {
                estimate_channel(s, s->ring_head);
                ring_consume(s, N_SYM);
                s->state = ST_HEADER;
            } else {
                s->state = ST_SEARCHING;
            }
            break;

        case ST_HEADER: {
            if (s->ring_fill < N_SYM) return false;
            extract_carriers(s, s->ring_head, carriers);
            uint8_t nibbles[8];
            int n8 = decode_bits(carriers, nibbles, 8);
            if (n8 < 8) { s->state = ST_SEARCHING; return false; }
            uint8_t len_lo = (nibbles[1] << 4) | nibbles[0];
            uint8_t len_hi = (nibbles[3] << 4) | nibbles[2];
            uint8_t fi     = (nibbles[5] << 4) | nibbles[4];
            uint8_t chk    = (nibbles[7] << 4) | nibbles[6];
            uint8_t hdr3[3] = { len_lo, len_hi, fi };
            if (chk != crc8(hdr3, 3) || (len_lo == 0 && len_hi == 0)) {
                s->state = ST_SEARCHING;
                return false;
            }
            s->total_len      = ((int)len_hi << 8) | len_lo;
            s->frame_idx      = fi;
            s->nibbles_needed = s->total_len * 2;
            s->nibbles_done   = 0;
            s->state          = ST_DATA;
            ring_consume(s, N_SYM);
            break;
        }

        case ST_DATA:
            if (s->ring_fill < N_SYM) return false;
            extract_carriers(s, s->ring_head, carriers);
            {
                int remaining = s->nibbles_needed - s->nibbles_done;
                int want = remaining < NIBBLES_PER_SYM ? remaining : NIBBLES_PER_SYM;
                int n_dec = decode_bits(carriers, s->nibble_buf + s->nibbles_done, want);
                s->nibbles_done += n_dec;
            }
            ring_consume(s, N_SYM);
            if (s->nibbles_done >= s->nibbles_needed) s->state = ST_TAIL;
            break;

        case ST_TAIL: {
            if (s->ring_fill < N_SYM) return false;
            extract_carriers(s, s->ring_head, carriers);
            uint8_t tail_nib[8];
            decode_bits(carriers, tail_nib, 4);
            ring_consume(s, N_SYM);
            uint16_t rx_crc = ((uint16_t)((tail_nib[1] << 4) | tail_nib[0])) |
                              ((uint16_t)((tail_nib[3] << 4) | tail_nib[2]) << 8);
            int len = s->total_len;
            if (len > MAX_PAYLOAD) { s->state = ST_SEARCHING; return false; }
            for (int i = 0; i < len; i++)
                s->payload[i] = (s->nibble_buf[i*2+1] << 4) | s->nibble_buf[i*2];
            s->payload_len = len;
            if (crc16(s->payload, len) != rx_crc) {
                s->state = ST_ERROR_CRC;
                return false;
            }
            s->state = ST_DONE;
            return true;
        }
        }
    }
}

int ofdm_recv_get_payload(const OfdmState *s, uint8_t *out, int max) {
    int n = s->payload_len < max ? s->payload_len : max;
    if (n > 0) memcpy(out, s->payload, n);
    return n;
}
