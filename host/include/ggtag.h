#pragma once
#include <stdint.h>
#include <stdbool.h>

// Clang/wasm-ld attribute: marks a function as a named WASM export and prevents
// dead-code elimination. Must appear on every declaration of the function.
// The # stringifies the token so WASM_EXPORT(render) → export_name("render").
#if defined(__WASM__) && defined(__clang__)
#  define WASM_EXPORT(sym) __attribute__((export_name(#sym), used))
#else
#  define WASM_EXPORT(sym)
#endif

#ifdef __cplusplus
extern "C" {
#endif

WASM_EXPORT(encode) uint8_t* encode(const char *input, int *length);

WASM_EXPORT(getLastError) char* getLastError();

WASM_EXPORT(render) uint8_t* render(const char *input, int width, int height);

WASM_EXPORT(renderBuffer) uint8_t* renderBuffer(const uint8_t *buf, int bits_count, int width, int height);

WASM_EXPORT(monoimage) uint8_t* monoimage(const uint8_t *rgba, int width, int height, bool dither);

#ifdef __cplusplus
}
#endif