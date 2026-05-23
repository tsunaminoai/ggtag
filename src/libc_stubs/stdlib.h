#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
void* malloc(size_t size);
void* calloc(size_t nmemb, size_t size);
void* realloc(void* ptr, size_t size);
void  free(void* ptr);
__attribute__((noreturn)) void abort(void);
int   abs(int x);
long  labs(long x);
#ifdef __cplusplus
}
#endif
