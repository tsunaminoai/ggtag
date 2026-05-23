"use strict";
// editor.js — DOM layer for the ggtag badge editor.
// Depends on: ggtag_wasm.js (Module global), model.js (GGTagModel global).
// window.editorInit() is called by ggtag_wasm.js once WASM is ready.

// ---------------------------------------------------------------------------
// Globals required by GGTagModel.onChanged
// ---------------------------------------------------------------------------
let _repaintPending = false;

function scheduleRepaint() {
    if (_repaintPending) return;
    _repaintPending = true;
    requestAnimationFrame(() => { _repaintPending = false; renderCycle(); });
}

let _currentName = null;

function autoSave() {
    if (_currentName) GGTagModel.saveDesign(_currentName, GGTagModel.commands);
    _updateTitleBar();
}

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

async function renderCycle() {
    const canvas = document.getElementById("ggCanvas");
    if (!canvas) return;
    const rawInput = GGTagModel.getInput(GGTagModel.commands);
    const processed = await _processImages(rawInput);
    // Reset arena before each render so the bump allocator never exhausts.
    Module.arenaReset();
    _renderBitmap(canvas, processed);
}

function _renderBitmap(canvas, input) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const ptr = Module.ccall("render", "number",
        ["string", "number", "number"],
        [input, canvas.width, canvas.height]);

    const errPtr = Module.ccall("getLastError", "number", [], []);
    const errStr = Module.UTF8ToString(errPtr);
    const errBanner = document.getElementById("errBanner");
    if (errStr !== "OK") {
        errBanner.textContent = errStr;
        errBanner.hidden = false;
    } else {
        errBanner.hidden = true;
    }

    if (!ptr) return;

    const rowBytes = Math.ceil(canvas.width / 8);
    const buf = new Uint8Array(Module.HEAPU8.buffer, ptr, rowBytes * canvas.height);
    const imgData = ctx.createImageData(canvas.width, canvas.height);

    for (let row = 0; row < canvas.height; row++) {
        for (let col = 0; col < canvas.width; col++) {
            const bit = buf[row * rowBytes + (col >> 3)] & (0x80 >> (col & 7));
            const off = (row * canvas.width + col) * 4;
            const v = bit ? 255 : 0;
            imgData.data[off]     = v;
            imgData.data[off + 1] = v;
            imgData.data[off + 2] = v;
            imgData.data[off + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    Module._free(ptr);
}

// ---------------------------------------------------------------------------
// Image processing (converts Image URLs and PNGImages to BMPImage format)
// Ported from original main.js, adapted to use Module directly.
// ---------------------------------------------------------------------------

async function _processImages(input) {
    input = await _processPNGImages(input);
    input = await _processImageURLs(input);
    return input;
}

async function _processPNGImages(input) {
    const regex = /\\P(\d+),(\d+),(\d+),(\d+),(\d),([^\\]*)/g;
    let match;
    while ((match = regex.exec(input)) !== null) {
        const [full, x, y, w0, h0, dither, b64] = match;
        const img = await _loadPNGImage(b64);
        const w = w0 === "0" ? img.width  : parseInt(w0);
        const h = h0 === "0" ? img.height : parseInt(h0);
        const bmp = _imgToBase64Bmp(img, w, h, parseInt(dither));
        if (bmp) input = input.replace(full, `\\i${x},${y},${w},${h},${bmp}`);
    }
    return input;
}

async function _processImageURLs(input) {
    const regex = /\\I(\d+),(\d+),(\d+),(\d+),(\d),([^\\]+)/g;
    let match;
    while ((match = regex.exec(input)) !== null) {
        const [full, x, y, w0, h0, dither, url] = match;
        try {
            const img = await _loadURLImage(url.trim());
            const w = w0 === "0" ? img.width  : parseInt(w0);
            const h = h0 === "0" ? img.height : parseInt(h0);
            const bmp = _imgToBase64Bmp(img, w, h, parseInt(dither));
            if (bmp) input = input.replace(full, `\\i${x},${y},${w},${h},${bmp}`);
        } catch { /* skip unloadable URLs */ }
    }
    return input;
}

function _loadURLImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

function _loadPNGImage(b64) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = "data:image/png;base64," + b64;
    });
}

function _imgToBase64Bmp(img, w, h, dither) {
    const tmp = document.createElement("canvas");
    tmp.width  = w;
    tmp.height = h;
    const tmpCtx = tmp.getContext("2d");
    tmpCtx.drawImage(img, 0, 0, w, h);
    const { data } = tmpCtx.getImageData(0, 0, w, h);

    const rgbaBuf = Module._malloc(data.length);
    if (!rgbaBuf) return null;
    Module.HEAPU8.set(data, rgbaBuf);

    const bmpPtr = Module.ccall("monoimage", "number",
        ["number", "number", "number", "number"],
        [rgbaBuf, w, h, dither]);
    Module._free(rgbaBuf);
    if (!bmpPtr) return null;

    const bmpLen = Math.ceil(w * h / 8);
    const bmp = new Uint8Array(Module.HEAPU8.buffer, bmpPtr, bmpLen);
    let b64 = "";
    for (let i = 0; i < bmp.length; i++) b64 += String.fromCharCode(bmp[i]);
    Module._free(bmpPtr);
    return btoa(b64);
}

// ---------------------------------------------------------------------------
// Encoding (for serial / sound programming)
// ---------------------------------------------------------------------------

async function _encodeInput(input) {
    Module.arenaReset();
    const lenPtr = Module._malloc(4);
    const ptr = Module.ccall("encode", "number", ["string", "number"], [input, lenPtr]);
    if (!ptr) { Module._free(lenPtr); return null; }
    const len = Module.getValue(lenPtr, "i32");
    Module._free(lenPtr);
    const result = new Uint8Array(new Uint8Array(Module.HEAPU8.buffer, ptr, len));
    Module._free(ptr);
    return result;
}

// ---------------------------------------------------------------------------
// Serial programming (from original main.js)
// ---------------------------------------------------------------------------

async function _readSerialOutput(port) {
    const dec  = new TextDecoderStream();
    const closed = port.readable.pipeTo(dec.writable);
    const reader = dec.readable.getReader();
    let ok = false;
    while (true) {
        const timer = setTimeout(() => reader.cancel(), 30000);
        const { value, done } = await reader.read();
        clearTimeout(timer);
        if (done) break;
        if (value.startsWith("Done.")) { ok = true; reader.cancel(); break; }
    }
    reader.releaseLock();
    await closed.catch(() => {});
    return ok;
}

async function programSerial(input) {
    const data = await _encodeInput(input);
    if (!data) throw new Error("encode failed");
    let port;
    if ("serial" in navigator) {
        port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x2e8a, usbProductId: 0x000a }] });
    } else {
        port = await exports.serial.requestPort();
    }
    await port.open({ baudRate: 115200 });
    const done = _readSerialOutput(port);
    const writer = port.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
    await done;
    await port.close();
}

// ---------------------------------------------------------------------------
// Sound programming (from original main.js)
// ---------------------------------------------------------------------------

let _ggwave = null;
let _audioCtx = null;
let _ggwaveInst = null;

ggwave_factory().then(obj => { _ggwave = obj; });

async function programSound(input) {
    const data = await _encodeInput(input);
    if (!data) throw new Error("encode failed");

    if (!_audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error("Web Audio API not supported");
        _audioCtx = new AC({ sampleRate: 48000 });
        const p = _ggwave.getDefaultParameters();
        p.payloadLength  = 16;
        p.sampleRateInp  = _audioCtx.sampleRate;
        p.sampleRateOut  = _audioCtx.sampleRate;
        p.operatingMode  = _ggwave.GGWAVE_OPERATING_MODE_TX | _ggwave.GGWAVE_OPERATING_MODE_USE_DSS;
        _ggwaveInst = _ggwave.init(p);
    }

    await new Promise(resolve => {
        let offset = 0;
        function tx() {
            if (offset >= data.length) { resolve(); return; }
            const wave = _ggwave.encode(_ggwaveInst, data.slice(offset, offset + 16),
                _ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 10);
            const f32  = new Float32Array(wave.buffer, wave.byteOffset, wave.length / 4);
            const buf  = _audioCtx.createBuffer(1, f32.length, _audioCtx.sampleRate);
            buf.getChannelData(0).set(f32);
            const src  = _audioCtx.createBufferSource();
            src.buffer = buf;
            src.connect(_audioCtx.destination);
            src.addEventListener("ended", tx);
            src.start(0);
            offset += 16;
        }
        tx();
    });
}

// ---------------------------------------------------------------------------
// UI: build one command row from a structured command object
// ---------------------------------------------------------------------------

const ALL_TYPES = ["Text", "Rect", "FillRect", "Circle", "FillCircle", "Line",
                   "QR code", "Image", "PNGImage", "Icon", "RFID"];

let _selectedId = null;
let _savedBeforeEdit = null; // snapshot taken on focusin, committed on change (for undo)

function _buildRow(cmd) {
    const row = document.createElement("div");
    row.className = "cmdRow" + (cmd.id === _selectedId ? " selected" : "");
    row.dataset.id = cmd.id;

    // Clicking the row body (not controls) toggles selection
    row.addEventListener("click", e => {
        if (e.target !== row) return;
        _selectedId = (_selectedId === cmd.id) ? null : cmd.id;
        _applySelectionClass();
    });

    // Command type selector
    const typeSelect = document.createElement("select");
    typeSelect.className = "cmdType";
    ALL_TYPES.forEach(t => {
        const o = document.createElement("option");
        o.value = t; o.textContent = t; o.selected = t === cmd.type;
        typeSelect.appendChild(o);
    });
    typeSelect.addEventListener("change", () => _changeType(cmd.id, typeSelect.value));
    row.appendChild(typeSelect);

    // Field inputs from schema
    const schema = GGTagModel.CMD_SCHEMA[cmd.type] || [];
    schema.forEach(f => {
        if (f.type === "hidden") {
            // Show a brief label instead of an editable field
            if (cmd.params[f.key]) {
                const lbl = document.createElement("span");
                lbl.className = "pngLabel";
                lbl.textContent = f.label + " (embedded)";
                row.appendChild(lbl);
            }
            return;
        }

        const wrap = document.createElement("span");
        wrap.className = "field";

        const lbl = document.createElement("label");
        lbl.textContent = f.label;
        wrap.appendChild(lbl);

        let inp;
        if (f.type === "int") {
            inp = document.createElement("input");
            inp.type = "number";
            inp.min  = f.min ?? 0;
            inp.max  = f.max ?? 9999;
            inp.value = cmd.params[f.key] ?? 0;
        } else if (f.type === "select") {
            inp = document.createElement("select");
            (f.options || []).forEach(opt => {
                const o = document.createElement("option");
                o.value = opt; o.textContent = opt;
                o.selected = String(cmd.params[f.key]) === opt;
                inp.appendChild(o);
            });
        } else {
            inp = document.createElement("input");
            inp.type = "text";
            inp.value = cmd.params[f.key] ?? "";
        }

        inp.dataset.key = f.key;
        // Click on input selects the row
        inp.addEventListener("click", () => {
            _selectedId = cmd.id;
            _applySelectionClass();
        });
        wrap.appendChild(inp);
        row.appendChild(wrap);
    });

    // Delete button
    const del = document.createElement("button");
    del.className = "btnDel";
    del.textContent = "×"; // ×
    del.title = "Delete";
    del.addEventListener("click", e => {
        e.stopPropagation();
        if (_selectedId === cmd.id) _selectedId = null;
        GGTagModel.applyChange(GGTagModel.commands.filter(c => c.id !== cmd.id));
        rebuildUI();
    });
    row.appendChild(del);

    return row;
}

function _applySelectionClass() {
    document.querySelectorAll(".cmdRow").forEach(r => {
        r.classList.toggle("selected", r.dataset.id === _selectedId);
    });
}

function _changeType(id, newType) {
    const old = GGTagModel.commands.find(c => c.id === id);
    if (!old) return;
    const newParams = { ...GGTagModel.CMD_DEFAULTS[newType] };
    // Preserve x,y when both types have them
    const schema = GGTagModel.CMD_SCHEMA[newType];
    if (schema?.find(f => f.key === "x") && old.params.x !== undefined) newParams.x = old.params.x;
    if (schema?.find(f => f.key === "y") && old.params.y !== undefined) newParams.y = old.params.y;
    GGTagModel.applyChange(GGTagModel.commands.map(c =>
        c.id === id ? { id, type: newType, params: newParams } : c));
    rebuildUI();
}

function rebuildUI() {
    const ctr = document.getElementById("cmdContainer");
    if (!ctr) return;
    const top = ctr.scrollTop;
    ctr.innerHTML = "";
    GGTagModel.commands.forEach(cmd => ctr.appendChild(_buildRow(cmd)));
    ctr.scrollTop = top;
}

// ---------------------------------------------------------------------------
// Canvas interaction: click to position, drag to move selected command
// ---------------------------------------------------------------------------

let _dragging = false;
let _dragStart = null;      // { x, y } canvas coords at mousedown
let _dragStartParams = null; // { x, y } of selected cmd at mousedown

function _canvasCoords(canvas, ev) {
    const rect = canvas.getBoundingClientRect();
    const src  = ev.touches ? ev.touches[0] : ev;
    return {
        x: Math.max(0, Math.min(canvas.width  - 1, Math.round((src.clientX - rect.left) * canvas.width  / rect.width))),
        y: Math.max(0, Math.min(canvas.height - 1, Math.round((src.clientY - rect.top)  * canvas.height / rect.height))),
    };
}

function _selectedHasXY() {
    if (!_selectedId) return false;
    const cmd = GGTagModel.commands.find(c => c.id === _selectedId);
    if (!cmd) return false;
    const s = GGTagModel.CMD_SCHEMA[cmd.type] || [];
    return s.some(f => f.key === "x") && s.some(f => f.key === "y");
}

function _setupCanvas() {
    const canvas = document.getElementById("ggCanvas");

    canvas.addEventListener("mousedown",  _onDown);
    canvas.addEventListener("touchstart", _onDown, { passive: false });
    canvas.addEventListener("mousemove",  _onMove);
    canvas.addEventListener("touchmove",  _onMove, { passive: false });
    canvas.addEventListener("mouseup",    _onUp);
    canvas.addEventListener("touchend",   _onUp);
    document.addEventListener("mouseup",  _onUp);

    // Prevent page scroll on touch
    document.body.addEventListener("touchmove", e => {
        if (e.target === canvas) e.preventDefault();
    }, { passive: false });
}

function _onDown(ev) {
    ev.preventDefault();
    if (!_selectedHasXY()) return;
    const canvas = document.getElementById("ggCanvas");
    _dragStart = _canvasCoords(canvas, ev);
    const cmd = GGTagModel.commands.find(c => c.id === _selectedId);
    _dragStartParams = { x: cmd.params.x, y: cmd.params.y };
    _dragging = true;
}

function _onMove(ev) {
    if (!_dragging) return;
    ev.preventDefault();
    const canvas = document.getElementById("ggCanvas");
    const pos = _canvasCoords(canvas, ev);
    const cmds = GGTagModel.commands;
    const idx  = cmds.findIndex(c => c.id === _selectedId);
    if (idx < 0) { _dragging = false; return; }
    const updated = cmds.map((c, i) => i === idx
        ? { ...c, params: { ...c.params, x: pos.x, y: pos.y } }
        : c);
    GGTagModel.applyChange(updated, { skipUndo: true });
    // Update inputs directly rather than full DOM rebuild during drag
    const row = document.querySelector(`.cmdRow[data-id="${_selectedId}"]`);
    if (row) {
        const xInp = row.querySelector("[data-key=x]");
        const yInp = row.querySelector("[data-key=y]");
        if (xInp) xInp.value = pos.x;
        if (yInp) yInp.value = pos.y;
    }
}

function _onUp() {
    if (!_dragging) return;
    _dragging = false;
    // Commit the pre-drag state as an undo entry so Ctrl+Z reverts the drag.
    if (_dragStartParams && _selectedId) {
        const snapshot = GGTagModel.commands.map(c =>
            c.id === _selectedId
                ? { ...c, params: { ...c.params, ..._dragStartParams } }
                : { ...c, params: { ...c.params } });
        GGTagModel.pushUndo(snapshot);
    }
    _dragStartParams = null;
    _dragStart = null;
}

// ---------------------------------------------------------------------------
// Design manager
// ---------------------------------------------------------------------------

function _openDesignManager() {
    _renderDesignList();
    document.getElementById("dlgDesigns").showModal();
}

function _renderDesignList() {
    const list = document.getElementById("designList");
    list.innerHTML = "";
    GGTagModel.listDesigns().forEach(name => {
        const item = document.createElement("div");
        item.className = "designItem";

        const span = document.createElement("span");
        span.textContent = name;
        item.appendChild(span);

        const loadBtn = document.createElement("button");
        loadBtn.textContent = "Load";
        loadBtn.addEventListener("click", () => {
            const cmds = GGTagModel.loadDesign(name);
            if (cmds) {
                GGTagModel.applyChange(cmds, { skipUndo: true });
                _currentName = name;
                GGTagModel.setActiveName(name);
                _updateTitleBar();
                rebuildUI();
                document.getElementById("dlgDesigns").close();
            }
        });
        item.appendChild(loadBtn);

        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => {
            if (!confirm(`Delete "${name}"?`)) return;
            GGTagModel.deleteDesign(name);
            if (_currentName === name) { _currentName = null; _updateTitleBar(); }
            _renderDesignList();
        });
        item.appendChild(delBtn);

        list.appendChild(item);
    });
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

function _exportJSON() {
    const json = JSON.stringify({ version: 1, commands: GGTagModel.commands }, null, 2);
    const url  = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a    = document.createElement("a");
    a.href = url;
    a.download = (_currentName || "ggtag") + ".json";
    a.click();
    URL.revokeObjectURL(url);
}

function _importJSON(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { alert("Invalid JSON: " + e.message); return; }
    const cmds = Array.isArray(data) ? data : data?.commands;
    if (!Array.isArray(cmds)) { alert("No commands array found in file."); return; }
    for (const c of cmds) {
        if (!c.type || !GGTagModel.CMD_SCHEMA[c.type]) { alert("Unknown command type: " + c.type); return; }
        if (!c.params || typeof c.params !== "object")  { alert("Bad params in command."); return; }
        if (!c.id) c.id = GGTagModel.makeId();
    }
    GGTagModel.applyChange(cmds);
    rebuildUI();
}

async function _shareLink() {
    const url = location.origin + location.pathname + "?i=" +
        encodeURIComponent(GGTagModel.getInput(GGTagModel.commands));
    if (navigator.share) {
        try { await navigator.share({ title: "ggtag", url }); } catch {}
    } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        alert("Share link copied to clipboard.");
    }
}

// ---------------------------------------------------------------------------
// Drag-and-drop PNG files onto the page
// ---------------------------------------------------------------------------

function _handleDrop(ev) {
    ev.preventDefault();
    const files = ev.dataTransfer?.files ?? [];
    for (const file of files) {
        if (file.type !== "image/png") continue;
        const reader = new FileReader();
        reader.onload = async e => {
            const bytes = new Uint8Array(e.target.result);
            let b64 = "";
            for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
            const b64str = btoa(b64);
            const img = await _loadPNGImage(b64str);
            const canvas = document.getElementById("ggCanvas");
            const w = Math.min(img.width,  canvas.width);
            const h = Math.min(img.height, canvas.height);
            const newCmd = {
                id: GGTagModel.makeId(),
                type: "PNGImage",
                params: { x: 0, y: 0, width: w, height: h, dither: "1", data: b64str },
            };
            GGTagModel.applyChange([...GGTagModel.commands, newCmd]);
            rebuildUI();
        };
        reader.readAsArrayBuffer(file);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _updateTitleBar() {
    const el = document.getElementById("designName");
    if (el) el.textContent = _currentName || "Untitled";
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function _wire() {
    // Add command button
    document.getElementById("btnAddCmd").addEventListener("click", () => {
        const type = document.getElementById("addCmdType").value;
        const cmd  = { id: GGTagModel.makeId(), type, params: { ...GGTagModel.CMD_DEFAULTS[type] } };
        GGTagModel.applyChange([...GGTagModel.commands, cmd]);
        rebuildUI();
        const ctr = document.getElementById("cmdContainer");
        ctr.scrollTop = ctr.scrollHeight;
    });

    // Delegated events on cmdContainer
    const ctr = document.getElementById("cmdContainer");

    // Snapshot before field edit so a single undo entry covers the whole edit
    ctr.addEventListener("focusin", e => {
        if (e.target.matches("[data-key]")) {
            _savedBeforeEdit = GGTagModel.commands.map(c => ({ ...c, params: { ...c.params } }));
        }
    });

    // Live update model during typing (no undo entry)
    ctr.addEventListener("input", e => {
        const inp = e.target;
        if (!inp.matches("[data-key]")) return;
        const row = inp.closest(".cmdRow");
        if (!row) return;
        const id  = row.dataset.id;
        const key = inp.dataset.key;
        const val = inp.type === "number" ? (parseInt(inp.value) || 0) : inp.value;
        const idx = GGTagModel.commands.findIndex(c => c.id === id);
        if (idx < 0) return;
        // Mutate in place and schedule repaint (no undo push yet)
        GGTagModel.commands[idx] = {
            ...GGTagModel.commands[idx],
            params: { ...GGTagModel.commands[idx].params, [key]: val },
        };
        scheduleRepaint();
    });

    // On blur/Enter: commit the undo snapshot
    ctr.addEventListener("change", e => {
        if (!e.target.matches("[data-key]")) return;
        if (_savedBeforeEdit) {
            GGTagModel.undoStack.push(_savedBeforeEdit);
            if (GGTagModel.undoStack.length > 50) GGTagModel.undoStack.shift();
            GGTagModel.redoStack.length = 0;
            _savedBeforeEdit = null;
            autoSave();
        }
    });

    // Undo/redo buttons
    document.getElementById("btnUndo")?.addEventListener("click", () => { GGTagModel.undo(); rebuildUI(); });
    document.getElementById("btnRedo")?.addEventListener("click", () => { GGTagModel.redo(); rebuildUI(); });

    // Keyboard shortcuts
    document.addEventListener("keydown", e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === "z") { e.preventDefault(); e.shiftKey ? GGTagModel.redo() : GGTagModel.undo(); rebuildUI(); }
        if (e.key === "y") { e.preventDefault(); GGTagModel.redo(); rebuildUI(); }
    });

    // Design manager
    document.getElementById("btnDesigns").addEventListener("click", _openDesignManager);
    document.getElementById("dlgClose").addEventListener("click",  () => document.getElementById("dlgDesigns").close());
    document.getElementById("btnSaveAs").addEventListener("click", () => {
        const name = document.getElementById("saveAsName").value.trim();
        if (!name) return;
        GGTagModel.saveDesign(name, GGTagModel.commands);
        _currentName = name;
        GGTagModel.setActiveName(name);
        _updateTitleBar();
        _renderDesignList();
    });

    // Export / Import
    document.getElementById("btnExport").addEventListener("click", _exportJSON);

    const fileInput = document.getElementById("importFile");
    document.getElementById("btnImport").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        const f = fileInput.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = e => _importJSON(e.target.result);
        r.readAsText(f);
        fileInput.value = "";
    });

    document.getElementById("btnShare").addEventListener("click", _shareLink);

    // Program button
    document.getElementById("btnProgram").addEventListener("click", async () => {
        const iface = document.querySelector("input[name=iface]:checked")?.value;
        const btn   = document.getElementById("btnProgram");
        try {
            btn.disabled = true;
            const inp = await _processImages(GGTagModel.getInput(GGTagModel.commands));
            if (iface === "serial") await programSerial(inp);
            else                    await programSound(inp);
        } catch (e) { alert(String(e)); }
        btn.disabled = false;
    });

    // Drag-and-drop
    document.addEventListener("drop",     _handleDrop);
    document.addEventListener("dragover", e => e.preventDefault());
}

// ---------------------------------------------------------------------------
// Init — called by ggtag_wasm.js once WASM is ready
// ---------------------------------------------------------------------------
window.editorInit = function () {
    // Wire model.js callbacks
    GGTagModel.onChanged = () => { autoSave(); scheduleRepaint(); };

    // Populate the "Add command" type selector
    const sel = document.getElementById("addCmdType");
    ALL_TYPES.forEach(t => {
        const o = document.createElement("option");
        o.value = t; o.textContent = t;
        sel.appendChild(o);
    });

    // Handle legacy ?i= share link
    const params = new URLSearchParams(location.search);
    const iParam = params.get("i");
    if (iParam) {
        const parsed = GGTagModel.parseCommands(GGTagModel.splitCommands(iParam));
        if (parsed.length) {
            const name = prompt("Save this shared design as (leave blank to skip):", "Shared design");
            if (name && name.trim()) {
                GGTagModel.saveDesign(name.trim(), parsed);
                _currentName = name.trim();
                GGTagModel.setActiveName(_currentName);
            }
            GGTagModel.applyChange(parsed, { skipUndo: true });
        }
        history.replaceState(null, "", location.pathname);
    } else {
        // Restore last active design
        const last = GGTagModel.getActiveName();
        if (last) {
            const cmds = GGTagModel.loadDesign(last);
            if (cmds) {
                GGTagModel.applyChange(cmds, { skipUndo: true });
                _currentName = last;
            }
        }
    }

    // If no commands, start with a sample Text command
    if (!GGTagModel.commands.length) {
        GGTagModel.applyChange([{
            id: GGTagModel.makeId(),
            type: "Text",
            params: { ...GGTagModel.CMD_DEFAULTS.Text },
        }], { skipUndo: true });
    }

    if (params.get("d")) Module.ccall("debugEnable", null, ["number"], [1]);

    _updateTitleBar();
    _setupCanvas();
    _wire();
    rebuildUI();
    scheduleRepaint();
};
