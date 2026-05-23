#pragma once
// assert.h stub — all assertions disabled for WASM freestanding
#ifndef NDEBUG
#define NDEBUG
#endif
#define assert(x) ((void)(x))
