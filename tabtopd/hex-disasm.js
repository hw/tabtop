// The disassembly panel of the hex view's inspector (see hexView in
// hex-view.js): the selection's instructions, in the instruction set
// chosen, each to click to change while editing; and what a program's
// addresses are named.
import { el } from "./preview-dom.js";

// The disassembly in the inspector: of the selection, up to so many bytes
// and instructions, or, with a byte selected, the bytes from it.
const DISASM_BYTES = 4096, DISASM_WINDOW = 64, DISASM_LINES = 512;
// The bytes after those, given too, so that an instruction that starts in
// them and ends after is read whole (x86's longest is 15 bytes).
const DISASM_AHEAD = 15;
const x86Bitness = (mode) => ({ "x86-16": 16, "x86-32": 32, "x86-64": 64 }[mode]);
// What a line of mode's code is assembled as, to change it in place: x86's
// bitness, or the mode itself (ARM64, RISC-V, MIPS); null for an
// instruction set that's only shown (ARM32, Thumb).
const assembledAs = (mode) => x86Bitness(mode) ?? (mode === "arm64" || /^(riscv|mips)/.test(mode) ? mode : null);
// What fills the room an instruction leaves: its instruction set's nop
// (RISC-V's of two bytes, c.nop: its instructions are of two or four;
// MIPS's is four zeros).
const nopOf = (as) => (as === "arm64" ? [0x1f, 0x20, 0x03, 0xd5] : typeof as !== "string" ? [0x90] : as.startsWith("mips") ? [0, 0, 0, 0] : [0x01, 0x00]);
const hexBytes = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");

// A symbol and how far in: main, main+0x10. short: no more of a long
// name (a C++ or Rust one can be hundreds of letters) than fits a line.
export const symbolText = (at) => (at ? at.name + (at.delta ? `+0x${at.delta.toString(16)}` : "") : "");
export const short = (name) => (name.length > 80 ? `${name.slice(0, 60)}…${name.slice(-16)}` : name);

// disasmPanel makes the panel for view: the hex view's state and what it
// does, read as they're used (getters: its selection, bytes, editor, the
// program read, and those of its functions the panel calls). modes: the
// instruction sets on offer; mode: the one to begin with. It returns its
// element, the instruction set's select (bitness), update (after the
// selection or the bytes change, or the tab), closeAsm, forget (to draw it
// again even if it's of the same bytes) and stop.
export function disasmPanel(view, modes, mode) {
    const { size, disassemble, assemble } = view;
    const disasmBitness = el("select", { className: "hex-disasm-bitness", ariaLabel: "Instruction set", hidden: !modes.length },
        ...modes.map(([value, label]) => el("option", { value: String(value), textContent: label })));
    disasmBitness.value = mode;
    const disasmLines = el("ol", { className: "hex-disasm-lines" });
    const disasmNote = el("p", { className: "hint hex-disasm-note" });
    const disasm = el("div", { className: "hex-disasm" }, disasmLines, disasmNote);
    let disasmTimer = null, disasmAsked = 0, disasmKey = null;
    const placeOf = (offset) => {
        const address = view.program?.map.addressOf(offset);
        if (address == null) return null;
        const section = view.program.map.sectionAt(offset);
        return { section, shift: address - offset, end: section.offset + section.size };
    };
    // An instruction's text, the addresses in it that it goes to or names
    // (targets), and are in the file, links to them: 0x18c, as every
    // instruction set's are shown (or 018Ch). In a program's loaded code (mapped), they're its
    // addresses: a link goes to where in the file that is, if it's there
    // (.bss's isn't), and the symbol there is named after it.
    const withTargets = (text, targets = [], mapped = false) => {
        const out = [];
        let last = 0;
        for (const m of text.matchAll(/\b(?:[0-9][0-9a-f]*h|0x[0-9a-f]+)\b/gi)) {
            const v = Number(BigInt("0x" + m[0].replace(/^0x|h$/gi, "")));
            if (!targets.includes(v)) continue;
            const offset = mapped ? view.program.map.offsetOf(v) : v, name = mapped ? symbolText(view.program.map.symbolAt(v)) : "";
            const there = offset != null && offset < size;
            if (!there && !name) continue;
            out.push(text.slice(last, m.index), there ? el("button", { type: "button", className: "hex-disasm-target", textContent: m[0],
                title: `Go to 0x${offset.toString(16)}`, value: String(offset) }) : m[0]);
            if (name) out.push(el("span", { className: "hex-disasm-symbol", textContent: ` <${short(name)}>`, title: name }));
            last = m.index + m[0].length;
        }
        out.push(text.slice(last));
        return out.filter((p) => p !== "");
    };
    // The code at offset begin as instructions: in a program's section
    // (place), read at its address there; each line's offset is still where
    // it is in the file, which is what's shown, selected and written, with
    // its address beside it (and its targets are addresses).
    const disassembleAt = (code, begin, mode, max, place) => (!place ? disassemble(code, begin, mode, max)
        : disassemble(code, begin + place.shift, mode, max).then((lines) => lines.map((line) => ({ ...line, offset: line.offset - place.shift, address: line.offset }))));
    const runDisasm = async () => {
        if (!view.selected || !view.lastRange) {
            disasmKey = null;
            disasmLines.replaceChildren();
            disasmNote.textContent = "Select bytes to disassemble them.";
            return;
        }
        const n = view.selected.end - view.selected.begin, begin = view.selected.begin;
        const loaded = view.lastRange.begin + view.lastRange.bytes.length;
        if (begin < view.lastRange.begin || begin >= loaded) {
            disasmKey = null;
            disasmLines.replaceChildren();
            disasmNote.textContent = "Those bytes aren't loaded here.";
            return;
        }
        // In a program's loaded section: no further than its end, as what's
        // after is loaded elsewhere.
        const place = placeOf(begin), within = Math.min(loaded, size, place?.end ?? Infinity);
        const end = Math.min(n > 1 ? view.selected.end : begin + DISASM_WINDOW, begin + DISASM_BYTES, within);
        const mode = disasmBitness.value, bitness = x86Bitness(mode);
        const as = assembledAs(mode), canAssemble = !!view.editor && as != null;
        const key = `${begin}-${end}-${mode}#${view.changes}${view.editor ? "e" : ""}${place ? `@${place.shift}` : ""}`;
        if (key === disasmKey) {
            disasm.classList.toggle("editable", canAssemble);
            return;
        }
        const mine = ++disasmAsked;
        const code = view.bytesFrom(view.lastRange, begin, Math.min(end + DISASM_AHEAD, within));
        const hexOfRun = (offset, length) => hexBytes(code.subarray(offset - begin, offset - begin + length), " ");
        try {
            // Those that start in the bytes asked for; the last may end after.
            const lines = (await disassembleAt(code.slice(), begin, mode, DISASM_LINES, place)).filter((l) => l.offset < end);
            if (mine !== disasmAsked) return;
            disasmKey = key;
            asmEdit = null;
            const items = [];
            // (An address can be longer than an offset's 8 digits: the column as wide as the longest.)
            const digits = Math.max(8, ...lines.map((line) => (line.address ?? line.offset).toString(16).length));
            disasmLines.style?.setProperty?.("--hex-disasm-at", `${digits}ch`);
            const rows = lines.map((line) => {
                const { offset, length, text } = line;
                // In a program, by its address (where in the file, on hovering);
                // and under the name of what begins there.
                const at = line.address ?? offset, label = place ? view.program.map.symbolAt(at) : null;
                if (label?.delta === 0) items.push(el("li", { className: "hex-disasm-label", textContent: `${short(label.name)}:`, title: label.name }));
                const parts = [el("span", { className: "hex-disasm-at", textContent: at.toString(16).padStart(digits, "0"), title: place ? `0x${offset.toString(16)} in the file` : "" }),
                    el("span", { className: "hex-disasm-bytes", textContent: hexOfRun(offset, length), title: hexOfRun(offset, length) }),
                    el("span", { className: "hex-disasm-text", title: text }, ...withTargets(text, line.targets, !!place))];
                const li = el("li", { className: text === "(bad)" ? "hex-disasm-line bad" : "hex-disasm-line", title: canAssemble ? "Click to change this instruction" : "" }, ...parts);
                items.push(li);
                return { li, line, parts };
            });
            disasmShown = { rows, lines, mode, as, place };
            disasm.classList.toggle("editable", canAssemble);
            disasmLines.replaceChildren(...items);
            disasmNote.textContent = [lines.length >= DISASM_LINES ? `The first ${DISASM_LINES} instructions.`
                : n <= 1 ? `The ${end - begin} bytes from 0x${begin.toString(16)}; select bytes to disassemble just those.`
                : end < view.selected.end ? `The first ${(end - begin).toLocaleString()} bytes of the selection.` : "",
                canAssemble && lines.length ? "Click an instruction to change it." : "",
                place ? (view.program.info.relocatable ? "Addresses are file offsets: this isn't linked yet, so what it calls isn't filled in."
                    : `Addresses are where ${place.section.name || "this"} is loaded${as == null ? "; instruction editing is available for x86, ARM64, RISC-V and MIPS" : ""}.`)
                : !bitness || view.program ? `Addresses are file offsets${view.program ? " (these bytes aren't in a section that's loaded)" : ""}${as == null ? "; instruction editing is available for x86, ARM64, RISC-V and MIPS" : ""}.` : "",
                ["arm64", "arm32", "thumb", "riscv32", "riscv64"].includes(mode) ? "Little-endian instructions." : "",
                !bitness && begin % (mode === "thumb" || mode.startsWith("riscv") ? 2 : 4) ? "The selection starts at an unaligned address." : ""].filter(Boolean).join(" ");
        } catch (err) {
            if (mine !== disasmAsked) return;
            disasmKey = null;
            disasmShown = null;
            disasm.classList.remove("editable");
            disasmLines.replaceChildren();
            disasmNote.textContent = err.message;
        }
    };
    // Editing, an instruction clicked: a box with it, to type another over
    // it. Enter assembles it (see sharedAssembler) and writes its bytes
    // there, as one change, to undo at once: one shorter is followed by
    // nops to the next; one longer goes over the next (listed or not), the
    // last of those that it ends inside filled out with nops, so what's
    // after still reads as it did. Escape (or leaving it) puts it back.
    let disasmShown = null; // {rows: [{li, line, parts}], lines, mode, as}, as listed
    let asmEdit = null; // {row, line, input, busy}
    const closeAsm = () => {
        if (!asmEdit) return;
        const { row } = asmEdit;
        asmEdit = null;
        row.li.replaceChildren(...row.parts);
        row.li.classList.remove("changing");
    };
    const openAsm = (li) => {
        const row = disasmShown?.rows.find((r) => r.li === li);
        if (!view.editor || !row || !disasm.classList.contains("editable") || disasmShown.as == null || disasmShown.mode !== disasmBitness.value || asmEdit?.row === row) return;
        closeAsm();
        const { line } = row;
        const input = el("input", { type: "text", className: "hex-disasm-input", value: line.text === "(bad)" ? "" : line.text,
            spellcheck: false, autocomplete: "off", ariaLabel: `Instruction at 0x${line.offset.toString(16)}` });
        asmEdit = { row, line, input, busy: false };
        // The box takes the bytes' room too: on a phone, there's little.
        li.replaceChildren(row.parts[0], input);
        li.classList.add("changing");
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                submitAsm();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeAsm();
                // Back to the bytes (Ctrl+S, Ctrl+Z), as after Enter.
                view.content.focus?.({ preventScroll: true });
            }
        });
        input.addEventListener("input", () => input.setCustomValidity?.(""));
        input.addEventListener("blur", () => { if (asmEdit?.input === input && !asmEdit.busy) closeAsm(); });
        input.focus?.();
        input.select?.();
    };
    const submitAsm = async () => {
        const edit = asmEdit;
        if (!edit || edit.busy || !view.editor || disasmShown?.as == null || disasmShown.mode !== disasmBitness.value) return;
        const { line, input } = edit;
        const text = input.value.trim();
        if (!text || text === line.text) {
            closeAsm();
            return;
        }
        const { lines, as, mode, place } = disasmShown;
        // at: where in the file it's written; it's assembled for its
        // address, which a branch's target is from.
        const at = line.offset, was = view.changes;
        edit.busy = true;
        let result, following = lines;
        try {
            // ARM64's are four bytes, each over one: not over the odd bytes
            // at the end of what's there.
            if (as === "arm64" && line.length !== 4) throw new Error("There aren't the four bytes of an ARM64 instruction here.");
            if (typeof as === "string" && as.startsWith("mips") && line.length !== 4) throw new Error("There aren't the four bytes of a MIPS instruction here.");
            result = await assemble(text, line.address ?? at, as, view.bytesFrom(view.lastRange, at, at + line.length));
            // Longer than what's listed after it: the instructions it goes
            // over, past the list, found too, so the last is filled out
            // with nops like the rest.
            const listedEnd = Math.max(...lines.map((l) => l.offset + l.length));
            if (at + result.bytes.length > listedEnd) {
                const loaded = Math.min(view.lastRange.begin + view.lastRange.bytes.length, size);
                if (at + result.bytes.length > loaded) throw new Error("The bytes after it aren't loaded here, so it can't go over them.");
                if (place && at + result.bytes.length > place.end) throw new Error(`That would go past the end of ${place.section.name || "its section"}.`);
                const more = await disassembleAt(view.bytesFrom(view.lastRange, listedEnd, Math.min(listedEnd + 64, loaded, place?.end ?? Infinity)), listedEnd, mode, 16, place);
                following = [...lines, ...more];
            }
        } catch (err) {
            if (asmEdit !== edit) return;
            edit.busy = false;
            input.setCustomValidity?.(err.message);
            input.reportValidity?.();
            view.sayEdit(err.message, true);
            input.focus?.();
            return;
        }
        // Gone: nothing to do. The bytes changed meanwhile: not written.
        if (asmEdit !== edit || !view.editor) return;
        edit.busy = false;
        if (view.changes !== was) {
            // Left meanwhile (its blur ignored, as it was busy): closed.
            if (globalThis.document && globalThis.document.activeElement !== input) {
                closeAsm();
                view.sayEdit("The bytes changed while that was being assembled, so it wasn't written.", true);
                return;
            }
            const why = "The bytes changed while that was being assembled: press Enter to try again.";
            input.setCustomValidity?.(why);
            input.reportValidity?.();
            view.sayEdit(why, true);
            return;
        }
        const n = result.bytes.length;
        let end = at + Math.max(n, line.length);
        const over = following.filter((l) => l.offset > at && l.offset < at + n);
        for (const l of over) end = Math.max(end, l.offset + l.length);
        const nop = nopOf(as);
        // Room that its nops don't fill evenly (an odd byte, in RISC-V)
        // would be left as part of one.
        if ((end - at - n) % nop.length) {
            const why = "There's an odd byte after it here that a nop can't fill.";
            input.setCustomValidity?.(why);
            input.reportValidity?.();
            view.sayEdit(why, true);
            return;
        }
        const run = Uint8Array.from({ length: end - at }, (_, i) => nop[Math.max(0, i - n) % nop.length]);
        run.set(result.bytes);
        const nops = Math.ceil((run.length - n) / nop.length), plural = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
        const said = `0x${at.toString(16)} to ${result.text}` + (over.length ? `, over the ${plural(over.length, "instruction")} after it` : "")
            + (nops ? `, with ${plural(nops, "nop")} after it` : "");
        if (!view.writeRun(at, run, said)) {
            input.setCustomValidity?.(view.editStatus.textContent);
            input.reportValidity?.();
            return;
        }
        // Back to the bytes, for Ctrl+Z (the box goes as the list is redrawn).
        view.content.focus?.({ preventScroll: true });
        // The selection taken on to the end of what was written.
        if (view.selected && view.selected.end - view.selected.begin > 1 && end > view.selected.end) view.selectThrough(view.selected.begin, end - 1, view.selected.from);
    };
    disasmLines.addEventListener("click", (event) => {
        // An address in it: there, its code shown (Back returns here).
        const target = event.target?.closest?.(".hex-disasm-target");
        if (target) {
            closeAsm();
            view.followJump(Number(target.value));
            return;
        }
        const li = event.target?.closest?.(".hex-disasm-line");
        if (li && !event.target.closest?.(".hex-disasm-input")) openAsm(li);
    });
    // After the selection settles, if it's to be seen; the lines there stay
    // till new ones come.
    const updateDisasm = () => {
        clearTimeout(disasmTimer);
        disasmAsked++;
        closeAsm();
        disasm.classList.remove("editable");
        if (view.inspector.hidden || view.inspector.dataset.tab !== "disasm") return;
        disasmTimer = setTimeout(runDisasm, 150);
    };
    return {
        element: disasm,
        bitness: disasmBitness,
        update: updateDisasm,
        closeAsm,
        forget: () => { disasmKey = null; },
        stop: () => { clearTimeout(disasmTimer); disasmAsked++; },
    };
}
