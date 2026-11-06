// Compile the pinned official format library once, outside the runtime image.
// Usage: node build.mjs <extracted format library> <output directory>
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import compiler from "kaitai-struct-compiler";
import YAML from "yaml";
import { build } from "esbuild";
import { instrumentParser } from "./instrument.mjs";
import sources from "./sources.json" with { type: "json" };

const [sourceDir, outputDir] = process.argv.slice(2);
if (!sourceDir || !outputDir) throw new Error("usage: node build.mjs <format library> <output directory>");
const out = path.resolve(outputDir);
const work = await fs.mkdtemp(path.join(os.tmpdir(), "tabtop-kaitai-"));
const camel = s => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = s => { const c = camel(s); return c[0].toUpperCase() + c.slice(1); };
try {
    await fs.mkdir(out, { recursive: true });
    const schemas = new Map();
    for (const name of (await fs.readdir(sourceDir, { recursive: true })).filter(n => n.endsWith(".ksy")).sort()) {
        const text = await fs.readFile(path.join(sourceDir, name), "utf8");
        const schema = YAML.parse(text.replace(/^(\s*0x[\da-f_]+)(?=:)/gmi, key => key.replaceAll("_", "")));
        schemas.set(schema.meta.id, { name, text, schema });
    }
    const importer = { importYaml: async name => {
        const id = path.basename(name);
        if (!schemas.has(id)) throw new Error(`Missing import ${name}`);
        return schemas.get(id).schema;
    } };
    const entries = {};
    const formats = [];
    const failures = [];
    for (const [id, { name, schema }] of schemas) {
        try {
            const files = await compiler.compile("javascript", schema, importer, true);
            for (const [filename, code] of Object.entries(files)) await fs.writeFile(path.join(work, filename), instrumentParser(code));
            const className = pascal(id);
            const entry = path.join(work, `entry-${id}.mjs`);
            await fs.writeFile(entry, `export { ${className} as Parser } from './${className}.js';\nexport { KaitaiStream } from ${JSON.stringify(path.join(import.meta.dirname, 'runtime.mjs'))};\n`);
            entries[id] = entry;
            formats.push({ id, title: schema.meta.title ?? id, category: name.split("/")[0],
                extensions: [].concat(schema.meta["file-extension"] ?? []),
                params: schema.params ?? [], license: schema.meta.license ?? "See schema", schema: name });
        } catch (err) { failures.push({ id, error: String(err) }); }
    }
    if (failures.length) throw new Error(`Cannot compile ${failures.length} formats:\n${JSON.stringify(failures, null, 2)}`);
    // Metadata preserves enum names/docs and the schema's field order, including lazy instances.
    const metadata = {};
    const describe = (id, s) => ({ id, doc: s.doc ?? "", endian: s.meta?.endian ?? null,
        bitEndian: s.meta?.["bit-endian"] ?? null, encoding: s.meta?.encoding ?? null, fields: Object.fromEntries((s.seq ?? []).map(f => [camel(f.id ?? ""), f])),
        instances: Object.fromEntries(Object.entries(s.instances ?? {}).map(([k,v]) => [camel(k),v])),
        enums: s.enums ?? {}, types: Object.fromEntries(Object.entries(s.types ?? {}).map(([k,v]) => [k, describe(`${id}::${k}`,v)])) });
    for (const [id, { schema }] of schemas) metadata[id] = describe(id, schema);
    await fs.writeFile(path.join(out, "schemas.json"), JSON.stringify(metadata));
    const result = await build({ entryPoints: entries, outdir: path.join(out, "parsers"), bundle: true,
        splitting: true, format: "esm", platform: "browser", target: "es2022", minify: true, keepNames: true,
        entryNames: "[name]-[hash]", chunkNames: "chunk-[hash]", metafile: true,
        nodePaths: [path.resolve(import.meta.dirname, "node_modules")], external: ["zlib", "iconv-lite"] });
    for (const [filename, info] of Object.entries(result.metafile.outputs)) {
        if (!info.entryPoint) continue;
        const id = path.basename(info.entryPoint).slice(6, -4);
        formats.find(f => f.id === id).module = path.relative(out, filename).replaceAll(path.sep, "/");
    }
    formats.sort((a,b) => a.title.localeCompare(b.title));
    await fs.writeFile(path.join(out, "formats.json"), JSON.stringify({ version: compiler.version, source: sources.commit, formats }));
    await fs.cp(sourceDir, path.join(out, "sources"), { recursive: true, filter: n => !n.includes("/.git") });
    for (const [pkg, license] of [["kaitai-struct", "LICENSE"], ["pako", "LICENSE"]]) {
        await fs.copyFile(path.join(import.meta.dirname, "node_modules", pkg, license), path.join(out, `LICENSE.${pkg}`));
    }
    console.log(`Compiled ${formats.length} Kaitai formats into ${out}`);
} finally { await fs.rm(work, { recursive: true, force: true }); }
