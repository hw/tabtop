// Generate the JS reader's offsets with the same WASM ABI as Capstone.
// Upstream's wrapper has fixed offsets from an older header layout.
#include <stddef.h>
#include <stdio.h>
#include <capstone/capstone.h>

#define FIELD(type, member) printf("\"" #member "\":%zu,", offsetof(type, member))
#define ARCH(name, structure, operand) \
    printf("\"" name "\":{"); \
    FIELD(structure, op_count); FIELD(structure, operands); \
    FIELD(operand, type); FIELD(operand, imm); \
    printf("\"stride\":%zu}", sizeof(operand))

int main(void) {
    printf("const capstoneLayout = {\"instruction\":{");
    FIELD(cs_insn, id); FIELD(cs_insn, address); FIELD(cs_insn, size);
    FIELD(cs_insn, mnemonic); FIELD(cs_insn, op_str); FIELD(cs_insn, detail);
    printf("\"stride\":%zu},\"detail\":{", sizeof(cs_insn));
    FIELD(cs_detail, groups); FIELD(cs_detail, groups_count);
    printf("\"arch\":%zu},", offsetof(cs_detail, arm));
    ARCH("arm", cs_arm, cs_arm_op); printf(",");
    ARCH("arm64", cs_arm64, cs_arm64_op); printf(",");
    ARCH("mips", cs_mips, cs_mips_op);
    printf("};\n");
    return 0;
}
