// CSS Tree parses untrusted CSS without involving the browser's network/CSSOM.
// Only generated, scoped rules with brokered URLs enter the live document.
"use strict";
(() => {
    const properties = new Set(("color background background-color background-image background-size background-repeat background-position " +
        "font-family font-size font-style font-weight font-variant font-stretch line-height letter-spacing word-spacing " +
        "text-align text-decoration text-indent text-transform vertical-align white-space word-break overflow-wrap " +
        "width max-width min-width height max-height min-height margin margin-top margin-right margin-bottom margin-left " +
        "padding padding-top padding-right padding-bottom padding-left border border-width border-style border-color border-collapse " +
        "border-top border-right border-bottom border-left border-spacing border-radius table-layout list-style-type list-style-image " +
        "display flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content justify-content gap row-gap column-gap " +
        "grid-template-columns grid-template-rows grid-column grid-row grid-auto-flow object-fit object-position overflow overflow-x overflow-y " +
        "float clear box-sizing opacity visibility").split(" "));
    const fontProperties = new Set("font-family src font-style font-weight font-stretch unicode-range font-display font-feature-settings font-variation-settings".split(" "));
    const functions = new Set("rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max clamp minmax repeat fit-content linear-gradient repeating-linear-gradient radial-gradient repeating-radial-gradient conic-gradient format tech local var".split(" "));
    function cssProcessor({ load, external, error, alive = () => true }) {
        let nodes = 0, bytes = 0, sheets = 0;
        const css = globalThis.csstree;
        async function value(declaration, base, font) {
            const property = declaration.property.startsWith("--") ? declaration.property : declaration.property.toLowerCase();
            if (!(font ? fontProperties.has(property) : properties.has(property) || /^--[a-z0-9_-]{1,100}$/i.test(property)) || declaration.value.type === "Raw") return "";
            const urls = [];
            let valid = true;
            css.walk(declaration.value, node => {
                if (++nodes > 50000) throw new Error("CSS complexity limit reached.");
                if (node.type === "Raw" || node.type === "Function" && !functions.has(node.name.toLowerCase())) valid = false;
                if (node.type === "Url") urls.push(node);
            });
            if (!valid) return "";
            for (const node of urls) {
                external(node.value, base);
                try { node.value = await load(node.value, base, font && property === "src" ? "font" : "image"); }
                catch (err) { error(err.message); return ""; }
            }
            return `${property}:${css.generate(declaration.value)}${declaration.important ? "!important" : ""};`;
        }
        async function declarations(block, base, font = false) {
            let out = "";
            for (const declaration of block.children) {
                if (!alive()) return "";
                if (declaration.type === "Declaration") out += await value(declaration, base, font);
            }
            return out;
        }
        function selector(prelude) {
            if (prelude?.type !== "SelectorList") return "";
            return [...prelude.children].map(node => {
                let text = css.generate(node);
                // Every selector is scoped to content, including selectors
                // with sibling combinators or a source-defined #doc ID.
                if (/^(?:html|body|:root)(?=$|\s|>)/.test(text)) {
                    text = text.replace(/^(?:(?:html|body|:root)(?:\s*>?\s*|$))+/, "").trim();
                    if (/^[+~|]/.test(text)) return "";
                    return `:where(#doc)${text ? " " + text : ""}`;
                }
                return `:where(#doc) ${text}`;
            }).filter(Boolean).join(",");
        }
        function importConditions(prelude) {
            const parts = [...prelude.children].slice(1);
            let layer = null, supports = "", media = "", at = 0;
            const first = parts[at];
            if (first?.type === "Identifier" && first.name.toLowerCase() === "layer") { layer = ""; at++; }
            else if (first?.type === "Function" && first.name.toLowerCase() === "layer") {
                if (first.children.size !== 1 || first.children.first.type !== "Layer") return null;
                layer = css.generate(first.children.first); at++;
            }
            const condition = parts[at];
            if (condition?.type === "Function" && condition.name.toLowerCase() === "supports") {
                if (condition.children.size !== 1) return null;
                const node = condition.children.first;
                if (node.type === "Declaration") supports = `(${css.generate(node)})`;
                else if (node.type === "Condition" && node.kind === "supports") supports = css.generate(node);
                else return null;
                at++;
            }
            if (parts[at]?.type === "MediaQueryList") { media = css.generate(parts[at]); at++; }
            return at === parts.length ? { layer, supports, media } : null;
        }
        function wrapImport(text, { layer, supports, media }) {
            if (media) text = `@media ${media}{${text}}`;
            if (supports) text = `@supports ${supports}{${text}}`;
            if (layer !== null) text = `@layer${layer ? " " + layer : ""}{${text}}`;
            return text;
        }
        async function rules(children, base, chain, depth) {
            let out = "";
            for (const rule of children) {
                if (!alive()) return "";
                if (++nodes > 50000 || depth > 8) throw new Error("CSS nesting limit reached.");
                if (rule.type === "Rule") {
                    const scoped = selector(rule.prelude);
                    const body = await declarations(rule.block, base);
                    if (scoped && body) out += `${scoped}{${body}}`;
                } else if (rule.type === "Atrule") {
                    const name = rule.name.toLowerCase();
                    if (name === "import") {
                        if (!rule.prelude || rule.block) continue;
                        let safe = true;
                        css.walk(rule.prelude, node => { if (node.type === "Raw") safe = false; });
                        if (!safe) continue;
                        const tail = [...rule.prelude.children].slice(1).map(n => css.generate(n)).join(" ").trim();
                        const first = rule.prelude?.children?.first;
                        if (!["Url", "String"].includes(first?.type)) continue;
                        const conditions = importConditions(rule.prelude);
                        if (!conditions) continue;
                        const src = first.value;
                        external(src, base);
                        try {
                            const got = await load(src, base, "css", true);
                            if (got.direct) {
                                out += `@import ${css.generate({ type: "Url", value: got.base })}${tail ? " " + tail : ""};`;
                                continue;
                            }
                            if (chain.includes(got.base)) continue;
                            const imported = await stylesheet(got.text, got.base, [...chain, got.base], depth + 1, true);
                            out += wrapImport(imported, conditions);
                        } catch (err) { error(err.message); }
                    } else if (name === "layer" && !rule.block && rule.prelude?.children?.size === 1 && rule.prelude.children.first.type === "LayerList") {
                        out += `@layer ${css.generate(rule.prelude)};`;
                    } else if (name === "font-face" && rule.block) {
                        const body = await declarations(rule.block, base, true);
                        if (body) out += `@font-face{${body}}`;
                    } else if (["media", "supports", "layer"].includes(name) && rule.block) {
                        const prelude = rule.prelude ? css.generate(rule.prelude) : "";
                        // Never preserve opaque fallback text from parser recovery.
                        let valid = true;
                        if (rule.prelude) css.walk(rule.prelude, node => { if (node.type === "Raw" || node.type === "Url") valid = false; });
                        if (valid) out += `@${name} ${prelude}{${await rules(rule.block.children, base, chain, depth + 1)}}`;
                    }
                }
                if (out.length > 2 * 1024 * 1024) throw new Error("Generated stylesheet exceeds the preview limit.");
            }
            return out;
        }
        function charge(text) {
            bytes += text.length;
            if (bytes > 2 * 1024 * 1024 || text.length > 512 * 1024) throw new Error("Stylesheet preview limit reached.");
        }
        async function stylesheet(text, base = "", chain = [], depth = 0, fetched = false) {
            charge(text);
            if (fetched && ++sheets > 16) throw new Error("Stylesheet import limit reached.");
            if (!text.trim()) return "";
            const ast = css.parse(text, { positions: false, parseCustomProperty: true });
            return rules(ast.children, base, chain, depth);
        }
        return {
            stylesheet,
            async inline(text, base = "") {
                if (text.length > 8192) return "";
                charge(text);
                const ast = css.parse(text, { context: "declarationList", positions: false, parseCustomProperty: true });
                return declarations(ast, base);
            },
        };
    }
    globalThis.TabTopCSS = { cssProcessor };
})();
