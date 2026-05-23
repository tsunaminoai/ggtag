// WASM freestanding shim header.
// Included before system headers via -include flag when building for wasm32-freestanding.
// Prevents the compiler from trying to pull in the host libc.

#pragma once

// Redirect assert to our __assert_fail provided by wasm_root.zig.
// -DNDEBUG disables assert() in qrcodegen.c, but stb_truetype uses assert too.
#ifndef NDEBUG
#define NDEBUG
#endif

// math.h is included by GUI_Paint.c but no math functions are actually called.
// Define the guard so a second #include is a no-op.
#ifndef _MATH_H
#define _MATH_H
#endif
