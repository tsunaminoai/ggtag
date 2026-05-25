# Flashing the GGtag Pico

This guide covers how to build and flash custom firmware, and how to restore to
the original firmware.

---

## Quick orientation

The GGtag badge uses a **Raspberry Pi Pico W** (RP2040) running firmware built
with the Pico SDK and CMake. Firmware is distributed as a `.uf2` file. The Pico
boots into a USB mass-storage device when you hold the BOOTSEL button while
connecting power — you then drag-and-drop the `.uf2` to flash it.

---

## Restore to original firmware

1. Download the latest official `.uf2` from the
   [ggtag releases page](https://github.com/rgerganov/ggtag/releases).
   The file is named `ggtag.uf2`.

2. Hold the **BOOTSEL** button on the Pico, then plug in a USB cable to your
   computer (switch to the **USB** position if your badge has a hardware switch).

3. Release BOOTSEL. The badge should appear as a USB drive named `RPI-RP2`.

4. Copy `ggtag.uf2` onto the drive. The Pico reboots automatically when the
   copy finishes and the drive disappears.

5. Flip the switch to **BATT** for sound programming, or keep it on **USB** for
   serial programming.

---

## Build custom firmware from source

### Prerequisites

| Tool | Version / Notes |
|------|-----------------|
| `arm-none-eabi-gcc` | GCC 10+ (GNU Arm Embedded Toolchain) |
| `cmake` | 3.12+ |
| `ninja` or `make` | whichever you prefer |
| `git` | for submodules |
| Python 3 | required by the Pico SDK scripts |

Install on Ubuntu/Debian:
```sh
sudo apt install cmake gcc-arm-none-eabi libnewlib-arm-none-eabi \
                 libstdc++-arm-none-eabi-newlib git python3
```

Install on macOS (Homebrew):
```sh
brew install cmake arm-none-eabi-gcc
```

### Clone and set up the SDK

The Pico SDK and Pico Extras must be on your system. The simplest way is to
point the build at local checkouts via environment variables:

```sh
git clone https://github.com/raspberrypi/pico-sdk.git  ~/pico-sdk
git clone https://github.com/raspberrypi/pico-extras.git ~/pico-extras
cd ~/pico-sdk && git submodule update --init
```

Set the environment variables (add to your shell profile to make permanent):

```sh
export PICO_SDK_PATH=~/pico-sdk
export PICO_EXTRAS_PATH=~/pico-extras
```

Alternatively, edit `pico_sdk_import.cmake` in the repo root to hard-code the
paths — but the environment variable approach is cleaner.

### Clone this repo

```sh
git clone https://github.com/rgerganov/ggtag.git
cd ggtag
```

### Configure and build

```sh
mkdir build && cd build
cmake .. -DEPD=3in52-rse        # adjust EPD for your display (see below)
make -j$(nproc) ggtag
```

The output is `build/ggtag.uf2`.

#### Choosing the right EPD variant

| CMake option | Display |
|---|---|
| `-DEPD=3in52-rse` | 3.52" RSE0352N01 (default, sold on CrowdSupply) |
| `-DEPD=2in13-ws` | 2.13" Waveshare V3 |
| `-DEPD=2in13-rhink` | 2.13" RHINK-E0213A219 |

#### Deep-sleep mode

The firmware supports three deep-sleep modes (set in `CMakeLists.txt`):

| Value | Behaviour |
|---|---|
| `0` | No deep sleep — stays awake continuously |
| `1` | RTC deep sleep |
| `2` | GPIO deep sleep (default) |

To change it before building:

```sh
cmake .. -DEPD=3in52-rse -DGGTAG_DEEP_SLEEP=0
```

Or edit line 128 of `CMakeLists.txt` directly:

```cmake
set(GGTAG_DEEP_SLEEP 2)
```

### Flash the custom firmware

1. Hold BOOTSEL, plug in USB, release BOOTSEL — `RPI-RP2` drive appears.
2. Copy the `.uf2`:
   ```sh
   cp build/ggtag.uf2 /media/$USER/RPI-RP2/
   # macOS:
   cp build/ggtag.uf2 /Volumes/RPI-RP2/
   ```
3. The Pico reboots automatically.

---

## Troubleshooting

**`RPI-RP2` drive does not appear**
- Make sure you are holding BOOTSEL *before* plugging in USB and release it
  *after* the USB connection is established.
- On some systems the drive is mounted under `/run/media/<user>/RPI-RP2/`.

**Pico boots but badge shows nothing**
- Verify you passed the correct `-DEPD=` option for your display.
- Check that `PICO_EXTRAS_PATH` is set; the sleep library lives there.

**CMake error: `pico_extras_import.cmake` not found**
- Export `PICO_EXTRAS_PATH` before running `cmake`, or copy
  `$PICO_EXTRAS_PATH/external/pico_extras_import.cmake` into the repo root.

**`arm-none-eabi-gcc: command not found`**
- Make sure the toolchain is on `PATH`. On macOS the Homebrew formula installs
  it as `arm-none-eabi-gcc`; verify with `arm-none-eabi-gcc --version`.
