import { parse } from "acorn";

// Instrument the generated AST before minification. Checks run before allocations,
// in every repeat loop, and on entry to constructors, readers and lazy getters.
// Fail the build if a compiler update introduces an unhandled allocation shape.
export function instrumentParser(source) {
    const ast = parse(source, { ecmaVersion: "latest" });
    const inserts = new Map();
    const add = (at, text) => inserts.set(at, (inserts.get(at) ?? "") + text);
    const budget = "KaitaiStream._previewBudget";
    const wrap = (node, call) => { add(node.start, `(${budget}.${call},`); add(node.end, ")"); };
    const walk = (node, parent, scoped = false) => {
        const fn = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);
        const runtime = fn && (scoped || node.params[0]?.name === "_io" ||
            parent?.type === "AssignmentExpression" && parent.left?.property?.name === "_read" ||
            parent?.type === "Property" && parent.key?.name === "get");
        const inside = scoped || runtime;
        if (runtime) {
            if (node.body.type !== "BlockStatement") throw new Error("Unhandled generated expression function");
            add(node.body.start + 1, `${budget}.enter();try{`);
            add(node.body.end - 1, `}finally{${budget}.leave();}`);
        }
        if (inside && ["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"].includes(node.type)) {
            if (node.body.type !== "BlockStatement") throw new Error("Unhandled generated repeat loop");
            add(node.body.start + 1, `${budget}.step();`);
        }
        if (inside && ["ObjectExpression", "ArrayExpression", "NewExpression"].includes(node.type)) {
            if (node.type === "NewExpression") {
                const name = node.callee.name;
                if (name === "Array" || name === "ArrayBuffer" || /^(?:Uint|Int|Float|BigInt|BigUint)\d+(?:Clamped)?Array$/.test(name ?? "")) {
                    if (node.arguments[0]?.type !== "ArrayExpression") throw new Error(`Unhandled generated buffer allocation: ${name}`);
                }
            }
            wrap(node, "node()");
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "start" || key === "end") continue;
            if (Array.isArray(value)) { for (const child of value) if (child?.type) walk(child, node, inside); }
            else if (value?.type) walk(value, node, inside);
        }
    };
    walk(ast, null);
    let result = "", offset = 0;
    for (const [at, text] of [...inserts].sort((a,b) => a[0] - b[0])) {
        result += source.slice(offset, at) + text; offset = at;
    }
    return result + source.slice(offset);
}
