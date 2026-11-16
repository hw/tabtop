// What tabtop's own assemblers (riscv-asm.js, mips-asm.js) have the same:
// how a number is shown and read, how a line is taken apart, and the going
// through an instruction's rows for the one a line is. Each of them has its
// own table of instructions and its own operands; this is the rest.
//
// A classic script, loaded before either (in the worker, disasm-worker.js):
// self.asmCommon is {shown, number, small, parseLine, assembleLine}.
"use strict";
(function (root) {
    // A number as it's shown: in hex from ten; and read: hex or not, BigInt
    // (number), or a number if it's one a number holds exactly (small).
    const shown = (v) => (v < 0 ? "-" : "") + (Math.abs(v) > 9 ? `0x${Math.abs(v).toString(16)}` : `${Math.abs(v)}`);
    function number(text) {
        const m = /^([+-]?)(0x[0-9a-f]+|\d+)$/.exec(text);
        return m ? (m[1] === "-" ? -BigInt(m[2]) : BigInt(m[2])) : null;
    }
    const small = (text) => {
        const v = number(text);
        return v != null && v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : null;
    };

    // A line as typed: its name, and its operands, at the commas outside
    // brackets (round, as 8(sp), or square, as $w1[3]); in small letters,
    // without what's after ; # or //.
    function parseLine(text) {
        const line = text.toLowerCase().split(/[;#]|\/\//)[0].trim().replace(/\s+/g, " ");
        const space = line.indexOf(" ");
        const name = space < 0 ? line : line.slice(0, space), rest = space < 0 ? "" : line.slice(space + 1).replace(/ /g, "");
        const operands = [];
        let depth = 0, from = 0;
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "(" || rest[i] === "[") depth++;
            else if (rest[i] === ")" || rest[i] === "]") depth--;
            else if (rest[i] === "," && depth === 0) {
                operands.push(rest.slice(from, i));
                from = i + 1;
            }
        }
        if (rest) operands.push(rest.slice(from));
        return { name, operands };
    }

    // The line as an instruction: what `done` makes of the first of its
    // name's rows that the line's operands are right for. It throws what's
    // wrong with a line that isn't an instruction here (what was typed in
    // quotes where it's first, as the page gives what's said a capital).
    //
    // named: rows by name, each {match, operands, xlen}; xlen, the width
    // (32 or 64) this is for, and family what its instructions are called
    // with it ("RV", "MIPS": "addiw" is only in RV64). kinds(row) is the
    // row's operands, each with read(text, context), the value written
    // (null: not one); context() is what read is given; put(kind, value,
    // word) is the word with the value in it, or null if it can't be that
    // there; done(row, word) is what's answered, or null if the word isn't
    // read back as an instruction.
    function assembleLine(text, { named, xlen, family, kinds, context, put, done }) {
        if (text.length > 200) throw new Error("That's too long to be an instruction.");
        const { name, operands: typed } = parseLine(text);
        if (!name) throw new Error("There's no instruction there.");
        const rows = named.get(name);
        if (!rows) throw new Error(`There's no instruction called ${name}.`);
        const here = rows.filter((r) => !r.xlen || r.xlen === xlen);
        if (!here.length) throw new Error(`"${name}" is only in ${family}${rows[0].xlen}.`);
        const counted = here.filter((r) => r.operands.length === typed.length);
        if (!counted.length) {
            const counts = [...new Set(here.map((r) => r.operands.length))].sort();
            throw new Error(`"${name}" takes ${counts.join(" or ")} operand${counts.length === 1 && counts[0] === 1 ? "" : "s"}, not ${typed.length}.`);
        }
        let why = null;
        for (const row of counted) {
            const given = context(), operands = kinds(row);
            let word = row.match, wrong = null;
            for (let i = 0; i < typed.length && !wrong; i++) {
                const value = operands[i].read(typed[i], given);
                if (value == null) wrong = `${typed[i] ? `"${typed[i]}"` : "Nothing"} isn't what ${name} takes ${["first", "second", "third", "fourth", "fifth"][i]}.`;
                else {
                    const next = put(operands[i], value, word);
                    if (next == null) wrong = `"${typed[i]}" isn't one ${name} can have there.`;
                    else word = next;
                }
            }
            // As it's then read: the same instruction, by this name or another's.
            const answer = wrong ? null : done(row, word);
            if (!wrong && !answer) wrong = "That isn't an instruction as it would be written.";
            if (wrong) {
                why ??= wrong;
                continue;
            }
            return answer;
        }
        throw new Error(why);
    }

    root.asmCommon = { shown, number, small, parseLine, assembleLine };
})(typeof self !== "undefined" ? self : globalThis);
