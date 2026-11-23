// A shader's source read as a browser's compiler would report it, for
// gogl.js's reflection (Moli links programs without reflecting them): the
// preprocessor's conditionals and macros, then what's declared. No state of
// its own: gobrowser.go puts this file, gogl-enums.js and gogl.js in one
// function (goGLPageJS), so its names are the hook's, not the page's.

const glslTypes = {
    float: 0x1406, vec2: 0x8B50, vec3: 0x8B51, vec4: 0x8B52, int: 0x1404, ivec2: 0x8B53, ivec3: 0x8B54, ivec4: 0x8B55,
    bool: 0x8B56, bvec2: 0x8B57, bvec3: 0x8B58, bvec4: 0x8B59, mat2: 0x8B5A, mat3: 0x8B5B, mat4: 0x8B5C,
    uint: 0x1405, uvec2: 0x8DC6, uvec3: 0x8DC7, uvec4: 0x8DC8,
    mat2x2: 0x8B5A, mat3x3: 0x8B5B, mat4x4: 0x8B5C, mat2x3: 0x8B65, mat2x4: 0x8B66, mat3x2: 0x8B67, mat3x4: 0x8B68, mat4x2: 0x8B69, mat4x3: 0x8B6A,
    sampler2D: 0x8B5E, samplerCube: 0x8B60, sampler3D: 0x8B5F, sampler2DShadow: 0x8B62, sampler2DArray: 0x8DC1,
    sampler2DArrayShadow: 0x8DC4, samplerCubeShadow: 0x8DC5, isampler2D: 0x8DCA, isampler3D: 0x8DCB, isamplerCube: 0x8DCC,
    isampler2DArray: 0x8DCF, usampler2D: 0x8DD2, usampler3D: 0x8DD3, usamplerCube: 0x8DD4, usampler2DArray: 0x8DD7,
    samplerExternalOES: 0x8D66,
};
// glslValue evaluates a preprocessor expression (#if, an array's size):
// integers, defined(), macros, and C's operators. Unknown names are 0.
function glslValue(text, macros, depth = 0) {
    const tokens = String(text).match(/defined\s*\(\s*\w+\s*\)|defined\s+\w+|0[xX][0-9a-fA-F]+[uU]?|\d+(?:\.\d*)?(?:[eE][-+]?\d+)?[uUfF]?|\w+|&&|\|\||<<|>>|<=|>=|==|!=|[-+*/%<>()!~&|^?:]/g) || [];
    let at = 0;
    const peek = () => tokens[at];
    const primary = () => {
        const t = tokens[at++];
        if (t === undefined) return 0;
        if (t === "(") { const v = ternary(); if (peek() === ")") at++; return v; }
        if (t === "!") return primary() ? 0 : 1;
        if (t === "-") return -primary();
        if (t === "+") return +primary();
        if (t === "~") return ~primary();
        if (t.startsWith("defined")) return macros.has(t.replace(/^defined\s*\(?\s*|\s*\)$/g, "").trim()) ? 1 : 0;
        if (/^[0-9]/.test(t)) return Number.parseFloat(t.startsWith("0x") || t.startsWith("0X") ? Number.parseInt(t, 16) : t) || 0;
        if (macros.has(t) && depth < 8) return glslValue(macros.get(t), macros, depth + 1);
        return 0;
    };
    const levels = [["*", "/", "%"], ["+", "-"], ["<<", ">>"], ["<", ">", "<=", ">="], ["==", "!="], ["&"], ["^"], ["|"], ["&&"], ["||"]];
    const binary = (level) => {
        if (level < 0) return primary();
        let v = binary(level - 1);
        while (levels[level].includes(peek())) {
            const op = tokens[at++], w = binary(level - 1);
            switch (op) {
                case "*": v *= w; break; case "/": v = w ? Math.trunc(v / w) : 0; break; case "%": v = w ? v % w : 0; break;
                case "+": v += w; break; case "-": v -= w; break; case "<<": v <<= w; break; case ">>": v >>= w; break;
                case "<": v = +(v < w); break; case ">": v = +(v > w); break; case "<=": v = +(v <= w); break; case ">=": v = +(v >= w); break;
                case "==": v = +(v === w); break; case "!=": v = +(v !== w); break; case "&": v &= w; break; case "^": v ^= w; break;
                case "|": v |= w; break; case "&&": v = +(!!v && !!w); break; case "||": v = +(!!v || !!w); break;
            }
        }
        return v;
    };
    const ternary = () => {
        const c = binary(levels.length - 1);
        if (peek() !== "?") return c;
        at++;
        const a = ternary();
        if (peek() === ":") at++;
        const b = ternary();
        return c ? a : b;
    };
    try { return ternary(); } catch { return 0; }
}
// glslActive is a shader's source after its preprocessor: comments out,
// conditionals taken, object-like macros kept for array sizes.
function glslActive(source) {
    const text = String(source).slice(0, 1 << 20).replace(/\\\r?\n/g, "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
    const macros = new Map([["GL_ES", "1"], ["GL_FRAGMENT_PRECISION_HIGH", "1"]]);
    const out = [], stack = [];
    let on = true;
    for (const line of text.split("\n")) {
        const d = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
        if (!d) { if (on) out.push(line); continue; }
        const [, word, rest] = d;
        switch (word) {
            case "if": case "ifdef": case "ifndef": {
                const name = rest.trim().split(/\s/)[0];
                const v = word === "ifdef" ? macros.has(name) : word === "ifndef" ? !macros.has(name) : !!glslValue(rest, macros);
                stack.push({ outer: on, taken: on && v });
                on = on && v;
                break;
            }
            case "elif": {
                const top = stack.at(-1);
                if (!top) break;
                const v = top.outer && !top.taken && !!glslValue(rest, macros);
                if (v) top.taken = true;
                on = v;
                break;
            }
            case "else": { const top = stack.at(-1); if (top) { on = top.outer && !top.taken; top.taken = true; } break; }
            case "endif": { const top = stack.pop(); on = top ? top.outer : true; break; }
            case "define": if (on) { const m = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest); if (m && !m[2]) macros.set(m[1], m[3].trim() || "1"); else if (m) macros.set(m[1], "1"); } break;
            case "undef": if (on) macros.delete(rest.trim()); break;
        }
    }
    return { text: out.join("\n"), macros, es3: /^\s*#\s*version\s+300\s+es/m.test(text) };
}
// glslDeclared lists a shader's uniforms (expanded to the names a
// browser reports: arrays as name[0], structs field by field) and, for a
// vertex shader, its attributes.
function glslDeclared(source, vertex) {
    const { text, macros, es3 } = glslActive(source);
    const structs = new Map();
    const fields = (body) => {
        const list = [];
        for (const statement of body.split(";")) {
            const m = /^\s*(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\s\S]+)$/.exec(statement);
            if (!m) continue;
            for (const part of m[2].split(",")) {
                const n = /^\s*(\w+)\s*(?:\[([^\]]*)\])?\s*$/.exec(part);
                if (n) list.push({ type: m[1], name: n[1], size: n[2] === undefined ? 0 : Math.max(1, Math.min(4096, glslValue(n[2], macros) | 0)) });
            }
        }
        return list;
    };
    for (const m of text.matchAll(/\bstruct\s+(\w+)\s*\{([^{}]*)\}/g)) structs.set(m[1], fields(m[2]));
    let top = text;
    for (let i = 0; i < 16 && /\{[^{}]*\}/.test(top); i++) top = top.replace(/\{[^{}]*\}/g, " ; ");
    const uniforms = [], attributes = [];
    const expand = (type, name, size, depth = 0) => {
        if (uniforms.length >= 1024 || depth > 4) return;
        const struct = structs.get(type);
        if (!struct) {
            if (glslTypes[type] !== undefined) uniforms.push({ name: size ? `${name}[0]` : name, type: glslTypes[type], size: size || 1 });
            return;
        }
        for (let i = 0; i < (size || 1); i++) {
            for (const f of struct) expand(f.type, `${size ? `${name}[${i}]` : name}.${f.name}`, f.size, depth + 1);
        }
    };
    for (const statement of top.split(";")) {
        const m = /^\s*(?:layout\s*\(([^)]*)\)\s*)?(?:(?:flat|smooth|centroid|invariant|highp|mediump|lowp)\s+)*(uniform|attribute|in)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\s\S]+)$/.exec(statement);
        if (!m) continue;
        const [, layout, storage, type, names] = m;
        const at = /\blocation\s*=\s*(\d+)/.exec(layout ?? "");
        // A vertex shader's inputs: "attribute", or (GLSL ES 3) "in", which
        // three.js also writes as "attribute" with #define attribute in.
        if (storage !== "uniform" && (!vertex || (storage === "in" && !es3))) continue;
        for (const part of names.split(",")) {
            const n = /^\s*(\w+)\s*(?:\[([^\]]*)\])?\s*$/.exec(part);
            if (!n) continue;
            const size = n[2] === undefined ? 0 : Math.max(1, Math.min(4096, glslValue(n[2], macros) | 0));
            if (storage === "uniform") expand(type, n[1], size);
            else if (glslTypes[type] !== undefined && attributes.length < 64) attributes.push({ name: n[1], type: glslTypes[type], size: size || 1, layout: at ? Number(at[1]) : -1 });
        }
    }
    return { uniforms, attributes };
}
