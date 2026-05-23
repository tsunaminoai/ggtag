#pragma once
#include <stdbool.h>

#if defined(__WASM__) && defined(__clang__)
#  define WASM_EXPORT(sym) __attribute__((export_name(#sym), used))
#else
#  define WASM_EXPORT(sym)
#endif

#ifdef __cplusplus
extern "C" {
#endif

WASM_EXPORT(debugEnable) void debugEnable(bool enable);

int debug(const char *format, ...);

#ifdef __cplusplus
}
#endif