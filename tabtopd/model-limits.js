// How much a Collada or VRML file makes, counted before three.js's loaders
// read it: each copies a shared part every time it's used (Collada's
// <instance_node>, VRML's USE), so a file of a few kilobytes, each level
// using the one below twice, makes millions, and freezes or crashes the
// page. Counted from the text, each use in full: {nodes, shapes}. A scan
// of each, linear (no pattern that goes back over what it read).

// Collada (and a KMZ's): read on the page, so less of it.
export const MAX_COLLADA = { nodes: 100_000, shapes: 10_000 };
// VRML: read in the model worker.
export const MAX_VRML_MADE = { nodes: 500_000, shapes: 50_000 };

const add = (a, b) => ({ nodes: Math.min(a.nodes + b.nodes, 1e15), shapes: Math.min(a.shapes + b.shapes, 1e15) });
const over = (made, max) => made.nodes > max.nodes || made.shapes > max.shapes;
const tooMany = (made) => new Error(`it makes too many parts to show here (${made.shapes > 1e9 ? "billions of" : Math.round(made.shapes).toLocaleString("en")} shapes, ${made.nodes > 1e9 ? "billions of" : Math.round(made.nodes).toLocaleString("en")} nodes, once each shared part is counted where it's used)`);

// colladaMade is what a Collada document's scenes make: its nodes, and
// the geometries (and controllers) they place. A node used by
// <instance_node> is counted each time; one that uses itself, at any
// remove, is refused.
export function colladaMade(text) {
    // Each node's own count, the nodes in it, and those it uses, by id.
    const nodes = [], byId = new Map(), roots = [];
    const stack = [];
    let inScene = 0;
    const tag = /<\s*(\/?)([\w:.-]+)((?:[^\w:.<>-][^<>]*)?)>/g;
    const attr = (rest, name) => {
        const m = new RegExp(`(?<![\\w:.-])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(rest);
        return m ? m[2] ?? m[3] : null;
    };
    for (let m; (m = tag.exec(text));) {
        const [, closing, raw, rest] = m;
        const name = raw.slice(raw.lastIndexOf(":") + 1);
        const selfClosing = /\/\s*$/.test(rest);
        if (name === "visual_scene") { if (closing) inScene--; else if (!selfClosing) inScene++; continue; }
        if (name === "node") {
            if (closing) { stack.pop(); continue; }
            const node = { own: { nodes: 1, shapes: 0 }, children: [], uses: [] };
            nodes.push(node);
            const id = attr(rest, "id");
            if (id !== null && !byId.has(id)) byId.set(id, node);
            if (stack.length) stack.at(-1).children.push(node);
            else if (inScene > 0) roots.push(node);
            if (!selfClosing) stack.push(node);
            continue;
        }
        if (closing || !stack.length) continue;
        if (name === "instance_node") stack.at(-1).uses.push((attr(rest, "url") ?? "").replace(/^#/, ""));
        else if (name === "instance_geometry" || name === "instance_controller") stack.at(-1).own.shapes++;
    }
    // Each node's whole count, worked out once (depth first, without
    // recursion: a file nested deep doesn't overflow the stack).
    const made = new Map(), working = new Set();
    const total = (start) => {
        const todo = [[start, false]];
        while (todo.length) {
            const [node, expanded] = todo.pop();
            if (made.has(node)) continue;
            const deps = [...node.children, ...node.uses.map((id) => byId.get(id)).filter(Boolean)];
            if (!expanded) {
                if (working.has(node)) throw new Error("it uses a part inside itself");
                working.add(node);
                todo.push([node, true]);
                for (const d of deps) if (!made.has(d)) {
                    if (working.has(d)) throw new Error("it uses a part inside itself");
                    todo.push([d, false]);
                }
                continue;
            }
            working.delete(node);
            made.set(node, deps.reduce((sum, d) => add(sum, made.get(d)), node.own));
        }
        return made.get(start);
    };
    return roots.reduce((sum, r) => add(sum, total(r)), { nodes: 0, shapes: 0 });
}

// checkCollada throws if a Collada document makes more than max.
export function checkCollada(text, max = MAX_COLLADA) {
    const made = colladaMade(text);
    if (over(made, max)) throw tooMany(made);
    return made;
}

// vrmlMade is what a VRML (97) file makes: each node (each "{ … }" that
// a type name opens), its Shapes, and what each USE uses, counted again.
// Comments and strings are passed over.
export function vrmlMade(text, max = MAX_VRML_MADE) {
    const defs = new Map();
    const stack = [{ made: { nodes: 0, shapes: 0 }, def: null }];
    let def = null, type = null;
    // (A string not closed runs to the end, once: none is gone over twice.)
    const token = /#[^\n]*|"(?:[^"\\]|\\.)*"?|[{}]|[^\s{}[\],"#]+/g;
    let previous = "";
    for (let m; (m = token.exec(text));) {
        const t = m[0];
        if (t[0] === "#" || t[0] === "\"") { previous = ""; continue; }
        if (t === "{") {
            stack.push({ made: { nodes: 1, shapes: type === "Shape" ? 1 : 0 }, def });
            def = type = null;
        } else if (t === "}") {
            if (stack.length < 2) continue;
            const node = stack.pop();
            if (node.def !== null) defs.set(node.def, node.made);
            stack.at(-1).made = add(stack.at(-1).made, node.made);
        } else if (previous === "DEF") {
            def = t;
        } else if (previous === "USE") {
            stack.at(-1).made = add(stack.at(-1).made, defs.get(t) ?? { nodes: 1, shapes: 0 });
        } else {
            type = t;
        }
        if (over(stack.at(-1).made, max)) throw tooMany(stack.at(-1).made);
        previous = t;
    }
    let made = { nodes: 0, shapes: 0 };
    for (const f of stack) made = add(made, f.made);
    if (over(made, max)) throw tooMany(made);
    return made;
}
