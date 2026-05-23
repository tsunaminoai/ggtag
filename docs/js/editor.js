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
    // Skip the microtask yield when there are no image commands — avoids
    // rendering stale coordinates after rapid drag moves.
    const hasImages = rawInput.includes("\\P") || rawInput.includes("\\I");
    const processed = hasImages ? await _processImages(rawInput) : rawInput;
    Module.arenaReset();
    _renderBitmap(canvas, processed);
    _repaintHandles();
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
// UI: layer list + properties panel (canvas-first design)
// ---------------------------------------------------------------------------

// Types available via right-click (PNGImage/BMPImage are created via drag-and-drop)
const ALL_TYPES = ["Text", "Rect", "FillRect", "Circle", "FillCircle", "Line",
                   "QR code", "Image", "Icon", "RFID"];

let _selectedId = null;
let _savedBeforeEdit = null;

// Keys that are manipulated via canvas handles — excluded from properties panel
const _HANDLE_KEYS = new Set(["x","y","width","height","radius","x1","y1","x2","y2","_x","_y"]);

// Type → hue for colored layer badges (HSL)
const _TYPE_HUE = {
    Text: 220, Rect: 140, FillRect: 140, Circle: 270, FillCircle: 270,
    Line: 30, "QR code": 180, Image: 0, PNGImage: 0, BMPImage: 0, Icon: 200, RFID: 0,
};

function _cmdLabel(cmd) {
    const p = cmd.params;
    switch (cmd.type) {
        case "Text":    return String(p.text || "").substring(0, 24);
        case "QR code": return String(p.text || "").substring(0, 24);
        case "Image":   return String(p.url  || "").replace(/^https?:\/\//, "").substring(0, 20);
        case "Icon":    return p.name || "";
        case "RFID":    return `${p.mode} ${p.id}`;
        default:        return cmd.type;
    }
}

function _buildLayerList() {
    const list = document.getElementById("layerList");
    if (!list) return;
    const top = list.scrollTop;
    list.innerHTML = "";
    GGTagModel.commands.forEach(cmd => {
        const item = document.createElement("div");
        item.className = "layerItem" + (cmd.id === _selectedId ? " selected" : "");
        item.dataset.id = cmd.id;

        const badge = document.createElement("span");
        badge.className = "layerBadge";
        badge.textContent = cmd.type;
        const hue = _TYPE_HUE[cmd.type] ?? 200;
        badge.style.cssText = `background:hsl(${hue},60%,88%);color:hsl(${hue},60%,28%);border-color:hsl(${hue},60%,70%)`;
        item.appendChild(badge);

        const lbl = document.createElement("span");
        lbl.className = "layerLabel";
        lbl.textContent = _cmdLabel(cmd);
        item.appendChild(lbl);

        const del = document.createElement("button");
        del.className = "btnDel";
        del.textContent = "×";
        del.title = "Delete";
        del.addEventListener("click", e => {
            e.stopPropagation();
            const wasSel = _selectedId === cmd.id;
            GGTagModel.applyChange(GGTagModel.commands.filter(c => c.id !== cmd.id));
            if (wasSel) _setSelected(null);
            rebuildUI();
        });
        item.appendChild(del);

        item.addEventListener("click", () => _setSelected(cmd.id));
        list.appendChild(item);
    });
    list.scrollTop = top;
}

function _buildPropsPanel(cmd) {
    const pp = document.getElementById("propsPanel");
    if (!pp) return;
    pp.innerHTML = "";

    if (!cmd) {
        const hint = document.createElement("p");
        hint.className = "propsHint";
        hint.textContent = "Right-click the canvas to add an element, or click an element to select it.";
        pp.appendChild(hint);
        return;
    }

    const schema = (GGTagModel.CMD_SCHEMA[cmd.type] || []).filter(f => !_HANDLE_KEYS.has(f.key) && f.type !== "hidden");

    if (schema.length === 0 && cmd.type !== "PNGImage" && cmd.type !== "BMPImage") {
        const hint = document.createElement("p");
        hint.className = "propsHint";
        hint.textContent = "Drag handles on the canvas to edit.";
        pp.appendChild(hint);
    }

    // Show hidden data labels (PNG / BMP)
    (GGTagModel.CMD_SCHEMA[cmd.type] || []).filter(f => f.type === "hidden").forEach(f => {
        if (cmd.params[f.key]) {
            const lbl = document.createElement("span");
            lbl.className = "pngLabel";
            lbl.textContent = f.label + " (embedded)";
            pp.appendChild(lbl);
        }
    });

    schema.forEach(f => {
        const wrap = document.createElement("div");
        wrap.className = "propField";

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
        inp.dataset.key  = f.key;
        inp.dataset.cmdId = cmd.id;
        wrap.appendChild(inp);
        pp.appendChild(wrap);
    });
}

function _applySelectionClass() {
    document.querySelectorAll(".layerItem").forEach(r => {
        r.classList.toggle("selected", r.dataset.id === _selectedId);
    });
    _repaintHandles();
}

function rebuildUI() {
    _buildLayerList();
    const cmd = _selectedId ? GGTagModel.commands.find(c => c.id === _selectedId) : null;
    _buildPropsPanel(cmd);
}

// ---------------------------------------------------------------------------
// Canvas interaction: per-type handles, drag, resize
// ---------------------------------------------------------------------------

let _dragging      = false;
let _dragStart     = null;  // { x, y } canvas coords at mousedown
let _dragStartParams = null; // full snapshot of cmd.params at mousedown
let _activeHandle  = null;  // { id, x, y } from GGTagModel.getHandles()

const _HANDLE_R     = 5;                    // visual radius (canvas pixels)
const _HIT_R        = 8;                    // hit-test radius (canvas pixels)
const _HANDLE_COLOR = "#4285f4";
const _OUTLINE_CLR  = "rgba(66,133,244,0.7)";

function _canvasCoords(overlay, ev) {
    const rect = overlay.getBoundingClientRect();
    const src  = ev.touches ? ev.touches[0] : ev;
    return {
        x: Math.max(0, Math.min(overlay.width  - 1, Math.round((src.clientX - rect.left) * overlay.width  / rect.width))),
        y: Math.max(0, Math.min(overlay.height - 1, Math.round((src.clientY - rect.top)  * overlay.height / rect.height))),
    };
}

function _hitHandle(cx, cy, cmd) {
    for (const h of GGTagModel.getHandles(cmd)) {
        const dx = cx - h.x, dy = cy - h.y;
        if (dx * dx + dy * dy <= _HIT_R * _HIT_R) return h;
    }
    return null;
}

function _cursorForHandle(h) {
    if (!h) return "crosshair";
    switch (h.id) {
        case "origin": case "center": case "move": case "p1": case "p2": return "grab";
        case "tl": case "br": return "nw-resize";
        case "tr": case "bl": return "ne-resize";
        case "edge": case "size": return "ew-resize";
        default: return "crosshair";
    }
}

const _FONT_H = [8, 12, 16, 20, 24, 28, 32, 36]; // fontSize 1-8 → pixel height

function _drawHandles(cmd) {
    const ov = document.getElementById("ggOverlay");
    if (!ov) return;
    const ctx = ov.getContext("2d");
    ctx.clearRect(0, 0, ov.width, ov.height);

    // Draw unselected commands as faint outlines so they're visible on canvas
    for (const c of GGTagModel.commands) {
        if (c === cmd) continue;
        const bb = GGTagModel.getBBox(c);
        if (!bb) continue;
        if (c.type === "RFID") {
            _drawRFIDTag(ctx, c, false);
        } else {
            ctx.strokeStyle = "rgba(100,100,100,0.25)";
            ctx.lineWidth   = 1;
            ctx.setLineDash([2, 4]);
            ctx.strokeRect(bb.x, bb.y, bb.w, bb.h);
            ctx.setLineDash([]);
        }
    }

    if (!cmd) return;

    const p = cmd.params;
    ctx.strokeStyle = _OUTLINE_CLR;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);

    if (cmd.type === "RFID") {
        ctx.setLineDash([]);
        _drawRFIDTag(ctx, cmd, true);
    } else if (["Rect", "FillRect", "Image", "PNGImage", "BMPImage"].includes(cmd.type)) {
        ctx.strokeRect(p.x, p.y, p.width || 0, p.height || 0);
    } else if (["Circle", "FillCircle"].includes(cmd.type) && p.radius > 0) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.stroke();
    } else if (cmd.type === "Line") {
        ctx.beginPath();
        ctx.moveTo(p.x1, p.y1);
        ctx.lineTo(p.x2, p.y2);
        ctx.stroke();
    } else if (cmd.type === "Text") {
        const fh = _FONT_H[(p.fontSize || 3) - 1] || 16;
        const fw = Math.round(fh * 0.6);
        const w  = (String(p.text || "").length || 1) * fw;
        ctx.strokeRect(p.x, p.y, w, fh);
    } else if (cmd.type === "Icon") {
        const h = p.height || 32;
        ctx.strokeRect(p.x, p.y, h, h);
    } else if (cmd.type === "QR code") {
        const sz = (p.pointWidth || 2) * 7 * 8;
        ctx.strokeRect(p.x, p.y, sz, sz);
    }
    ctx.setLineDash([]);

    for (const h of GGTagModel.getHandles(cmd)) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, _HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle   = _HANDLE_COLOR;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth   = 1.5;
        ctx.stroke();
    }
}

function _drawRFIDTag(ctx, cmd, selected) {
    const p  = cmd.params;
    const tx = p._x ?? 10;
    const ty = p._y ?? 210;
    const tw = 120, th = 22, r = 4;
    ctx.beginPath();
    ctx.roundRect?.(tx, ty, tw, th, r) || ctx.rect(tx, ty, tw, th);
    ctx.fillStyle   = selected ? "#e8e8e8" : "#d0d0d0";
    ctx.fill();
    ctx.strokeStyle = selected ? "#555" : "#aaa";
    ctx.lineWidth   = selected ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle  = "#333";
    ctx.font       = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(`RFID ${p.mode ?? ""} ${p.id ?? ""}`.trim(), tx + 6, ty + th / 2);
}

function _repaintHandles() {
    const cmd = _selectedId ? GGTagModel.commands.find(c => c.id === _selectedId) : null;
    _drawHandles(cmd || null);
}

function _hitTestAll(cx, cy) {
    const cmds = GGTagModel.commands;
    for (let i = cmds.length - 1; i >= 0; i--) {
        const bb = GGTagModel.getBBox(cmds[i]);
        if (!bb) continue;
        if (cx >= bb.x && cx <= bb.x + bb.w && cy >= bb.y && cy <= bb.y + bb.h) return cmds[i];
    }
    return null;
}

function _setSelected(id) {
    _selectedId = id;
    _applySelectionClass();
    _buildPropsPanel(id ? GGTagModel.commands.find(c => c.id === id) : null);
    if (id) {
        // Auto-focus the first text input in the props panel for keyboard editing
        const pp = document.getElementById("propsPanel");
        const textInp = pp?.querySelector("input[type=text]");
        if (textInp) setTimeout(() => textInp.focus(), 0);
    }
}

function _setupCanvas() {
    const ov = document.getElementById("ggOverlay");

    ov.addEventListener("mousedown",  _onDown);
    ov.addEventListener("touchstart", _onDown, { passive: false });
    ov.addEventListener("mousemove",  ev => { _onHover(ev); _onMove(ev); });
    ov.addEventListener("touchmove",  _onMove, { passive: false });
    ov.addEventListener("mouseup",    _onUp);
    ov.addEventListener("touchend",   _onUp);
    document.addEventListener("mouseup", _onUp);

    document.body.addEventListener("touchmove", e => {
        if (e.target === ov) e.preventDefault();
    }, { passive: false });
}

function _onHover(ev) {
    if (_dragging) return;
    const ov  = document.getElementById("ggOverlay");
    const pos = _canvasCoords(ov, ev);
    const cmd = _selectedId ? GGTagModel.commands.find(c => c.id === _selectedId) : null;
    const h   = cmd ? _hitHandle(pos.x, pos.y, cmd) : null;
    // Also show grab cursor when hovering over any unselected command
    const hovered = !h && _hitTestAll(pos.x, pos.y);
    ov.style.cursor = h ? _cursorForHandle(h) : (hovered ? "pointer" : "crosshair");
}

function _onDown(ev) {
    ev.preventDefault();
    const ov  = document.getElementById("ggOverlay");
    const pos = _canvasCoords(ov, ev);
    const selectedCmd = _selectedId ? GGTagModel.commands.find(c => c.id === _selectedId) : null;

    // 1. Try to drag a handle on the currently selected command
    if (selectedCmd) {
        const h = _hitHandle(pos.x, pos.y, selectedCmd);
        if (h) {
            _dragStart       = pos;
            _dragStartParams = { ...selectedCmd.params };
            _activeHandle    = h;
            _dragging        = true;
            ov.style.cursor  = "grabbing";
            return;
        }
    }

    // 2. Try to select whichever command is under the click
    const hit = _hitTestAll(pos.x, pos.y);
    if (hit) {
        _setSelected(hit.id);
        // Immediately start dragging the origin/move handle if it exists
        const h = _hitHandle(pos.x, pos.y, hit) || GGTagModel.getHandles(hit).find(x => x.id === "origin" || x.id === "center" || x.id === "move");
        if (h) {
            _dragStart       = pos;
            _dragStartParams = { ...hit.params };
            _activeHandle    = h;
            _dragging        = true;
            ov.style.cursor  = "grabbing";
        }
        return;
    }

    // 3. Click on empty canvas → deselect
    _setSelected(null);
}

function _onMove(ev) {
    if (!_dragging) return;
    ev.preventDefault();
    const ov   = document.getElementById("ggOverlay");
    const pos  = _canvasCoords(ov, ev);
    const cmds = GGTagModel.commands;
    const idx  = cmds.findIndex(c => c.id === _selectedId);
    if (idx < 0) { _dragging = false; return; }

    const dx = pos.x - _dragStart.x;
    const dy = pos.y - _dragStart.y;
    const sp = _dragStartParams;
    const p  = { ...sp };

    const clampX = v => Math.max(0, Math.min(511, Math.round(v)));
    const clampY = v => Math.max(0, Math.min(255, Math.round(v)));

    switch (_activeHandle.id) {
        case "origin": case "center": case "move":
            if (cmds[idx].type === "RFID") {
                p._x = clampX((sp._x ?? 10) + dx);  p._y = clampY((sp._y ?? 210) + dy);
            } else {
                p.x = clampX(sp.x + dx);  p.y = clampY(sp.y + dy);
            }
            break;
        case "p1":
            p.x1 = clampX(sp.x1 + dx);  p.y1 = clampY(sp.y1 + dy);
            break;
        case "p2":
            p.x2 = clampX(sp.x2 + dx);  p.y2 = clampY(sp.y2 + dy);
            break;
        case "tl":
            p.x      = clampX(Math.min(sp.x + (sp.width  || 0) - 1, sp.x + dx));
            p.y      = clampY(Math.min(sp.y + (sp.height || 0) - 1, sp.y + dy));
            p.width  = Math.max(1, (sp.width  || 0) - dx);
            p.height = Math.max(1, (sp.height || 0) - dy);
            break;
        case "tr":
            p.y      = clampY(Math.min(sp.y + (sp.height || 0) - 1, sp.y + dy));
            p.width  = Math.max(1, (sp.width  || 0) + dx);
            p.height = Math.max(1, (sp.height || 0) - dy);
            break;
        case "bl":
            p.x      = clampX(Math.min(sp.x + (sp.width  || 0) - 1, sp.x + dx));
            p.width  = Math.max(1, (sp.width  || 0) - dx);
            p.height = Math.max(1, (sp.height || 0) + dy);
            break;
        case "br":
            p.width  = Math.max(1, (sp.width  || 0) + dx);
            p.height = Math.max(1, (sp.height || 0) + dy);
            break;
        case "edge":
            p.radius = Math.max(1, Math.round((sp.radius || 0) + dx));
            break;
        case "size":
            p.height = Math.max(8, Math.round((sp.height || 0) + Math.max(dx, dy)));
            break;
    }

    const updated = cmds.map((c, i) => i === idx ? { ...c, params: p } : c);
    GGTagModel.applyChange(updated, { skipUndo: true });
    _repaintHandles(); // synchronous — keeps handles in sync without waiting for WASM render

    // Update props panel inputs directly without full rebuild
    const propsPanel = document.getElementById("propsPanel");
    if (propsPanel) {
        for (const [k, v] of Object.entries(p)) {
            const inp = propsPanel.querySelector(`[data-key="${k}"]`);
            if (inp) inp.value = v;
        }
    }
}

function _onUp() {
    if (!_dragging) return;
    _dragging = false;
    const ov = document.getElementById("ggOverlay");
    if (ov) ov.style.cursor = "";
    // Commit pre-drag snapshot as a single undoable entry
    if (_dragStartParams && _selectedId) {
        const snapshot = GGTagModel.commands.map(c =>
            c.id === _selectedId
                ? { ...c, params: { ..._dragStartParams } }
                : { ...c, params: { ...c.params } });
        GGTagModel.pushUndo(snapshot);
    }
    _activeHandle    = null;
    _dragStartParams = null;
    _dragStart       = null;
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
// Context menu
// ---------------------------------------------------------------------------

let _ctxMenuCanvasPos = null; // {x, y} in canvas coords when right-click fired

function _addCommandAt(type, cx, cy) {
    const defaults = { ...GGTagModel.CMD_DEFAULTS[type] };
    if ("x" in defaults) defaults.x = Math.max(0, cx);
    if ("y" in defaults) defaults.y = Math.max(0, cy);
    if ("x1" in defaults) { defaults.x1 = cx; defaults.y1 = cy; defaults.x2 = Math.min(511, cx + 60); defaults.y2 = Math.min(255, cy + 60); }
    if ("_x" in defaults) { defaults._x = cx; defaults._y = cy; }
    const cmd = { id: GGTagModel.makeId(), type, params: defaults };
    GGTagModel.applyChange([...GGTagModel.commands, cmd]);
    _setSelected(cmd.id);
    rebuildUI();
}

function _showCtxMenu(screenX, screenY, canvasX, canvasY, cmdUnderCursor) {
    _ctxMenuCanvasPos = { x: canvasX, y: canvasY };
    const menu = document.getElementById("ctxMenu");
    if (!menu) return;
    menu.innerHTML = "";

    ALL_TYPES.forEach(type => {
        const item = document.createElement("div");
        item.className = "ctxItem";
        item.textContent = "Add " + type;
        item.addEventListener("click", () => {
            _hideCtxMenu();
            _addCommandAt(type, canvasX, canvasY);
        });
        menu.appendChild(item);
    });

    if (cmdUnderCursor) {
        const sep = document.createElement("div");
        sep.className = "ctxSep";
        menu.appendChild(sep);

        const del = document.createElement("div");
        del.className = "ctxItem ctxDelete";
        del.textContent = "Delete " + cmdUnderCursor.type;
        del.addEventListener("click", () => {
            _hideCtxMenu();
            GGTagModel.applyChange(GGTagModel.commands.filter(c => c.id !== cmdUnderCursor.id));
            if (_selectedId === cmdUnderCursor.id) _setSelected(null);
            rebuildUI();
        });
        menu.appendChild(del);
    }

    // Position menu; keep inside viewport
    menu.style.display = "block";
    const vw = window.innerWidth, vh = window.innerHeight;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = (screenX + mw > vw ? screenX - mw : screenX) + "px";
    menu.style.top  = (screenY + mh > vh ? screenY - mh : screenY) + "px";
}

function _hideCtxMenu() {
    const menu = document.getElementById("ctxMenu");
    if (menu) menu.style.display = "none";
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function _wire() {
    // Props panel: focusin/input/change for live editing with undo
    const pp = document.getElementById("propsPanel");

    document.addEventListener("focusin", e => {
        if (e.target.matches("[data-key]")) {
            _savedBeforeEdit = GGTagModel.commands.map(c => ({ ...c, params: { ...c.params } }));
        }
    });

    document.addEventListener("input", e => {
        const inp = e.target;
        if (!inp.matches("[data-key]")) return;
        const id  = inp.dataset.cmdId || _selectedId;
        const key = inp.dataset.key;
        const val = inp.type === "number" ? (parseInt(inp.value) || 0) : inp.value;
        const idx = GGTagModel.commands.findIndex(c => c.id === id);
        if (idx < 0) return;
        GGTagModel.commands[idx] = {
            ...GGTagModel.commands[idx],
            params: { ...GGTagModel.commands[idx].params, [key]: val },
        };
        // Update layer label live
        const layerItem = document.querySelector(`.layerItem[data-id="${id}"] .layerLabel`);
        if (layerItem) layerItem.textContent = _cmdLabel(GGTagModel.commands[idx]);
        scheduleRepaint();
    });

    document.addEventListener("change", e => {
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
        // Ctrl/Cmd shortcuts
        if (e.ctrlKey || e.metaKey) {
            if (e.key === "z") { e.preventDefault(); e.shiftKey ? GGTagModel.redo() : GGTagModel.undo(); rebuildUI(); }
            if (e.key === "y") { e.preventDefault(); GGTagModel.redo(); rebuildUI(); }
            return;
        }
        // Delete/Backspace removes selected command (unless a text input is focused)
        if ((e.key === "Delete" || e.key === "Backspace") && _selectedId) {
            const active = document.activeElement;
            if (active && (active.tagName === "INPUT" || active.tagName === "SELECT" || active.tagName === "TEXTAREA")) return;
            e.preventDefault();
            GGTagModel.applyChange(GGTagModel.commands.filter(c => c.id !== _selectedId));
            _setSelected(null);
            rebuildUI();
        }
        // Escape: deselect + hide menu
        if (e.key === "Escape") {
            _hideCtxMenu();
            _setSelected(null);
        }
    });

    // Right-click on canvas overlay → context menu
    const ov = document.getElementById("ggOverlay");
    ov?.addEventListener("contextmenu", ev => {
        ev.preventDefault();
        const pos = _canvasCoords(ov, ev);
        const hit = _hitTestAll(pos.x, pos.y);
        _showCtxMenu(ev.clientX, ev.clientY, pos.x, pos.y, hit);
    });

    // Dismiss context menu on outside click
    document.addEventListener("click", e => {
        const menu = document.getElementById("ctxMenu");
        if (menu && !menu.contains(e.target)) _hideCtxMenu();
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
