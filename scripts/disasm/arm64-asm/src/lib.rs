//! ARM64 for the hex view: its disassembly, with fARM64's decoder and
//! formatter; and the assembling of a line of it, as shown, into the 32-bit
//! words it could be. fARM64 has an encoder but no assembler: this reads
//! the line, tries each encoding fARM64 knows with the operands read each
//! way they could be meant, and keeps the words that decode back as that
//! instruction. Which of them is written is the worker's to say (see
//! disasm-worker.js): the one that's shown as the line typed.
//!
//! Addresses are what the disassembly shows (file offsets): a branch's
//! target is absolute, as shown.
#![allow(non_snake_case)]

mod sysreg_names;

use std::collections::HashMap;

use fARM64::format::{FmtFormatter, Formatter, FormatterOptions, FormatterOutput, TokenKind};
use fARM64::{
    Code, Condition, Decoder, DecoderOptions, ExtendType, Instruction, MemIndexMode, Mnemonic, Operand, Register,
    ShiftType, VectorArrangement,
};

/// The most words one line is answered with, and the most ways its
/// operands are tried.
const MAX_WORDS: usize = 64;
const MAX_WAYS: usize = 512;

/// A shift or extension after an operand: `lsl #3`, `uxtw`, `sxtw #2`.
#[derive(Clone, Copy)]
enum Modifier {
    Shift(ShiftType, u8),
    Extend(ExtendType, Option<u8>),
}

/// An operand as written, before it's known which encoding it's for.
#[derive(Clone)]
enum Item {
    Reg { reg: Register, arr: Option<VectorArrangement>, lane: Option<u8>, modifier: Option<Modifier> },
    Imm { value: i128, float: Option<f32>, lsl: Option<u8> },
    Mem { base: Register, imm: i64, mode: MemIndexMode },
    MemIndex { base: Register, index: Register, extend: ExtendType, amount: Option<u8> },
    Cond(Condition),
}

pub struct Assembler {
    registers: HashMap<String, Register>,
    mnemonics: HashMap<&'static str, Mnemonic>,
    codes: Vec<Code>,
}

fn decode(word: u32, ip: u64) -> Instruction {
    Decoder::new(&word.to_le_bytes(), ip, DecoderOptions::default()).decode()
}

const CONDITIONS: [(&str, u8); 18] = [
    ("eq", 0), ("ne", 1), ("cs", 2), ("hs", 2), ("cc", 3), ("lo", 3), ("mi", 4), ("pl", 5), ("vs", 6), ("vc", 7),
    ("hi", 8), ("ls", 9), ("ge", 10), ("lt", 11), ("gt", 12), ("le", 13), ("al", 14), ("nv", 15),
];
const ARRANGEMENTS: [(&str, VectorArrangement); 12] = [
    ("8b", VectorArrangement::V8B), ("16b", VectorArrangement::V16B), ("4h", VectorArrangement::V4H),
    ("8h", VectorArrangement::V8H), ("2s", VectorArrangement::V2S), ("4s", VectorArrangement::V4S),
    ("1d", VectorArrangement::V1D), ("2d", VectorArrangement::V2D), ("2h", VectorArrangement::V2H),
    ("4b", VectorArrangement::V4B), ("2b", VectorArrangement::V2B), ("1q", VectorArrangement::V1Q),
];
/// A lane's element alone, as `v0.s[1]` has it.
const ELEMENTS: [(&str, VectorArrangement); 4] = [
    ("b", VectorArrangement::V16B), ("h", VectorArrangement::V8H), ("s", VectorArrangement::V4S), ("d", VectorArrangement::V2D),
];
const SHIFTS: [(&str, ShiftType); 5] =
    [("lsl", ShiftType::Lsl), ("lsr", ShiftType::Lsr), ("asr", ShiftType::Asr), ("ror", ShiftType::Ror), ("msl", ShiftType::Msl)];
const EXTENDS: [(&str, ExtendType); 8] = [
    ("uxtb", ExtendType::Uxtb), ("uxth", ExtendType::Uxth), ("uxtw", ExtendType::Uxtw), ("uxtx", ExtendType::Uxtx),
    ("sxtb", ExtendType::Sxtb), ("sxth", ExtendType::Sxth), ("sxtw", ExtendType::Sxtw), ("sxtx", ExtendType::Sxtx),
];

impl Default for Assembler {
    fn default() -> Self {
        Self::new()
    }
}

impl Assembler {
    pub fn new() -> Self {
        // fARM64 names its registers but doesn't look them up by name:
        // each is taken from an instruction decoded with it.
        let mut registers = HashMap::new();
        let mut take = |word: u32, op: usize| {
            let insn = decode(word, 0);
            if !insn.is_invalid() && op < insn.op_count() {
                let reg = insn.op_register(op);
                registers.entry(reg.name().to_ascii_lowercase()).or_insert(reg);
            }
        };
        for n in 0..32u32 {
            take(0xaa00_03e0 | n, 0); // mov xN, x0 (xzr at 31)
            take(0x2a00_03e0 | n, 0); // mov wN, w0 (wzr)
            take(0x9100_0000 | n, 0); // add xN, x0, #0 (sp)
            take(0x1100_0000 | n, 0); // add wN, w0, #0 (wsp)
            take(0x4ea0_1c00 | n, 0); // mov vN.16b, v0.16b
            take(0x3dc0_0000 | n, 0); // ldr qN, [x0]
            take(0xfd40_0000 | n, 0); // ldr dN, [x0]
            take(0xbd40_0000 | n, 0); // ldr sN, [x0]
            take(0x7d40_0000 | n, 0); // ldr hN, [x0]
            take(0x3d40_0000 | n, 0); // ldr bN, [x0]
        }
        for (alias, name) in [("lr", "x30"), ("fp", "x29"), ("ip0", "x16"), ("ip1", "x17")] {
            if let Some(reg) = registers.get(name).copied() {
                registers.insert(alias.to_string(), reg);
            }
        }
        let mnemonics = Mnemonic::values().map(|m| (m.name(), m)).collect();
        Assembler { registers, mnemonics, codes: Code::values().filter(|c| *c != Code::Invalid).collect() }
    }

    /// The words `text` could be at `address`, likeliest first; or why not.
    pub fn assemble(&self, text: &str, address: u64) -> Result<Vec<u32>, String> {
        let line = text.split(';').next().unwrap_or("").split("//").next().unwrap_or("").trim().to_ascii_lowercase();
        let (name, rest) = match line.find(char::is_whitespace) {
            Some(at) => (&line[..at], line[at..].trim()),
            None => (line.as_str(), ""),
        };
        if name.is_empty() {
            return Err("Type an instruction.".into());
        }
        // b.eq: the branch, on a condition.
        let mut items = Vec::new();
        let mut mnemonic = self.mnemonics.get(name).copied();
        if mnemonic.is_none() {
            if let Some((head, cond)) = name.split_once('.') {
                if let (Some(m), Some(c)) = (self.mnemonics.get(head), condition(cond)) {
                    mnemonic = Some(*m);
                    items.push(Item::Cond(c));
                }
            }
        }
        let mnemonic = mnemonic.ok_or_else(|| format!("\"{name}\" isn't an ARM64 instruction."))?;
        self.operands(rest, &mut items)?;

        let ways = ways(&items);
        let mut words: Vec<u32> = Vec::new();
        for ops in &ways {
            for code in &self.codes {
                let mut insn = Instruction::default();
                insn.set_ip(address);
                insn.set_code(*code);
                insn.set_mnemonic(mnemonic);
                if !ops.iter().all(|op| insn.push_op(*op)) {
                    continue;
                }
                let Ok(word) = insn.encode() else { continue };
                if words.contains(&word) {
                    continue;
                }
                // It decodes as that instruction, by this name or its own.
                let back = decode(word, address);
                if back.is_invalid() || (back.mnemonic() != mnemonic && back.code().mnemonic() != mnemonic) {
                    continue;
                }
                words.push(word);
                if words.len() == MAX_WORDS {
                    return Ok(words);
                }
            }
        }
        if words.is_empty() {
            return Err(format!("Those operands don't go with {name}."));
        }
        Ok(words)
    }

    fn register(&self, text: &str) -> Option<Item> {
        // v0.16b, v1.s[2], v2.d[1]
        let (text, lane) = match text.strip_suffix(']').and_then(|t| t.split_once('[')) {
            Some((head, index)) => (head.trim(), Some(index.trim().parse::<u8>().ok()?)),
            None => (text, None),
        };
        let (name, arr) = match text.split_once('.') {
            Some((name, suffix)) => {
                let table: &[(&str, VectorArrangement)] = if lane.is_some() && suffix.len() == 1 { &ELEMENTS } else { &ARRANGEMENTS };
                (name, Some(table.iter().find(|(s, _)| *s == suffix)?.1))
            }
            None => (text, None),
        };
        if lane.is_some() && arr.is_none() {
            return None;
        }
        let reg = *self.registers.get(name)?;
        Some(Item::Reg { reg, arr, lane, modifier: None })
    }

    fn plain_register(&self, text: &str) -> Result<Register, String> {
        match self.register(text) {
            Some(Item::Reg { reg, arr: None, lane: None, .. }) => Ok(reg),
            _ => Err(format!("\"{text}\" isn't a register.")),
        }
    }

    fn operands(&self, rest: &str, items: &mut Vec<Item>) -> Result<(), String> {
        if rest.is_empty() {
            return Ok(());
        }
        for token in split(rest) {
            let token = token.trim();
            if token.is_empty() {
                return Err("There's an operand missing.".into());
            }
            if token.starts_with('{') {
                return Err("Lists of registers can't be assembled here yet.".into());
            }
            if token.starts_with('[') {
                items.push(self.memory(token)?);
                continue;
            }
            if let Some(modifier) = modifier(token)? {
                match (items.last_mut(), modifier) {
                    (Some(Item::Reg { modifier: slot @ None, .. }), m) => *slot = Some(m),
                    (Some(Item::Imm { lsl: slot @ None, .. }), Modifier::Shift(ShiftType::Lsl, amount)) => *slot = Some(amount),
                    _ => return Err(format!("\"{token}\" has nothing to go with.")),
                }
                continue;
            }
            if let Some(item) = self.register(token) {
                items.push(item);
                continue;
            }
            if let Some(c) = condition(token) {
                items.push(Item::Cond(c));
                continue;
            }
            if let Some((value, float)) = number(token) {
                // ldr x0, [x1], #8: after the memory it's added to.
                if let Some(Item::Mem { imm: slot @ 0, mode: mode @ MemIndexMode::Offset, .. }) = items.last_mut() {
                    if float.is_none() {
                        *slot = value as i64;
                        *mode = MemIndexMode::PostImm;
                        continue;
                    }
                }
                items.push(Item::Imm { value, float, lsl: None });
                continue;
            }
            return Err(format!("\"{token}\" isn't an operand that can be assembled here."));
        }
        Ok(())
    }

    /// [x1], [x1, #8], [x1, #8]!, [x1, x2], [x1, x2, lsl #3], [x1, w2, sxtw #2]
    fn memory(&self, token: &str) -> Result<Item, String> {
        let (inner, pre) = match token.strip_suffix("]!") {
            Some(inner) => (inner, true),
            None => (token.strip_suffix(']').ok_or_else(|| format!("\"{token}\" isn't an address."))?, false),
        };
        let parts: Vec<&str> = inner[1..].split(',').map(str::trim).collect();
        let base = self.plain_register(parts[0])?;
        match parts.len() {
            1 => Ok(Item::Mem { base, imm: 0, mode: if pre { MemIndexMode::PreIndex } else { MemIndexMode::Offset } }),
            2 | 3 => {
                if let Some((value, None)) = number(parts[1]) {
                    if parts.len() == 3 {
                        return Err(format!("\"{token}\" isn't an address."));
                    }
                    return Ok(Item::Mem { base, imm: value as i64, mode: if pre { MemIndexMode::PreIndex } else { MemIndexMode::Offset } });
                }
                let index = self.plain_register(parts[1])?;
                if pre {
                    return Err(format!("\"{token}\" isn't an address."));
                }
                let (extend, amount) = match parts.get(2) {
                    None => (ExtendType::Uxtx, None),
                    Some(m) => match modifier(m)? {
                        Some(Modifier::Shift(ShiftType::Lsl, amount)) => (ExtendType::Uxtx, Some(amount)),
                        Some(Modifier::Extend(extend, amount)) => (extend, amount),
                        _ => return Err(format!("\"{m}\" can't be in an address.")),
                    },
                };
                Ok(Item::MemIndex { base, index, extend, amount })
            }
            _ => Err(format!("\"{token}\" isn't an address.")),
        }
    }
}

fn condition(name: &str) -> Option<Condition> {
    CONDITIONS.iter().find(|(n, _)| *n == name).map(|(_, bits)| Condition::from_u4(*bits))
}

/// Splits at commas outside brackets and braces.
fn split(text: &str) -> Vec<&str> {
    let (mut out, mut depth, mut from) = (Vec::new(), 0i32, 0);
    for (i, c) in text.char_indices() {
        match c {
            '[' | '{' => depth += 1,
            ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                out.push(&text[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    out.push(&text[from..]);
    out
}

/// A number: #0x1f, 0x1f, 12, -8, #-0x10, or with a point or an exponent
/// (1.0, 1.25e+00), as a float too.
fn number(token: &str) -> Option<(i128, Option<f32>)> {
    let t = token.strip_prefix('#').unwrap_or(token).trim();
    let (negative, digits) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    if digits.is_empty() || !digits.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    if let Some(hex) = digits.strip_prefix("0x") {
        let value = u64::from_str_radix(hex, 16).ok()? as i128;
        return Some((if negative { -value } else { value }, None));
    }
    if digits.bytes().all(|b| b.is_ascii_digit()) {
        let value = digits.parse::<u64>().ok()? as i128;
        return Some((if negative { -value } else { value }, None));
    }
    let float = t.parse::<f32>().ok()?;
    Some((float as i128, Some(float)))
}

fn modifier(token: &str) -> Result<Option<Modifier>, String> {
    let (name, rest) = match token.find(char::is_whitespace) {
        Some(at) => (&token[..at], token[at..].trim()),
        None => (token, ""),
    };
    let amount = |rest: &str| -> Result<Option<u8>, String> {
        if rest.is_empty() {
            return Ok(None);
        }
        match number(rest) {
            Some((value, None)) if (0..=255).contains(&value) => Ok(Some(value as u8)),
            _ => Err(format!("\"{rest}\" isn't an amount to shift by.")),
        }
    };
    if let Some((_, shift)) = SHIFTS.iter().find(|(n, _)| *n == name) {
        return match amount(rest)? {
            Some(n) => Ok(Some(Modifier::Shift(*shift, n))),
            None => Err(format!("\"{token}\" needs an amount, as lsl #3.")),
        };
    }
    if let Some((_, extend)) = EXTENDS.iter().find(|(n, _)| *n == name) {
        return Ok(Some(Modifier::Extend(*extend, amount(rest)?)));
    }
    Ok(None)
}

fn reg(reg: Register, arr: Option<VectorArrangement>, lane: Option<u8>, shift: Option<(ShiftType, u8)>, extend: Option<ExtendType>) -> Operand {
    Operand::Reg { reg, arr, lane, shift, extend, pred: None }
}

/// The operands fARM64 could hold an item as: which it is depends on the
/// encoding (an immediate is one of several kinds), so each is tried.
fn candidates(item: &Item) -> Vec<Operand> {
    match *item {
        Item::Reg { reg: r, arr, lane, modifier } => match modifier {
            None => vec![reg(r, arr, lane, None, None)],
            // add x0, sp, x1, lsl #2 is the extended form's, too.
            Some(Modifier::Shift(ShiftType::Lsl, n)) => vec![
                reg(r, arr, lane, Some((ShiftType::Lsl, n)), None),
                reg(r, arr, lane, Some((ShiftType::Lsl, n)), Some(ExtendType::Uxtx)),
                reg(r, arr, lane, Some((ShiftType::Lsl, n)), Some(ExtendType::Uxtw)),
            ],
            Some(Modifier::Shift(shift, n)) => vec![reg(r, arr, lane, Some((shift, n)), None)],
            Some(Modifier::Extend(extend, Some(n))) => vec![reg(r, arr, lane, Some((ShiftType::Lsl, n)), Some(extend))],
            Some(Modifier::Extend(extend, None)) => {
                vec![reg(r, arr, lane, None, Some(extend)), reg(r, arr, lane, Some((ShiftType::Lsl, 0)), Some(extend))]
            }
        },
        Item::Imm { value, float, lsl } => {
            let mut out = Vec::new();
            if let Some(f) = float {
                out.push(Operand::FpImm(f));
                return out;
            }
            if let Some(lsl) = lsl {
                if (0..=0xffff).contains(&value) {
                    out.push(Operand::ImmShiftedMove { imm: value as u16, lsl });
                }
                return out;
            }
            out.push(Operand::ImmSigned(value as i64));
            out.push(Operand::ImmUnsigned(value as u64));
            out.push(Operand::ImmLogical(value as u64));
            out.push(Operand::Label(value as u64));
            if (0..=0xffff).contains(&value) {
                out.push(Operand::ImmShiftedMove { imm: value as u16, lsl: 0 });
            }
            // sub sp, sp, #0x1000: #1, lsl #12, as it's then shown.
            if value & 0xfff == 0 && (1..=0xfff).contains(&(value >> 12)) {
                out.push(Operand::ImmShiftedMove { imm: (value >> 12) as u16, lsl: 12 });
            }
            if (0..=255).contains(&value) {
                out.push(Operand::ShiftAmount(value as u8));
            }
            out.push(Operand::FpImm(value as f32));
            out
        }
        Item::Mem { base, imm, mode } => {
            let mut out = vec![Operand::MemImm { base, imm, mode }];
            if imm == 0 && mode == MemIndexMode::Offset {
                out.push(Operand::MemImm { base, imm, mode: MemIndexMode::PreNoOffset });
            }
            out
        }
        // The amount's top bit says it's shown (see fARM64's formatter).
        Item::MemIndex { base, index, extend, amount } => match amount {
            Some(n) => vec![
                Operand::MemExt { base, index, extend, shift: n | 0x80 },
                Operand::MemExt { base, index, extend, shift: n },
            ],
            None => vec![Operand::MemExt { base, index, extend, shift: 0 }, Operand::MemExt { base, index, extend, shift: 0x80 }],
        },
        Item::Cond(c) => vec![Operand::Cond(c)],
    }
}

/// Every way the items go together, the first candidate of each first.
fn ways(items: &[Item]) -> Vec<Vec<Operand>> {
    let mut out: Vec<Vec<Operand>> = vec![Vec::new()];
    for item in items {
        let options = candidates(item);
        let mut next = Vec::with_capacity(out.len() * options.len());
        for way in &out {
            for option in &options {
                if next.len() == MAX_WAYS {
                    break;
                }
                let mut way = way.clone();
                way.push(*option);
                next.push(way);
            }
        }
        out = next;
    }
    out
}

/// An instruction as it's shown: fARM64's text, one space after its name,
/// and a number under ten as it is (#8, lsl #2; not #0x8), as such lines
/// are mostly written. An address stays in hex, which the view links.
struct Shown {
    text: String,
    held: bool,
}

impl FormatterOutput for Shown {
    fn write(&mut self, text: &str, kind: TokenKind) {
        // A number comes as its 0x, then its digits.
        if std::mem::take(&mut self.held) && !(kind == TokenKind::Number && text.len() == 1 && text.as_bytes()[0].is_ascii_digit()) {
            self.text.push_str("0x");
        }
        if kind == TokenKind::Number && text == "0x" {
            self.held = true;
        } else {
            self.text.push_str(text);
        }
    }
}

/// The word at `address` as it's shown, and the address it names (where it
/// branches to, or what adr, adrp or a load gives by address); or `None`,
/// for one that isn't an instruction.
pub fn shown(word: u32, address: u64) -> Option<(String, Option<u64>)> {
    let insn = decode(word, address);
    if insn.is_invalid() {
        return None;
    }
    let formatter = FmtFormatter::with_options(FormatterOptions { first_operand_char_index: 0, ..FormatterOptions::default() });
    let mut out = Shown { text: String::new(), held: false };
    formatter.format(&insn, &mut out);
    if out.held {
        out.text.push_str("0x");
    }
    let target = (0..insn.op_count()).find_map(|n| match insn.op(n) {
        Operand::Label(target) => Some(target),
        _ => None,
    });
    let text = out.text.trim_end().to_string();
    Some((put_right(&formatter, &insn, word, &text).unwrap_or(text), target))
}

/// `text` with what fARM64 writes otherwise than Arm does put right, where
/// there's any of it; `None` where there's none, or the text isn't its
/// name and operands as each is written alone.
///
/// - SME's ZA tiles. fARM64 writes a tile as Binary Ninja does, as a z
///   register (fmopa z2.s for fmopa za2.s; z2h.s[w13, #1] for
///   za2h.s[w13, 1]), and of a load or store of a tile's slice doesn't keep
///   which tile (always z0): that's in the word's low four bits, above the
///   slice's number.
/// - SVE's adr of 32-bit offsets, [z0.d, z1.d, sxtw], which it writes
///   without the sxtw or uxtw where nothing's shifted.
/// - SVE2's ext of a pair, ext z0.b, {z1.b, z2.b}, #1, which it gives a
///   z0.b before the number.
/// - ld1rob, ld1roh, ld1row, ld1rod's offset, which it writes in 32s.
/// - An index that's xzr, for none: ldff1b {z0.b}, p0/z, [x0, xzr] is
///   [x0]; so with ldnt1b, stnt1b and theirs from a vector's addresses, and
///   a load or store of a tile's slice.
/// - psel's index, p1.b[w12, 0], which it leaves out at 0, and gives a #.
/// - A system register it has no name for (it has the commonest), which it
///   writes by its numbers: mrs x0, s3_4_c1_c1_2 is mrs x0, cptr_el2 (see
///   sysreg_names.rs).
fn put_right(formatter: &FmtFormatter, insn: &Instruction, word: u32, text: &str) -> Option<String> {
    let piece = |write: &dyn Fn(&mut Shown)| {
        let mut out = Shown { text: String::new(), held: false };
        write(&mut out);
        if out.held {
            out.text.push_str("0x");
        }
        out.text.trim_end().to_string()
    };
    let name = insn.mnemonic().name().to_ascii_lowercase();
    // Into a tile: the outer products, and addha, addva.
    let into = ["mopa", "mops", "mop4a", "mop4s"].iter().any(|end| name.ends_with(end)) || name == "addha" || name == "addva";
    let moved = name.starts_with("ld1") || name.starts_with("st1");
    let mut operands: Vec<String> = (0..insn.op_count()).map(|n| piece(&|out| formatter.format_operand(insn, n, out))).collect();
    let written_name = piece(&|out| formatter.format_mnemonic(insn, out));
    if format!("{written_name} {}", operands.join(", ")) != text {
        return None;
    }
    let before = operands.clone();
    let mut tile = false;
    for n in 0..insn.op_count() {
        let written = operands[n].clone();
        match insn.op(n) {
            Operand::SmeTileSlice { reg, imm, has_imm, .. } if reg != Register::None => {
                // z2h.s[w13, #1]: its tile, h or v, its elements, what selects the slice.
                let (dot, open) = (written.find('.')?, written.find('[')?);
                let end = written[open..].find([',', ']'])? + open;
                let (way, elements, select) = (written.get(dot.checked_sub(1)?..dot)?, written.get(dot + 1..open)?, written.get(open + 1..end)?);
                let number = if moved {
                    (word & 0xf) >> ["q", "d", "s", "h", "b"].iter().position(|e| *e == elements)?
                } else {
                    written.get(1..dot - 1)?.parse().ok()?
                };
                let slice = format!("za{number}{way}.{elements}[{select}, {}]", if has_imm { imm } else { 0 });
                operands[n] = if moved { format!("{{{slice}}}") } else { slice };
                tile = moved;
            }
            Operand::Reg { .. } if n == 0 && into && written.starts_with('z') => operands[n] = format!("za{}", &written[1..]),
            _ => {}
        }
    }
    let sve = operands.first().is_some_and(|first| first.starts_with('z'));
    // adr z0.d, [z1.d, z2.d]: 0000 0100 0x1 Zm 1010 00 Zn Zd, x for uxtw.
    if name == "adr" && sve && word & 0xffa0_fc00 == 0x0420_a000 {
        let last = operands.last_mut()?;
        if last.matches(',').count() == 1 && last.ends_with(']') {
            last.insert_str(last.len() - 1, if word & 1 << 22 == 0 { ", sxtw" } else { ", uxtw" });
        }
    }
    if name == "ext" && operands.len() == 4 && operands[1].starts_with('{') && operands[2].starts_with('z') {
        operands.remove(2);
    }
    if ["ld1rob", "ld1roh", "ld1row", "ld1rod"].contains(&name.as_str()) {
        let last = operands.last_mut()?;
        if let Some(at) = last.find(", #") {
            let (value, _) = number(last.get(at + 3..last.len() - 1)?)?;
            let bytes = value * 32;
            *last = format!("{}, #{}0x{:x}]", &last[..at], if bytes < 0 { "-" } else { "" }, bytes.abs());
        }
    }
    if name.starts_with("ldff1") || tile || ((name.starts_with("ldnt1") || name.starts_with("stnt1")) && operands.last().is_some_and(|last| last.starts_with("[z"))) {
        let last = operands.last_mut()?;
        if let Some(at) = last.find(", xzr") {
            let after = &last[at + 5..];
            if after == "]" || (after.starts_with(", lsl #") && after.ends_with(']')) {
                *last = format!("{}]", &last[..at]);
            }
        }
    }
    if name == "psel" && operands.len() == 3 {
        let last = &mut operands[2];
        if last.ends_with(']') && !last.contains(',') {
            last.insert_str(last.len() - 1, ", 0");
        } else {
            *last = last.replacen(", #", ", ", 1);
        }
    }
    if name == "mrs" || name == "msr" {
        let at = usize::from(name == "mrs");
        if let Some(known) = operands.get(at).and_then(|written| system_register(written, name == "mrs")) {
            operands[at] = known.to_string();
        }
    }
    (operands != before).then(|| format!("{written_name} {}", operands.join(", ")))
}

/// The name of the system register fARM64 wrote by its numbers
/// (s3_4_c1_c1_2, having no name for it), read or written: cptr_el2.
fn system_register(written: &str, read: bool) -> Option<&'static str> {
    let mut parts = written.split('_');
    let mut field = |prefix: &str, most: u16| parts.next()?.strip_prefix(prefix)?.parse::<u16>().ok().filter(|v| *v <= most);
    let (op0, op1, crn, crm, op2) = (field("s", 3)?, field("", 7)?, field("c", 15)?, field("c", 15)?, field("", 7)?);
    if op0 < 2 || parts.next().is_some() {
        return None;
    }
    let place = (op0 & 1) << 14 | op1 << 11 | crn << 7 | crm << 3 | op2;
    let way = if read { sysreg_names::READ } else { sysreg_names::WRITTEN };
    let from = sysreg_names::NAMES.partition_point(|(at, _, _)| *at < place);
    sysreg_names::NAMES[from..].iter().take_while(|(at, _, _)| *at == place).find(|(_, ways, _)| ways & way != 0).map(|(_, _, name)| *name)
}

// What the worker calls. To assemble: the line written where alloc() says,
// then assemble(), whose reply (at reply()) is a byte, 0 and the words, or
// 1 and why not. To disassemble: the bytes written where alloc() says,
// then disassemble(), whose reply is a line of text for each whole word
// (no more than max of them), a tab, and the address it names in hex if it
// names one; an empty line for a word that isn't an instruction.
thread_local! {
    static ASSEMBLER: Assembler = Assembler::new();
}

wasm_reply::exports!();

/// # Safety
/// `pointer` is from `alloc(len)`, with `len` bytes written; it's freed here.
#[no_mangle]
pub unsafe extern "C" fn assemble(address: u64, pointer: *mut u8, len: usize) -> usize {
    let bytes = wasm_reply::given(pointer, len);
    let text = String::from_utf8_lossy(&bytes);
    let mut reply = Vec::new();
    match ASSEMBLER.with(|a| a.assemble(&text, address)) {
        Ok(words) => {
            reply.push(0);
            for word in words {
                reply.extend_from_slice(&word.to_le_bytes());
            }
        }
        Err(why) => {
            reply.push(1);
            reply.extend_from_slice(why.as_bytes());
        }
    }
    wasm_reply::reply(reply)
}

/// # Safety
/// `pointer` is from `alloc(len)`, with `len` bytes written; it's freed here.
#[no_mangle]
pub unsafe extern "C" fn disassemble(address: u64, pointer: *mut u8, len: usize, max: usize) -> usize {
    let bytes = wasm_reply::given(pointer, len);
    let mut reply = Vec::new();
    for (n, word) in bytes.chunks_exact(4).take(max).enumerate() {
        let word = u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
        if let Some((text, target)) = shown(word, address.wrapping_add(4 * n as u64)) {
            reply.extend_from_slice(text.as_bytes());
            reply.push(b'\t');
            if let Some(target) = target {
                reply.extend_from_slice(format!("{target:x}").as_bytes());
            }
        }
        reply.push(b'\n');
    }
    wasm_reply::reply(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_as_typed() {
        let a = Assembler::new();
        for (text, address, want) in [
            ("nop", 0x1000u64, 0xd503201fu32), ("ret", 0x1000, 0xd65f03c0), ("mov x0, #1", 0x1000, 0xd2800020),
            ("mov x0, x1", 0x1000, 0xaa0103e0), ("add x0, x1, x2", 0x1000, 0x8b020020), ("add x0, x1, #0x10", 0x1000, 0x91004020),
            ("ADD X0, X1, #0x10, LSL #12", 0x1000, 0x91404020), ("sub sp, sp, #0x20", 0x1000, 0xd10083ff),
            ("ldr x0, [x1, #8]", 0x1000, 0xf9400420), ("str x0, [sp, #0x10]", 0x1000, 0xf9000be0),
            ("stp x29, x30, [sp, #-0x10]!", 0x1000, 0xa9bf7bfd), ("ldp fp, lr, [sp], #0x10", 0x1000, 0xa8c17bfd),
            ("ldr x0, [x1, x2, lsl #3]", 0x1000, 0xf8627820), ("add x0, sp, w1, uxtw #2", 0x1000, 0x8b214be0),
            ("b 0x1010", 0x1000, 0x14000004), ("bl #0x2000", 0x1000, 0x94000400), ("b.eq 0x1010", 0x1000, 0x54000080),
            ("cbz x0, 0x1010", 0x1000, 0xb4000080), ("tbz w0, #0, 0x1010", 0x1000, 0x36000080), ("cmp x0, #0", 0x1000, 0xf100001f),
            ("adrp x0, 0x11000", 0x1000, 0x90000080), ("adr x0, 0x1010", 0x1000, 0x10000080), ("svc #0", 0x1000, 0xd4000001),
            ("blr x8", 0x1000, 0xd63f0100), ("csel x0, x1, x2, eq", 0x1000, 0x9a820020), ("cset x0, eq", 0x1000, 0x9a9f17e0),
            ("lsl x0, x1, #2", 0x1000, 0xd37ef420), ("and w0, w1, #0xff", 0x1000, 0x12001c20), ("mul x0, x1, x2", 0x1000, 0x9b027c20),
            ("ldrb w0, [x1]", 0x1000, 0x39400020), ("mov w0, wzr", 0x1000, 0x2a1f03e0), ("movk x0, #1, lsl #16", 0x1000, 0xf2a00020),
            ("fmov d0, #1.0", 0x1000, 0x1e6e1000), ("sub sp, sp, #0x1000", 0x1000, 0xd14007ff), ("mov v0.16b, v1.16b", 0x1000, 0x4ea11c20), ("b 0xffc ; back", 0x1000, 0x17ffffff),
        ] {
            let words = a.assemble(text, address).unwrap_or_else(|why| panic!("{text}: {why}"));
            assert!(words.contains(&want), "{text}: {words:08x?} has no {want:08x}");
        }
    }

    #[test]
    fn lines_that_arent() {
        let a = Assembler::new();
        for text in ["", "foo x0", "add x0, x99, x2", "add x0, x1", "ldr x0, [x1, #8", "mov x0, x1, x2, x3, x4, x5", "b 0x1002", "add x0, x1, lsl"] {
            assert!(a.assemble(text, 0x1000).is_err(), "{text}");
        }
    }

    #[test]
    fn as_shown() {
        for (word, address, text, target) in [
            (0xd503201fu32, 0x1000u64, "nop", None), (0xd65f03c0, 0x1000, "ret", None), (0x14000004, 0x1000, "b 0x1010", Some(0x1010u64)),
            (0x17ffffff, 0x1000, "b 0xffc", Some(0xffc)), (0x14000002, 0, "b 0x8", Some(8)), (0x36000080, 0x1000, "tbz w0, #0, 0x1010", Some(0x1010)),
            (0x10000080, 0x1000, "adr x0, 0x1010", Some(0x1010)), (0x90000080, 0x1000, "adrp x0, 0x11000", Some(0x11000)),
            (0xd2800200, 0x1000, "mov x0, #0x10", None), (0x910023e2, 0x1000, "add x2, sp, #8", None), (0xf8627820, 0x1000, "ldr x0, [x1, x2, lsl #3]", None),
            (0xa9bf7bfd, 0x1000, "stp x29, x30, [sp, #-0x10]!", None), (0x381ff41f, 0x1000, "strb wzr, [x0], #-1", None),
            (0x58000080, 0x1000, "ldr x0, 0x1010", Some(0x1010)), (0x4e284800, 0x1000, "aese v0.16b, v0.16b", None),
            (0x04a00000, 0x1000, "add z0.s, z0.s, z0.s", None),
            // SME's tiles, as Arm writes them.
            (0x80dcd656, 0x1000, "fmops za6.d, p5/m, p6/m, z18.d, z28.d", None), (0xa1c0eda2, 0x1000, "usmopa za2.d, p3/m, p7/m, z13.h, z0.h", None),
            (0xe08848ad, 0x1000, "ld1w {za3h.s[w14, 1]}, p2/z, [x5, x8, lsl #2]", None), (0xe1e238c5, 0x1000, "st1q {za5h.q[w13, 0]}, p6, [x6, x2, lsl #4]", None),
            (0xe1d21eab, 0x1000, "ld1q {za11h.q[w12, 0]}, p7/z, [x21, x18, lsl #4]", None), (0xe034e807, 0x1000, "st1b {za0v.b[w15, 7]}, p2, [x0, x20]", None),
            (0xe069266e, 0x1000, "st1h {za1h.h[w13, 6]}, p1, [x19, x9, lsl #1]", None), (0xe0ddea0d, 0x1000, "ld1d {za6v.d[w15, 1]}, p2/z, [x16, x29, lsl #3]", None),
            (0xc0c00405, 0x1000, "mova za2h.d[w12, 1], p1/m, z0.d", None), (0xc0825448, 0x1000, "mova z8.s, p5/m, za0h.s[w14, 2]", None),
            (0xc0c350f0, 0x1000, "mova z16.q, p4/m, za7h.q[w14, 0]", None), (0xc0c1d2e5, 0x1000, "mova za5v.q[w14, 0], p4/m, z23.q", None),
            // SVE, where fARM64 writes otherwise than Arm does.
            (0x0420a000, 0x1000, "adr z0.d, [z0.d, z0.d, sxtw]", None), (0x0479a31a, 0x1000, "adr z26.d, [z24.d, z25.d, uxtw]", None),
            (0x0420a400, 0x1000, "adr z0.d, [z0.d, z0.d, sxtw #1]", None), (0x04e0a000, 0x1000, "adr z0.d, [z0.d, z0.d]", None),
            (0x04a0a800, 0x1000, "adr z0.s, [z0.s, z0.s, lsl #2]", None), (0x0568099a, 0x1000, "ext z26.b, {z12.b, z13.b}, #0x42", None),
            (0x05351518, 0x1000, "ext z24.b, z24.b, z8.b, #0xad", None), (0xa4273584, 0x1000, "ld1rob {z4.b}, p5/z, [x12, #0xe0]", None),
            (0xa4ad2420, 0x1000, "ld1roh {z0.h}, p1/z, [x1, #-0x60]", None), (0xa52c3362, 0x1000, "ld1row {z2.s}, p4/z, [x27, #-0x80]", None),
            (0xa5a0283f, 0x1000, "ld1rod {z31.d}, p2/z, [x1]", None), (0xa5ae0d71, 0x1000, "ld1rod {z17.d}, p3/z, [x11, x14, lsl #3]", None),
            (0xa58e38f9, 0x1000, "ld1rqd {z25.d}, p6/z, [x7, #-32]", None), (0x252a6c2f, 0x1000, "psel p15, p11, p1.h[w14, 0]", None),
            (0x256f6121, 0x1000, "psel p1, p8, p9.b[w15, 5]", None), (0x25bc446b, 0x1000, "psel p11, p1, p3.b[w12, 0xb]", None),
            // System registers: the ones fARM64 names, and the ones it doesn't;
            // one that's another when written; one that has no name.
            (0xd53bd040, 0x1000, "mrs x0, tpidr_el0", None), (0xd53c1146, 0x1000, "mrs x6, cptr_el2", None),
            (0xd51beba9,0x1000, "msr pmevcntr29_el0, x9", None), (0xd5301000, 0x1000, "mrs x0, mdrar_el1", None),
            (0xd5101080, 0x1000, "msr oslar_el1, x0", None), (0xd5301080, 0x1000, "mrs x0, s2_0_c1_c0_4", None),
            (0xd53f0000, 0x1000, "mrs x0, s3_7_c0_c0_0", None),
            // An address under ten is still one, in hex.
            (0x10000040, 0, "adr x0, 0x8", Some(8)), (0x58000040, 0, "ldr x0, 0x8", Some(8)),
        ] {
            assert_eq!(shown(word, address), Some((text.to_string(), target)), "{word:08x}");
        }
        assert_eq!(shown(0xffff_ffff, 0x1000), None);
    }
}
