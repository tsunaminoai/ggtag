#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
int strncasecmp(const char *s1, const char *s2, size_t n);
int strcasecmp(const char *s1, const char *s2);
#ifdef __cplusplus
}
#endif
