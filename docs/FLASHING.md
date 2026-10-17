# Flashing the GGtag Pico

## Build and flash custom firmware

```sh
# Build (default EPD: 3in52-rse)
devbox run firmware:build

# Override display variant
EPD=2in13-ws devbox run firmware:build

# Flash — hold BOOTSEL, replug USB, then:
devbox run firmware:flash
```

`firmware:build` runs CMake into `build-pico/` and produces `build-pico/ggtag.uf2`.
`firmware:flash` auto-detects the `RPI-RP2` USB drive and copies the file.

The devbox environment provides `cmake`, `gcc-arm-embedded`, and `make`.
You still need `PICO_SDK_PATH` and `PICO_EXTRAS_PATH` pointing at local SDK checkouts:

```sh
export PICO_SDK_PATH=~/pico-sdk
export PICO_EXTRAS_PATH=~/pico-extras
```

Clone them once if you haven't already:

```sh
git clone https://github.com/raspberrypi/pico-sdk.git ~/pico-sdk
git clone https://github.com/raspberrypi/pico-extras.git ~/pico-extras
cd ~/pico-sdk && git submodule update --init
```

## Display variants

| `EPD=` value | Display |
|---|---|
| `3in52-rse` | 3.52" RSE0352N01 (default, CrowdSupply badge) |
| `2in13-ws` | 2.13" Waveshare V3 |
| `2in13-rhink` | 2.13" RHINK-E0213A219 |

## Restore to original firmware

1. Download `ggtag.uf2` from the [releases page](https://github.com/rgerganov/ggtag/releases).
2. Hold BOOTSEL, plug in USB, release BOOTSEL — `RPI-RP2` drive appears.
3. Copy the file onto the drive; the Pico reboots automatically.
