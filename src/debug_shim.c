// C shim that bridges the variadic debug() call to the Zig debug module.
// Used when -Dzig-debug=true is set in the Zig build.
#include "debug.h"
#include <stdarg.h>
#include <stdio.h>

bool debugIsEnabled(void);

int debug(const char *format, ...)
{
    if (!debugIsEnabled()) {
        return 0;
    }
    va_list args;
    va_start(args, format);
    int ret = vprintf(format, args);
    va_end(args);
    return ret;
}
