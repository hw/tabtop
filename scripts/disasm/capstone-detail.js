// Appended to Capstone.js's wrapper at build time, after capstone-layout.c's
// generated offsets. Read just the instruction and operand data our worker
// needs, using the pinned headers' layout instead of upstream's old offsets.
Module.Instruction = function(pointer, arch) {
    const layout = capstoneLayout.instruction;
    this.id = Module.getValue(pointer + layout.id, "i32");
    this.address = Module.getValue(pointer + layout.address, "i64");
    this.size = Module.getValue(pointer + layout.size, "i16");
    this.mnemonic = Module.UTF8ToString(pointer + layout.mnemonic);
    this.op_str = Module.UTF8ToString(pointer + layout.op_str);
    this.detail = { groups: [], op: [] };
    const detail = Module.getValue(pointer + layout.detail, "*");
    // Skip-data rows have no instruction detail.
    if (!this.id || !detail) return;
    const common = capstoneLayout.detail;
    const groups = Module.getValue(detail + common.groups_count, "i8");
    for (let i = 0; i < groups; i++) this.detail.groups.push(Module.getValue(detail + common.groups + i, "i8"));
    const a = arch === Module.ARCH_ARM ? capstoneLayout.arm : arch === Module.ARCH_ARM64 ? capstoneLayout.arm64 : capstoneLayout.mips;
    const base = detail + common.arch, count = Module.getValue(base + a.op_count, "i8");
    for (let i = 0; i < count; i++) {
        const at = base + a.operands + i * a.stride, type = Module.getValue(at + a.type, "i32");
        const op = { type };
        if (type === Module.OP_IMM) op.imm = Module.getValue(at + a.imm, arch === Module.ARCH_ARM ? "i32" : "i64");
        this.detail.op.push(op);
    }
};
