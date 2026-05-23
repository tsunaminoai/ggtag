#pragma once
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Returns false if out_capacity is insufficient for the decoded data.
bool b64_decode(const uint8_t *in, int in_len, uint8_t *out, int out_capacity);

// Returns the codepoint of the icon with the given name, or -1 if the name is not found.
int get_codepoint(const char *name, int len);

#ifdef __cplusplus
}
#endif
