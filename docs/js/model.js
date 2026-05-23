"use strict";
// model.js — pure-logic layer: schema, serialisation, persistence, undo/redo.
// No DOM dependencies → testable in Node.js (node editor.test.js).

const GGTagModel = (() => {

// ---------------------------------------------------------------------------
// Protocol mappings
// ---------------------------------------------------------------------------
const ESC2CMD = {
    "\\t": "Text",
    "\\r": "Rect",
    "\\R": "FillRect",
    "\\c": "Circle",
    "\\C": "FillCircle",
    "\\l": "Line",
    "\\q": "QR code",
    "\\I": "Image",
    "\\P": "PNGImage",
    "\\i": "BMPImage",
    "\\a": "Icon",
    "\\f": "RFID",
};
const CMD2ESC = {};
for (const [k, v] of Object.entries(ESC2CMD)) CMD2ESC[v] = k;

// ---------------------------------------------------------------------------
// Schema: ordered field descriptors for each command type.
// type: 'int' | 'string' | 'select' | 'hidden'
// ---------------------------------------------------------------------------
const _xy = [
    { key: "x", label: "X", type: "int", min: 0, max: 511 },
    { key: "y", label: "Y", type: "int", min: 0, max: 255 },
];
const CMD_SCHEMA = {
    Text:       [..._xy,
                 { key: "fontSize", label: "Size", type: "int", min: 1, max: 5 },
                 { key: "text",     label: "Text", type: "string" }],
    Rect:       [..._xy,
                 { key: "width",  label: "W", type: "int", min: 1, max: 511 },
                 { key: "height", label: "H", type: "int", min: 1, max: 255 }],
    FillRect:   [..._xy,
                 { key: "width",  label: "W", type: "int", min: 1, max: 511 },
                 { key: "height", label: "H", type: "int", min: 1, max: 255 }],
    Circle:     [..._xy,
                 { key: "radius", label: "R", type: "int", min: 1, max: 255 }],
    FillCircle: [..._xy,
                 { key: "radius", label: "R", type: "int", min: 1, max: 255 }],
    Line:       [{ key: "x1", label: "X1", type: "int", min: 0, max: 511 },
                 { key: "y1", label: "Y1", type: "int", min: 0, max: 255 },
                 { key: "x2", label: "X2", type: "int", min: 0, max: 511 },
                 { key: "y2", label: "Y2", type: "int", min: 0, max: 255 }],
    "QR code":  [..._xy,
                 { key: "pointWidth", label: "PW",   type: "int",    min: 1, max: 10 },
                 { key: "text",       label: "Text",  type: "string" }],
    Image:      [..._xy,
                 { key: "width",  label: "W",      type: "int",    min: 0, max: 511 },
                 { key: "height", label: "H",      type: "int",    min: 0, max: 255 },
                 { key: "dither", label: "Dither", type: "select", options: ["0", "1"] },
                 { key: "url",    label: "URL",    type: "string" }],
    PNGImage:   [..._xy,
                 { key: "width",  label: "W",      type: "int",    min: 0, max: 511 },
                 { key: "height", label: "H",      type: "int",    min: 0, max: 255 },
                 { key: "dither", label: "Dither", type: "select", options: ["0", "1"] },
                 { key: "data",   label: "PNG",    type: "hidden" }],
    BMPImage:   [..._xy,
                 { key: "width",  label: "W",   type: "int",    min: 0, max: 511 },
                 { key: "height", label: "H",   type: "int",    min: 0, max: 255 },
                 { key: "data",   label: "BMP", type: "hidden" }],
    Icon:       [..._xy,
                 { key: "height", label: "H",    type: "int",    min: 8, max: 255 },
                 { key: "name",   label: "Name", type: "string" }],
    RFID:       [{ key: "mode", label: "Mode", type: "select", options: ["em", "hid"] },
                 { key: "id",   label: "ID",   type: "string" },
                 { key: "uid",  label: "UID",  type: "string" }],
};

const CMD_DEFAULTS = {
    Text:       { x: 10,  y: 10,  fontSize: 3, text: "Hello world" },
    Rect:       { x: 10,  y: 10,  width: 50,   height: 30 },
    FillRect:   { x: 10,  y: 10,  width: 50,   height: 30 },
    Circle:     { x: 50,  y: 50,  radius: 30 },
    FillCircle: { x: 50,  y: 50,  radius: 30 },
    Line:       { x1: 0,  y1: 0,  x2: 100,     y2: 100 },
    "QR code":  { x: 10,  y: 10,  pointWidth: 2, text: "https://ggtag.io" },
    Image:      { x: 0,   y: 0,   width: 0, height: 0, dither: "0", url: "https://ggtag.io/mario.png" },
    PNGImage:   { x: 0,   y: 0,   width: 0, height: 0, dither: "1", data: "" },
    BMPImage:   { x: 0,   y: 0,   width: 0, height: 0, data: "" },
    Icon:       { x: 10,  y: 10,  height: 32, name: "bug" },
    RFID:       { mode: "em", id: "12", uid: "3456789A", _x: 10, _y: 210 },
};

// ---------------------------------------------------------------------------
// Handle geometry: canvas-coordinate handles for each command type.
// Returns [{id, x, y}, ...] in badge coordinate space (same units as params).
// ---------------------------------------------------------------------------
function getHandles(cmd) {
    if (!cmd) return [];
    const p = cmd.params;
    switch (cmd.type) {
        case "Text":
            return [{ id: "origin", x: p.x, y: p.y }];
        case "Rect": case "FillRect":
        case "Image": case "PNGImage": case "BMPImage": {
            const w = p.width  || 0;
            const h = p.height || 0;
            return [
                { id: "tl",   x: p.x,                          y: p.y         },
                { id: "tr",   x: p.x + w,                      y: p.y         },
                { id: "bl",   x: p.x,                          y: p.y + h     },
                { id: "br",   x: p.x + w,                      y: p.y + h     },
                { id: "move", x: Math.round(p.x + w / 2),      y: Math.round(p.y + h / 2) },
            ];
        }
        case "Circle": case "FillCircle":
            return [
                { id: "center", x: p.x,                        y: p.y },
                { id: "edge",   x: p.x + (p.radius || 0),      y: p.y },
            ];
        case "Line":
            return [
                { id: "p1", x: p.x1, y: p.y1 },
                { id: "p2", x: p.x2, y: p.y2 },
            ];
        case "QR code":
            return [{ id: "origin", x: p.x, y: p.y }];
        case "Icon":
            return [
                { id: "origin", x: p.x,                        y: p.y },
                { id: "size",   x: p.x + (p.height || 0),      y: p.y + (p.height || 0) },
            ];
        case "RFID":
            return [{ id: "origin", x: p._x ?? 10, y: p._y ?? 210 }];
        default:
            return [];
    }
}

// ---------------------------------------------------------------------------
// Bounding box: returns {x,y,w,h} in canvas pixel coords for hit-testing.
// Uses same approximations as _drawHandles outlines.
// ---------------------------------------------------------------------------
const _FONT_H = [8, 12, 16, 20, 24, 28, 32, 36]; // fontSize 1-8 → px height

function getBBox(cmd) {
    if (!cmd) return null;
    const p = cmd.params;
    switch (cmd.type) {
        case "Text": {
            const fh = _FONT_H[(p.fontSize || 3) - 1] || 16;
            const fw = Math.round(fh * 0.6);
            return { x: p.x, y: p.y, w: (String(p.text || "").length || 1) * fw, h: fh };
        }
        case "Rect": case "FillRect":
        case "Image": case "PNGImage": case "BMPImage":
            return { x: p.x, y: p.y, w: p.width || 1, h: p.height || 1 };
        case "Circle": case "FillCircle": {
            const r = p.radius || 1;
            return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r };
        }
        case "Line": {
            const x0 = Math.min(p.x1, p.x2), y0 = Math.min(p.y1, p.y2);
            const x1 = Math.max(p.x1, p.x2), y1 = Math.max(p.y1, p.y2);
            return { x: x0 - 4, y: y0 - 4, w: (x1 - x0) + 8, h: (y1 - y0) + 8 };
        }
        case "QR code": {
            const sz = (p.pointWidth || 2) * 21;
            return { x: p.x, y: p.y, w: sz, h: sz };
        }
        case "Icon": {
            const h = p.height || 32;
            return { x: p.x, y: p.y, w: h, h };
        }
        case "RFID":
            return { x: (p._x ?? 10), y: (p._y ?? 210), w: 120, h: 22 };
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

// Escape backslashes in string values so they are safe for the protocol.
function _escStr(s) { return String(s).replace(/\\/g, "\\\\"); }
function _unescStr(s) { return s.replace(/\\\\/g, "\\"); }

function cmdToEscStr(cmd) {
    const schema = CMD_SCHEMA[cmd.type];
    if (!schema) return "";
    const parts = schema.map(f => {
        const v = cmd.params[f.key] ?? "";
        return f.type === "string" ? _escStr(v) : String(v);
    });
    return CMD2ESC[cmd.type] + parts.join(",");
}

function getInput(commands) {
    return commands.map(cmdToEscStr).join("");
}

// ---------------------------------------------------------------------------
// Deserialisation
// ---------------------------------------------------------------------------

function splitCommands(input) {
    if (!input) return [];
    const cmds = [];
    let lastIdx = 0;
    for (let i = 1; i < input.length - 1; i++) {
        if (input[i] === "\\") {
            if (input[i + 1] !== "\\") {
                cmds.push(input.substring(lastIdx, i));
                lastIdx = i;
            } else {
                i++; // skip escaped backslash
            }
        }
    }
    cmds.push(input.substring(lastIdx));
    return cmds.filter(s => s.length >= 2 && ESC2CMD[s.substring(0, 2)]);
}

function parseOneCmd(raw) {
    const esc = raw.substring(0, 2);
    const type = ESC2CMD[esc];
    if (!type) return null;
    const schema = CMD_SCHEMA[type];
    // Unescape \\ → \ in the params portion before splitting.
    const paramStr = _unescStr(raw.substring(2));
    const parts = paramStr.split(",");
    const params = {};
    for (let i = 0; i < schema.length; i++) {
        const f = schema[i];
        // Last field gets everything remaining (string fields can contain commas).
        const raw_val = i < schema.length - 1 ? parts[i] : parts.slice(i).join(",");
        params[f.key] = f.type === "int" ? (parseInt(raw_val) || 0) : (raw_val ?? "");
    }
    return { id: makeId(), type, params };
}

function parseCommands(rawCmds) {
    return rawCmds.map(parseOneCmd).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Unique IDs
// ---------------------------------------------------------------------------
let _idSeq = 0;
function makeId() { return `cmd_${Date.now()}_${_idSeq++}`; }

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------
const MAX_UNDO = 50;
let commands  = [];
let undoStack = [];
let redoStack = [];

function _cloneCommands(cmds) {
    return cmds.map(c => ({ ...c, params: { ...c.params } }));
}

// All mutations route through applyChange.
// opts.skipUndo: don't create an undo entry (used during live drag).
function applyChange(newCommands, opts = {}) {
    if (!opts.skipUndo) {
        undoStack.push(_cloneCommands(commands));
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
    }
    commands = newCommands;
    m.onChanged?.();
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push(_cloneCommands(commands));
    commands = undoStack.pop();
    m.onChanged?.();
}

function redo() {
    if (!redoStack.length) return;
    undoStack.push(_cloneCommands(commands));
    commands = redoStack.pop();
    m.onChanged?.();
}

// Push a snapshot directly onto the undo stack (used by drag commit).
function pushUndo(snapshot) {
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    m.onChanged?.();
}

// Reset all mutable state (used by tests).
function resetState() {
    commands  = [];
    undoStack = [];
    redoStack = [];
}

// ---------------------------------------------------------------------------
// Persistence (localStorage)
// ---------------------------------------------------------------------------
const LS_INDEX  = "ggtag_designs";
const LS_ACTIVE = "ggtag_active";
const LS_PREFIX = "ggtag_design:";

function _ls() {
    return typeof localStorage !== "undefined" ? localStorage : null;
}

function listDesigns() {
    const ls = _ls(); if (!ls) return [];
    try { return JSON.parse(ls.getItem(LS_INDEX) || "[]"); } catch { return []; }
}

function loadDesign(name) {
    const ls = _ls(); if (!ls) return null;
    try { return JSON.parse(ls.getItem(LS_PREFIX + name)); } catch { return null; }
}

function saveDesign(name, cmds) {
    const ls = _ls(); if (!ls) return;
    ls.setItem(LS_PREFIX + name, JSON.stringify(cmds));
    const names = listDesigns();
    if (!names.includes(name)) { names.push(name); ls.setItem(LS_INDEX, JSON.stringify(names)); }
}

function deleteDesign(name) {
    const ls = _ls(); if (!ls) return;
    ls.removeItem(LS_PREFIX + name);
    ls.setItem(LS_INDEX, JSON.stringify(listDesigns().filter(n => n !== name)));
    if (ls.getItem(LS_ACTIVE) === name) ls.removeItem(LS_ACTIVE);
}

function getActiveName()       { return _ls()?.getItem(LS_ACTIVE) ?? null; }
function setActiveName(name)   { _ls()?.setItem(LS_ACTIVE, name); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const m = {
    CMD_SCHEMA, CMD_DEFAULTS, ESC2CMD, CMD2ESC,
    get commands()  { return commands; },
    get undoStack() { return undoStack; },
    get redoStack() { return redoStack; },
    makeId, cmdToEscStr, getInput, splitCommands, parseOneCmd, parseCommands,
    getHandles, getBBox,
    applyChange, undo, redo, pushUndo, resetState,
    listDesigns, loadDesign, saveDesign, deleteDesign, getActiveName, setActiveName,
    onChanged: null, // set by editor.js: function() { autoSave(); scheduleRepaint(); }
};

return m;
})();

// Node.js export for editor.test.js
if (typeof module !== "undefined" && module.exports) module.exports = GGTagModel;
