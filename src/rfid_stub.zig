// Zig replacement for host/src/rfid.cpp (host-side stub only).
// The host library does nothing for RFID — actual RFID programming
// happens on the target (Pico W firmware, not this library).
// Compile with: zig build -Dzig-rfid=true

export fn program_em_rfid(_: u8, _: u32) bool {
    return true;
}

export fn program_hid_rfid(_: u16, _: u32) bool {
    return true;
}
