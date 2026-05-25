#pragma once
#include <stdint.h>
#include <stdbool.h>

// OFDM decoder — 24 kHz, 512-pt FFT, 128-sample CP, carriers 7-170 (164 bins)
// Hamming(7,4) FEC, BPSK, CRC-8 header / CRC-16 payload verification

#ifdef __cplusplus
extern "C" {
#endif

typedef struct OfdmState OfdmState;

OfdmState *ofdm_recv_init(void);
void       ofdm_recv_reset(OfdmState *s);
// Feed incoming i16 samples; returns true when a complete valid payload is ready.
bool       ofdm_recv_process(OfdmState *s, const int16_t *samples, int n);
// Copy payload into out (up to max bytes); returns payload length or 0 if not done.
int        ofdm_recv_get_payload(const OfdmState *s, uint8_t *out, int max);

#ifdef __cplusplus
}
#endif
