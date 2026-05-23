"use strict";
// ggtag_wasm.js — minimal WASM loader (~90 lines) replacing the 2 kLOC Emscripten ggtag.js.
// Exposes a `Module` global with the same ccall/HEAP*/getValue/_malloc/_free API surface.

const Module = (() => {
    // Capture before async — document.currentScript is null inside async fns.
    const _scriptSrc = typeof document !== "undefined" ? document.currentScript?.src : null;
    let _exp = null; // WASM instance exports, populated after load

    function _buf() { return _exp.memory.buffer; }

    const mod = {
        // Always-fresh typed array views. WASM memory.grow() invalidates old buffers,
        // so we create a new view on every access rather than caching.
        get HEAP8()  { return new Int8Array(_buf()); },
        get HEAPU8() { return new Uint8Array(_buf()); },
        get HEAP32() { return new Int32Array(_buf()); },

        _malloc(size) { return _exp.malloc(size); },
        _free(ptr)    { _exp.free(ptr); },

        // Reset the internal bump allocator. Call at the start of each render cycle
        // to reclaim memory from previous renders (malloc/free are no-ops in the
        // freestanding WASM build; the arena is the only way to reclaim memory).
        arenaReset() { _exp.ggtag_arena_reset?.(); },

        UTF8ToString(ptr) {
            if (!ptr) return "";
            const u8 = new Uint8Array(_buf());
            let end = ptr;
            while (u8[end]) end++;
            return new TextDecoder().decode(u8.subarray(ptr, end));
        },

        getValue(ptr, type) {
            if (type === "i32") return new Int32Array(_buf())[ptr >> 2];
            throw new Error("getValue: unsupported type " + type);
        },

        // Call a WASM export by name with JS-typed arguments.
        // Supported argTypes: "number", "string". returnType: "number" | null.
        ccall(name, _retType, argTypes, args) {
            const fn = _exp[name];
            if (!fn) throw new Error("ccall: no WASM export: " + name);
            const strPtrs = [];
            const cArgs = (argTypes || []).map((t, i) => {
                if (t !== "string") return args[i] ?? 0;
                const bytes = new TextEncoder().encode(args[i] ?? "");
                const ptr = _exp.malloc(bytes.length + 1);
                const u8 = new Uint8Array(_buf());
                u8.set(bytes, ptr);
                u8[ptr + bytes.length] = 0;
                strPtrs.push(ptr);
                return ptr;
            });
            const result = fn(...cArgs);
            strPtrs.forEach(p => _exp.free(p));
            return result ?? 0;
        },
    };

    async function _load() {
        const base = _scriptSrc ? new URL(".", _scriptSrc).href : "./js/";
        const url = new URL("ggtag.wasm", base);
        let result;
        try {
            result = await WebAssembly.instantiateStreaming(fetch(url), {});
        } catch {
            // Fallback: fetch as ArrayBuffer (handles file:// and wrong MIME type).
            const buf = await (await fetch(url)).arrayBuffer();
            result = await WebAssembly.instantiate(buf, {});
        }
        _exp = result.instance.exports;
        if (typeof window.editorInit === "function") window.editorInit();
        else if (typeof mod.onRuntimeInitialized === "function") mod.onRuntimeInitialized();
    }

    _load().catch(e => console.error("[ggtag] WASM init failed:", e));

    return mod;
})();
