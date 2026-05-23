# GGTag — Project Retrospective & Next Steps

---

## Project Retrospective

**Branch:** `zig-editor`
**Key commits:** `8734b40` → `44b37fa` → `68ae35e` (+ session work, uncommitted)

---

### Phase A — Build system & foundation (`8734b40`)

- Replaced `Makefile` with Zig build system (`build.zig`, `build.zig.zon`)
- Added `src/wasm_root.zig` — freestanding WASM shim (arena allocator, memset/memcpy, printf stubs, math stubs) enabling `wasm32-freestanding` without Emscripten
- Added `src/wasm_libc_shim.h` — C header gating math.h and assert.h for freestanding builds
- Added `docs/js/ggtag_wasm.js` — lean WASM loader (replaces 70 KB Emscripten shell)
- Migrated web editor from `docs/js/main.js` to two-layer architecture:
  - `docs/js/model.js` — pure logic (schema, serialise, persistence, undo/redo), Node-testable
  - `docs/js/editor.js` — DOM wiring, canvas interaction, WASM calls
- `docs/css/editor.css` — responsive CSS Grid layout
- Security fixes: bounds checks before multiplications, `innerHTML` → `textContent`, b64_decode capacity enforcement
- Zig port started: `src/debug.zig` (`-Dzig-debug=true`), `src/rfid_stub.zig` (`-Dzig-rfid=true`)

---

### Phase B — Canvas-first editor redesign (`44b37fa`)

- Removed form-driven command toolbar; replaced with right-click context menu
- Right-click on canvas → context menu places commands at click coordinates
- Click any rendered element → selects it, drag handles appear
- Drag handles → reposition/resize all element types; handles repaint synchronously in `_onMove` (no lag/misalignment)
- `getBBox(cmd)` in `model.js` — per-type bounding box for hit-testing and overlay outlines
- `getHandles(cmd)` — per-type drag handle geometry (tl/tr/bl/br/move for rects, center/edge for circles, p1/p2 for lines, origin for text/QR/icon, `_x`/`_y` for RFID)
- RFID rendered as draggable grey rounded-rect tag on canvas
- Compact layer list with type-coloured pills and delete button
- Props panel shows only non-spatial fields (spatial fields are handle-edited)
- Auto-focus text input when text/QR command selected
- Delete/Backspace removes selected command when no input is focused
- Ctrl+Z/Y undo/redo
- **135 JS tests** in `docs/js/editor.test.js`

---

### Phase C — WASM blank canvas fix (`68ae35e`)

Two bugs in `src/wasm_root.zig`:

1. **`realloc` was a no-op** — `BitBuffer::ensureCapacity` discarded previously-written bits when it grew. Fix: 4-byte size header before each arena block so `realloc` can read old size and memcpy the data.
2. **`sprintf` wrote only a null terminator** — `sprintf(lastError, "OK")` produced `""`, so the JS error banner was always visible. Fix: `sprintf` now copies the format string verbatim.

---

### Phase D — In-session improvements (uncommitted)

| File | Changes |
| ---- | ------- |
| `docs/js/model.js` | QR bounding box: `pw * 21` (was `pw * 56`); exports unchanged |
| `docs/js/editor.js` | QR overlay fixed; `_handleDrop` accepts all `image/*` types (PNG, JPEG, WebP, SVG) via data URL + canvas rasterise → `BMPImage`; `_updateTxEstimate()` debounced 600 ms; `_stopTx()` stop button; scrolling spectrogram via AnalyserNode; image auto-size writes resolved dims back to params on first load; `programSound` with isTxing flag, stop check, currentTxSrc ref |
| `docs/index.html` | `#ggViz` (360×60 spectrogram canvas); `#btnStop`; `#txTimeEst`; `#txProgress` bar; v1.3.0 |
| `docs/css/editor.css` | Styles for all new elements above |
| `docs/js/editor.test.js` | QR bbox assertion: 42 (pw=2 × 21) |

**All tests pass:** 135 JS model tests, Zig build test suite.

---

## Next Session — OFDM Audio Protocol

### Goal

Replace sequential ggwave FSK with a custom OFDM protocol for a ~23× throughput improvement: 500-byte badge design in **< 2 seconds** vs current ~31 seconds.

### Why OFDM

Current ggwave sends one symbol at a time across a narrow frequency band (~16 bytes/sec payload). OFDM transmits 165 carriers simultaneously, each independently modulated — full-spectrum use in every symbol period.

### Key Numbers

| Parameter | Value |
| --------- | ----- |
| Pico RX sample rate | 24,000 Hz |
| Pico frame size | 512 samples = 21.3 ms |
| PDM decimation | 64× (1.536 MHz → 24 kHz) |
| Browser TX sample rate | 48,000 Hz |
| OFDM symbol period | 640 samples = 26.7 ms (512 + 128 cyclic prefix) |
| Usable carriers (300 Hz–8 kHz) | 165 bins |
| Throughput with BPSK + Hamming(7,4) | ~374 bytes/sec |
| Speedup vs ggwave | ~23× |

### Frame Structure

```text
[PREAMBLE]  2 symbols — all bins at +1, used for sync and channel estimation
[HEADER]    1 symbol  — total_len:u16, frame_idx:u8, crc8:u8, zero-padded
[DATA]      ceil(n/20) symbols — Hamming(7,4) encoded payload, symbol-aligned
[TAIL]      1 symbol  — CRC-16 of full reconstructed payload
```

### Implementation Steps

**Step 1 — JS Encoder** (`docs/js/ofdm_encoder.js`)

```js
// ofdmEncode(data: Uint8Array, sampleRate: number): Float32Array
```

- Hamming(7,4) encode → BPSK map (0→+1, 1→−1) per carrier bin
- IFFT 512-point → prepend 128-sample cyclic prefix → scale to ±0.5
- Prepend 2 preamble symbols
- Return concatenated `Float32Array` ready for Web Audio playback
- No external deps — pure JS, Cooley-Tukey radix-2 FFT

**Step 2 — Zig Decoder** (`src/ofdm_recv.zig`)

```zig
pub fn processFrame(samples: []const i16, state: *OfdmState) ?[]const u8
```

- Accumulate 640-sample ring buffer
- Sync via cross-correlation with preamble pattern
- 512-point FFT (after stripping cyclic prefix) — use Pico SDK `fix_fft` or implement radix-2 integer FFT
- One-tap channel equalizer: divide each bin by preamble's measured response
- `sign(real)` per bin → bit → Hamming(7,4) decode → bytes
- Assemble until `total_len` bytes received, verify CRC-16, deliver to existing `renderBits()` pipeline

**Step 3 — Pico integration** (`target/src/main.cpp`)

- Add `OfdmState` alongside existing `ggwave` instance
- Feed audio samples to OFDM decoder first; fall back to ggwave after 500 ms no-sync
- No changes needed downstream of `renderBits()`

**Step 4 — Browser integration** (`docs/js/editor.js`)

- Add `programOfdm(data)` using the JS encoder
- Add "OFDM" radio button next to Sound/Serial in footer
- Keep ggwave as fallback
- Existing progress bar and spectrogram reused as-is

**Step 5 — Tests**

- Node: `encode(100 bytes) → waveform → decode → assert identical bytes`; add Gaussian noise at multiple SNR levels
- Zig: generate waveform, feed to `processFrame`, assert decoded bytes (`zig build test`)
- Hardware: load firmware, transmit from browser, verify render + measure wall-clock time

### Critical Files

| File | Role |
| ---- | ---- |
| `docs/js/ofdm_encoder.js` | New — JS OFDM encoder |
| `docs/js/editor.js` | Add `programOfdm()`, OFDM radio button |
| `src/ofdm_recv.zig` | New — Zig OFDM decoder |
| `target/src/main.cpp` | Add OFDM decode path |
| `docs/js/editor.test.js` | Encoder/decoder roundtrip tests |

### Open Questions

1. **Coexistence**: OFDM alongside ggwave (user picks) or replace it? Suggest: alongside, OFDM as default for Sound mode.
2. **FEC**: Hamming(7,4) is trivial but 43% overhead. Use Reed-Solomon instead? The existing `qrcodegen.c` already has GF(2^8) arithmetic that could be reused.
3. **FFT precision**: Fixed-point Q15 FFT (faster on M0+, no FPU) vs float FFT (simpler) for v1?
