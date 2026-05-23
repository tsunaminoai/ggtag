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
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
