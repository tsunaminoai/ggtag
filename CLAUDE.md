# GGTag — Claude Context

## Project Overview

ggtag is an e-ink conference badge system consisting of:
- **Badge firmware** (`target/`) — Raspberry Pi Pico W, built with CMake + Pico SDK (do not touch)
- **Host library** (`host/`, `shared/`) — C/C++ encoder/renderer, being ported to Zig
- **Web editor** (`docs/`) — Browser editor using WASM-compiled host library
- **Python bindings** (`python/`) — cggtag C extension wrapping the host library

## Build System

The Makefile is replaced by a Zig build script. All host library work uses `zig build`.

| Command | Purpose |
|---------|---------|
| `zig build` | Native binary (`zig-out/bin/ggtag`) |
| `zig build wasm` | WASM module (`docs/js/ggtag.wasm`) |
| `zig build test` | Run all Zig tests (calls into C via FFI) |
| `zig build debug` | Native with AddressSanitizer + UndefinedBehaviorSanitizer |
| `zig build -Dzig-debug=true` | Use Zig debug.zig instead of debug.c |
| `zig build -Dzig-rfid=true` | Use Zig rfid_stub.zig instead of rfid.cpp |

Zig version: **0.15.2**. The CMakeLists.txt (Pico firmware) is never touched by this toolchain.

## Protocol Escape-Sequence Format

Commands are concatenated escape sequences. `\\` is an escaped backslash in text/QR fields:

```
\t<x>,<y>,<font>,<text>         — Text (font 1-8, maps to 8/12/16/20/24/28/32/36pt)
\r<x>,<y>,<w>,<h>               — Rectangle (outline)
\R<x>,<y>,<w>,<h>               — Filled rectangle
\c<x>,<y>,<r>                   — Circle (outline)
\C<x>,<y>,<r>                   — Filled circle
\l<x1>,<y1>,<x2>,<y2>           — Line
\q<x>,<y>,<pw>,<text>           — QR code (pw=pixel width 1-4)
\i<x>,<y>,<w>,<h>,<base64>      — Raw bitmap (base64, 1bpp)
\I<x>,<y>,<w>,<h>,<dither>,<url>— Image from URL
\P<x>,<y>,<w>,<h>,<dither>,<b64>— PNG from base64
\a<x>,<y>,<height>,<icon_name>  — FontAwesome icon (e.g. car-side)
\f<em|hid>,<id1_hex>,<id2_hex>  — RFID programming
```

Canvas: 360×240 for 2.13" displays, 528×384 for 3.52". X is 9 bits (0-511), Y is 8 bits (0-255).

## Security Rules (enforced in all code)

1. **No unchecked multiplications** before `malloc`/`calloc` — use `(int64_t)w * h > MAX_IMAGE_PIXELS` guards
2. **All array indices must be bounds-checked** before access
3. **b64_decode requires output capacity** — signature: `bool b64_decode(in, in_len, out, out_capacity)`
4. **Text/QR escape parsing**: check `input[offset+1] != '\0'` before reading it
5. **Never use `innerHTML` with user data** in JS — always use `.textContent` or `.value`

## Incremental Zig Port Order

Each C module is replaced one at a time using feature flags in build.zig:

| Priority | Module | Flag | Status |
|----------|--------|------|--------|
| 1 | `shared/src/debug.c` | `-Dzig-debug=true` | Ported |
| 2 | `host/src/rfid.cpp` | `-Dzig-rfid=true` | Ported |
| 3 | `host/src/utils.cpp` | `-Dzig-utils=true` | Pending |
| 4 | `host/src/ggtag.cpp` | `-Dzig-encode=true` | Pending |
| 5 | `shared/src/qrcodegen.c` | — | Pending |
| 6 | `shared/src/protocol.cpp` | — | Pending |
| 7 | `shared/src/GUI_Paint.c` | — | Pending |
| 8 | `shared/include/stb_truetype.h` | — | Pending |

## WASM Shim Layer

`src/wasm_root.zig` provides the `wasm32-freestanding` target with:
- Arena allocator exposing `malloc`/`calloc`/`realloc`/`free` (4MB static heap)
- `memset`/`memcpy`/`memmove`/`memcmp`/`strlen` via Zig builtins
- `printf`/`vprintf`/`sprintf`/`fprintf` as silent no-ops
- `strncasecmp` in pure Zig
- `__assert_fail` → `@trap()` (WASM unreachable)

`src/wasm_libc_shim.h` is a C header that gates math.h and assert.h for freestanding builds.

## ggwave Submodule

The ggwave audio codec (`./ggwave/`) submodule is not cloned. To add it:
```
git submodule update --init ggwave
# then uncomment the ggwave dependency in build.zig.zon
```

## Branch Policy

- **Never push to origin/master or origin/svgs**
- All new work lives on the `zig-editor` branch
- Commit after each working phase; do not batch large commits

## Test Mandate

Rule: every code path added or modified must have a backing functional test.
- C changes: add test in `src/tests/`
- JS model logic: add test in `docs/js/editor.test.js`
- Run with `zig build test` (C) and `node docs/js/editor.test.js` (JS)

## Web Editor Architecture

The editor was rewritten from `main.js` to:
- `docs/js/model.js` — pure-logic layer (serialise, persistence, undo, schema) — testable in Node
- `docs/js/editor.js` — DOM wiring, canvas interaction, communication
- `docs/css/editor.css` — responsive CSS Grid layout (no framework)
- `docs/js/ggtag_wasm.js` — bare WASM loader replacing Emscripten's 70KB `ggtag.js`

Do not modify `docs/js/ggwave.js`, `docs/js/serial.js`, or `docs/js/recv.js`.
