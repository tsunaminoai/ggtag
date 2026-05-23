#!/usr/bin/env node
"use strict";
// editor.test.js — functional tests for model.js logic.
// Run with: node editor.test.js
// No dependencies beyond Node.js built-ins.

// ---------------------------------------------------------------------------
// Mock localStorage for persistence tests
// ---------------------------------------------------------------------------
global.localStorage = (() => {
    const store = Object.create(null);
    return {
        getItem:    k     => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
        setItem:    (k,v) => { store[k] = String(v); },
        removeItem: k     => { delete store[k]; },
        clear:      ()    => { Object.keys(store).forEach(k => delete store[k]); },
    };
})();

// ---------------------------------------------------------------------------
// Load model.js
// ---------------------------------------------------------------------------
const M = require("./model.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;

function assert(cond, msg) {
    if (cond) { console.log("  OK:", msg); passed++; }
    else       { console.error("FAIL:", msg); failed++; }
}

function assertEq(a, b, msg) {
    assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ---------------------------------------------------------------------------
// 1. splitCommands
// ---------------------------------------------------------------------------
console.log("\n1. splitCommands");

{
    const r = M.splitCommands("");
    assertEq(r.length, 0, "empty string → no commands");
}
{
    const r = M.splitCommands("\\t10,20,3,Hello");
    assertEq(r.length, 1, "single command → length 1");
    assertEq(r[0], "\\t10,20,3,Hello", "single command value");
}
{
    const r = M.splitCommands("\\t10,20,3,Hello\\r5,5,50,40");
    assertEq(r.length, 2, "two commands → length 2");
    assertEq(r[0], "\\t10,20,3,Hello", "first cmd");
    assertEq(r[1], "\\r5,5,50,40",     "second cmd");
}
{
    // Escaped backslash inside text must NOT split
    const r = M.splitCommands("\\t10,20,3,Hello\\\\World");
    assertEq(r.length, 1, "escaped backslash in text → still one command");
}
{
    // Two commands, second has escaped backslash
    const r = M.splitCommands("\\t0,0,3,A\\\\B\\r1,2,3,4");
    assertEq(r.length, 2, "escaped backslash followed by real command");
    assertEq(r[0], "\\t0,0,3,A\\\\B", "first cmd with escaped backslash");
}

// ---------------------------------------------------------------------------
// 2. parseOneCmd / parseCommands
// ---------------------------------------------------------------------------
console.log("\n2. parseOneCmd");

{
    const c = M.parseOneCmd("\\t10,20,3,Hello world");
    assert(c !== null, "text cmd parsed");
    assertEq(c.type, "Text", "type = Text");
    assertEq(c.params.x, 10,             "x = 10");
    assertEq(c.params.y, 20,             "y = 20");
    assertEq(c.params.fontSize, 3,       "fontSize = 3");
    assertEq(c.params.text, "Hello world","text preserved");
}
{
    // Text with commas in the text field
    const c = M.parseOneCmd("\\t5,5,2,a,b,c");
    assertEq(c.params.text, "a,b,c", "commas in text field preserved");
}
{
    const c = M.parseOneCmd("\\r10,20,50,30");
    assertEq(c.type, "Rect", "type = Rect");
    assertEq(c.params.width, 50, "width = 50");
    assertEq(c.params.height, 30, "height = 30");
}
{
    const c = M.parseOneCmd("\\f");
    // RFID with no params
    assert(c !== null, "RFID with no params parses");
    assertEq(c.type, "RFID", "type = RFID");
}
{
    const c = M.parseOneCmd("\\Xinvalid");
    assert(c === null, "unknown escape → null");
}
{
    // Escaped backslash in text is unescaped during parse
    const c = M.parseOneCmd("\\t0,0,3,A\\\\B");
    assertEq(c.params.text, "A\\B", "escaped backslash unescaped in text");
}

// ---------------------------------------------------------------------------
// 3. cmdToEscStr (serialisation)
// ---------------------------------------------------------------------------
console.log("\n3. cmdToEscStr");

{
    const cmd = { id: "x", type: "Text", params: { x: 10, y: 20, fontSize: 3, text: "Hello" } };
    assertEq(M.cmdToEscStr(cmd), "\\t10,20,3,Hello", "text serialises correctly");
}
{
    const cmd = { id: "x", type: "Text", params: { x: 0, y: 0, fontSize: 1, text: "A\\B" } };
    assertEq(M.cmdToEscStr(cmd), "\\t0,0,1,A\\\\B", "backslash in text escaped");
}
{
    const cmd = { id: "x", type: "Rect", params: { x: 5, y: 6, width: 20, height: 10 } };
    assertEq(M.cmdToEscStr(cmd), "\\r5,6,20,10", "rect serialises");
}
{
    const cmd = { id: "x", type: "RFID", params: { mode: "em", id: "12", uid: "ABC" } };
    assertEq(M.cmdToEscStr(cmd), "\\fem,12,ABC", "RFID serialises");
}
{
    const cmd = { id: "x", type: "QR code", params: { x: 1, y: 2, pointWidth: 3, text: "https://x.io" } };
    assertEq(M.cmdToEscStr(cmd), "\\q1,2,3,https://x.io", "QR code serialises");
}

// ---------------------------------------------------------------------------
// 4. Round-trip: cmdToEscStr → splitCommands → parseOneCmd
// ---------------------------------------------------------------------------
console.log("\n4. Round-trip serialise → parse");

{
    const orig = { id: "r1", type: "Text", params: { x: 42, y: 7, fontSize: 5, text: "Foo,Bar\\Baz" } };
    const esc  = M.cmdToEscStr(orig);
    const back = M.parseOneCmd(esc);
    assertEq(back.params.text, orig.params.text, "text with comma and backslash round-trips");
    assertEq(back.params.x, 42, "x round-trips");
}
{
    const orig = { id: "r2", type: "Circle", params: { x: 100, y: 100, radius: 50 } };
    const back = M.parseOneCmd(M.cmdToEscStr(orig));
    assertEq(back.params.radius, 50, "circle radius round-trips");
}

// ---------------------------------------------------------------------------
// 5. getInput
// ---------------------------------------------------------------------------
console.log("\n5. getInput");

{
    const cmds = [
        { id: "a", type: "Text", params: { x: 10, y: 20, fontSize: 3, text: "Hi" } },
        { id: "b", type: "Rect", params: { x: 0, y: 0, width: 30, height: 20 } },
    ];
    assertEq(M.getInput(cmds), "\\t10,20,3,Hi\\r0,0,30,20", "getInput joins two commands");
}

// ---------------------------------------------------------------------------
// 6. applyChange / undo / redo
// ---------------------------------------------------------------------------
console.log("\n6. undo / redo");

M.resetState();

{
    assertEq(M.commands.length, 0, "starts empty");
    assertEq(M.undoStack.length, 0, "undo stack empty");
}
{
    const cmd1 = { id: M.makeId(), type: "Text", params: { ...M.CMD_DEFAULTS.Text } };
    M.applyChange([cmd1]);
    assertEq(M.commands.length, 1, "after first applyChange: 1 command");
    assertEq(M.undoStack.length, 1, "undo stack has 1 entry");
    assertEq(M.redoStack.length, 0, "redo stack empty");
}
{
    const cmd2 = { id: M.makeId(), type: "Rect", params: { ...M.CMD_DEFAULTS.Rect } };
    M.applyChange([...M.commands, cmd2]);
    assertEq(M.commands.length, 2, "after second applyChange: 2 commands");
    assertEq(M.undoStack.length, 2, "undo stack has 2 entries");
}
{
    M.undo();
    assertEq(M.commands.length, 1, "after undo: back to 1 command");
    assertEq(M.undoStack.length, 1, "undo stack has 1 entry");
    assertEq(M.redoStack.length, 1, "redo stack has 1 entry");
}
{
    M.redo();
    assertEq(M.commands.length, 2, "after redo: back to 2 commands");
    assertEq(M.redoStack.length, 0, "redo stack cleared");
}
{
    // applyChange clears redo stack
    M.undo();
    M.applyChange([{ id: M.makeId(), type: "Circle", params: { ...M.CMD_DEFAULTS.Circle } }]);
    assertEq(M.redoStack.length, 0, "applyChange clears redo stack");
    assertEq(M.commands[0].type, "Circle", "new command is Circle");
}
{
    // skipUndo does not push undo entry
    const before = M.undoStack.length;
    M.applyChange(M.commands, { skipUndo: true });
    assertEq(M.undoStack.length, before, "skipUndo: undo stack unchanged");
}
{
    // undo past beginning is safe (no crash)
    M.resetState();
    M.undo();
    assertEq(M.commands.length, 0, "undo on empty stack is safe");
}

// ---------------------------------------------------------------------------
// 7. Persistence (localStorage)
// ---------------------------------------------------------------------------
console.log("\n7. Persistence");

{
    localStorage.clear();
    const cmds = [{ id: "p1", type: "Text", params: { x: 1, y: 2, fontSize: 3, text: "save me" } }];
    M.saveDesign("MyDesign", cmds);
    const names = M.listDesigns();
    assertEq(names.length, 1, "one design saved");
    assertEq(names[0], "MyDesign", "design name correct");
}
{
    const loaded = M.loadDesign("MyDesign");
    assert(Array.isArray(loaded), "loadDesign returns array");
    assertEq(loaded[0].params.text, "save me", "text preserved in localStorage");
}
{
    M.saveDesign("MyDesign", [{ id: "p2", type: "Rect", params: { x: 0, y: 0, width: 10, height: 10 } }]);
    assertEq(M.listDesigns().length, 1, "saving same name doesn't add duplicate");
}
{
    M.saveDesign("Other", []);
    assertEq(M.listDesigns().length, 2, "two distinct designs");
}
{
    M.deleteDesign("MyDesign");
    const names = M.listDesigns();
    assertEq(names.length, 1, "after delete: one design");
    assertEq(names[0], "Other", "remaining design is Other");
}
{
    const missing = M.loadDesign("DoesNotExist");
    assert(missing === null, "loadDesign of missing design returns null");
}

// ---------------------------------------------------------------------------
// 8. pushUndo
// ---------------------------------------------------------------------------
console.log("\n8. pushUndo");

M.resetState();
{
    const snap = [{ id: "u1", type: "Text", params: { x: 5, y: 5, fontSize: 1, text: "old" } }];
    M.pushUndo(snap);
    assertEq(M.undoStack.length, 1, "pushUndo adds to undo stack");
    assertEq(M.undoStack[0][0].params.text, "old", "pushUndo preserves snapshot content");
}

// ---------------------------------------------------------------------------
// 9. getHandles geometry
// ---------------------------------------------------------------------------
console.log("\n9. getHandles");

{
    const h = M.getHandles({ type: "Text", params: { x: 20, y: 30 } });
    assertEq(h.length, 1, "Text: 1 handle");
    assertEq(h[0].id, "origin", "Text handle id = origin");
    assertEq(h[0].x, 20, "Text handle x = 20");
    assertEq(h[0].y, 30, "Text handle y = 30");
}
{
    const h = M.getHandles({ type: "Rect", params: { x: 10, y: 20, width: 50, height: 30 } });
    assertEq(h.length, 5, "Rect: 5 handles");
    const ids = h.map(x => x.id);
    assert(ids.includes("tl"), "Rect has tl");
    assert(ids.includes("tr"), "Rect has tr");
    assert(ids.includes("bl"), "Rect has bl");
    assert(ids.includes("br"), "Rect has br");
    assert(ids.includes("move"), "Rect has move");
    const tl = h.find(x => x.id === "tl");
    assertEq(tl.x, 10, "tl.x = x");
    assertEq(tl.y, 20, "tl.y = y");
    const br = h.find(x => x.id === "br");
    assertEq(br.x, 60, "br.x = x+w");
    assertEq(br.y, 50, "br.y = y+h");
    const mv = h.find(x => x.id === "move");
    assertEq(mv.x, 35, "move.x = center x");
    assertEq(mv.y, 35, "move.y = center y");
}
{
    const h = M.getHandles({ type: "FillRect", params: { x: 0, y: 0, width: 100, height: 80 } });
    assertEq(h.length, 5, "FillRect: 5 handles");
}
{
    const h = M.getHandles({ type: "Circle", params: { x: 50, y: 50, radius: 25 } });
    assertEq(h.length, 2, "Circle: 2 handles");
    const center = h.find(x => x.id === "center");
    assertEq(center.x, 50, "circle center x");
    assertEq(center.y, 50, "circle center y");
    const edge = h.find(x => x.id === "edge");
    assertEq(edge.x, 75, "circle edge x = x+radius");
    assertEq(edge.y, 50, "circle edge y = y");
}
{
    const h = M.getHandles({ type: "FillCircle", params: { x: 0, y: 0, radius: 10 } });
    assertEq(h.length, 2, "FillCircle: 2 handles");
}
{
    const h = M.getHandles({ type: "Line", params: { x1: 5, y1: 10, x2: 100, y2: 200 } });
    assertEq(h.length, 2, "Line: 2 handles");
    assertEq(h[0].id, "p1", "Line first handle = p1");
    assertEq(h[0].x, 5,  "p1.x = x1");
    assertEq(h[0].y, 10, "p1.y = y1");
    assertEq(h[1].id, "p2", "Line second handle = p2");
    assertEq(h[1].x, 100, "p2.x = x2");
    assertEq(h[1].y, 200, "p2.y = y2");
}
{
    const h = M.getHandles({ type: "QR code", params: { x: 15, y: 25, pointWidth: 2, text: "hi" } });
    assertEq(h.length, 1, "QR code: 1 handle");
    assertEq(h[0].id, "origin", "QR handle = origin");
}
{
    const h = M.getHandles({ type: "Icon", params: { x: 10, y: 20, height: 32, name: "bug" } });
    assertEq(h.length, 2, "Icon: 2 handles");
    const orig = h.find(x => x.id === "origin");
    const size = h.find(x => x.id === "size");
    assertEq(orig.x, 10, "icon origin x");
    assertEq(size.x, 42, "icon size.x = x+height");
    assertEq(size.y, 52, "icon size.y = y+height");
}
{
    const h = M.getHandles({ type: "RFID", params: { mode: "em", id: "1", uid: "2", _x: 10, _y: 210 } });
    assertEq(h.length, 1, "RFID: 1 handle (origin)");
    assertEq(h[0].id, "origin", "RFID handle = origin");
    assertEq(h[0].x, 10,  "RFID handle x = _x");
    assertEq(h[0].y, 210, "RFID handle y = _y");
}
{
    assertEq(M.getHandles(null).length, 0, "null cmd → 0 handles");
}

// Hit-test distance math (HIT_R = 8 canvas pixels)
{
    const HIT_R = 8;
    function hits(hx, hy, cx, cy) {
        const dx = cx - hx, dy = cy - hy;
        return dx * dx + dy * dy <= HIT_R * HIT_R;
    }
    assert(hits(100, 100, 100, 100), "exact center → hit");
    assert(hits(100, 100, 107, 100), "7px away → hit");
    assert(!hits(100, 100, 109, 100), "9px away → miss");
    assert(hits(100, 100, 105, 105), "diagonal ~5.66px → hit");
    assert(!hits(100, 100, 110, 110), "diagonal ~14px → miss");
}

// ---------------------------------------------------------------------------
// 10. getBBox geometry
// ---------------------------------------------------------------------------
console.log("\n10. getBBox");

{
    const b = M.getBBox({ type: "Text", params: { x: 10, y: 20, fontSize: 3, text: "Hello" } });
    assert(b !== null, "Text bbox exists");
    assertEq(b.x, 10, "Text bbox x");
    assertEq(b.y, 20, "Text bbox y");
    // fontSize 3 → charH 16, charW = round(16*0.6)=10, "Hello"=5 chars → w=50
    assertEq(b.h, 16, "Text bbox h = charH for fontSize 3");
    assertEq(b.w, 50, "Text bbox w = 5 chars × 10px");
}
{
    const b = M.getBBox({ type: "Rect", params: { x: 5, y: 10, width: 80, height: 40 } });
    assertEq(b.x, 5,  "Rect bbox x");
    assertEq(b.y, 10, "Rect bbox y");
    assertEq(b.w, 80, "Rect bbox w");
    assertEq(b.h, 40, "Rect bbox h");
}
{
    const b = M.getBBox({ type: "Circle", params: { x: 50, y: 60, radius: 20 } });
    assertEq(b.x, 30, "Circle bbox x = x-r");
    assertEq(b.y, 40, "Circle bbox y = y-r");
    assertEq(b.w, 40, "Circle bbox w = 2r");
    assertEq(b.h, 40, "Circle bbox h = 2r");
}
{
    const b = M.getBBox({ type: "Line", params: { x1: 10, y1: 20, x2: 90, y2: 80 } });
    assertEq(b.x, 6,  "Line bbox x = min(x1,x2)-4");
    assertEq(b.y, 16, "Line bbox y = min(y1,y2)-4");
    assertEq(b.w, 88, "Line bbox w = |x2-x1|+8");
    assertEq(b.h, 68, "Line bbox h = |y2-y1|+8");
}
{
    const b = M.getBBox({ type: "QR code", params: { x: 5, y: 10, pointWidth: 2, text: "hi" } });
    assertEq(b.x, 5, "QR bbox x");
    // pw=2 → sz = 2*21 = 42 (version-1 QR = 21 modules)
    assertEq(b.w, 42, "QR bbox w = pw*21");
    assertEq(b.h, 42, "QR bbox h = pw*21");
}
{
    const b = M.getBBox({ type: "Icon", params: { x: 10, y: 20, height: 48, name: "star" } });
    assertEq(b.w, 48, "Icon bbox w = height");
    assertEq(b.h, 48, "Icon bbox h = height");
}
{
    const b = M.getBBox({ type: "RFID", params: { mode: "em", id: "1", uid: "2", _x: 15, _y: 200 } });
    assertEq(b.x, 15,  "RFID bbox x = _x");
    assertEq(b.y, 200, "RFID bbox y = _y");
    assertEq(b.w, 120, "RFID bbox w = 120");
}
{
    assert(M.getBBox(null) === null, "null cmd → null bbox");
}

// Hit-containment math
{
    function inBox(b, cx, cy) {
        return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
    }
    const b = M.getBBox({ type: "Rect", params: { x: 10, y: 20, width: 50, height: 30 } });
    assert(inBox(b, 35, 35),   "center of rect → hit");
    assert(inBox(b, 10, 20),   "top-left corner → hit");
    assert(!inBox(b, 9, 20),   "one pixel left → miss");
    assert(!inBox(b, 35, 51),  "one pixel below → miss");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
