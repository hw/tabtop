// The offline client's components page (tabtop.html?page=components; it's
// only in the offline client: see file-launcher.mjs): the viewers it
// fetches through the tunnel when they're first needed, which this
// gateway offers, what of each is kept in this browser, and buttons to
// fetch (and keep) or forget each, or all. Each file is checked against
// the SHA-256 the gateway wrote into tabtop.html when it sealed the pack,
// as kept and as fetched.
import { nameTab, navBar } from "../tabtop/nav.js";
import { el } from "../tabtop/preview-dom.js";
import { humanBytes } from "../tabtop/file-format.js";
import { setLoginTitle } from "../tabtop/requests.js";

const offline = globalThis.tabtopOffline?.components;

// The components, by the files of each (a file may be two's: RISC-V's and
// MIPS's share asm-common.js); the disassemblers by the names the gateway
// turns them off by.
const GROUPS = [
    { id: "highlight", name: "Syntax colouring", what: "Colours code in text previews and in rendered Markdown (highlight.js).", match: /^tabtop\/highlight\// },
    { id: "pdfjs", name: "PDF viewer", what: "Shows PDFs (pdf.js, with its fonts and character maps).", match: /^tabtop\/pdfjs\// },
    { id: "preview", name: "Maths and diagrams", what: "Draws the maths (KaTeX) and diagrams (Mermaid) in rendered Markdown.", match: /^tabtop\/preview\// },
    { id: "x86", name: "x86 disassembler", what: "Disassembles and edits x86 code in the hex view (iced-x86).", match: /^tabtop\/(disasm\/iced|x86-asm\.js$)/ },
    { id: "capstone", name: "ARM and Thumb disassembler", what: "Disassembles 32-bit ARM and Thumb code in the hex view (Capstone).", match: /^tabtop\/disasm\/capstone/ },
    { id: "arm64", name: "ARM64 disassembler", what: "Disassembles and edits ARM64 code in the hex view.", match: /^tabtop\/disasm\/arm64-asm/ },
    { id: "riscv", name: "RISC-V disassembler", what: "Disassembles and edits RISC-V code in the hex view.", match: /^tabtop\/(asm-common|riscv-asm)\.js$/ },
    { id: "mips", name: "MIPS disassembler", what: "Disassembles and edits MIPS code in the hex view.", match: /^tabtop\/(asm-common|mips-asm)\.js$/ },
    { id: "demangle", name: "Symbol demangler", what: "Shows the C++ and Rust symbol names in programs as they were written.", match: /^tabtop\/demangle\// },
    { id: "kaitai", name: "Kaitai formats", what: "Decodes about 190 binary formats field by field in the hex view.", match: /^tabtop\/kaitai\// },
    { id: "three", name: "3D viewer", what: "Shows 3D models and G-code (three.js, with the Draco, meshopt and Basis decoders).", match: /^tabtop\/three\// },
    // The AI image tools: each its model, and ONNX Runtime, which all three share.
    { id: "background", name: "Background removal", what: "Removes a picture's background (U2NetP, on ONNX Runtime).", match: /^tabtop\/background\// },
    { id: "segment", name: "Magic select", what: "Selects an object in a picture by a click or box (MobileSAM, on ONNX Runtime).", match: /^tabtop\/(segment\/|background\/(ort|LICENSE\.onnx|ThirdParty))/ },
    { id: "inpaint", name: "Inpainting", what: "Fills in what's painted over in a picture (MI-GAN, on ONNX Runtime).", match: /^tabtop\/(inpaint\/|background\/(ort|LICENSE\.onnx|ThirdParty))/ },
];
// What the offline client hasn't, and can't fetch (none, now).
const ABSENT = [];
// How many files are fetched at once.
const AT_ONCE = 4;

nameTab("components");
setLoginTitle("Offline components");
document.title = "Offline components";
const page = document.body;
const status = el("p", { className: "hint" });
status.setAttribute("role", "status");
let busy = false;

const button = (text, onClick, disabled = false) => {
    const b = el("button", { type: "button", textContent: text, disabled });
    b.addEventListener("click", onClick);
    return b;
};
const say = (text, error = false) => {
    status.textContent = text;
    status.className = error ? "error" : "hint";
};

// fetchAll fetches (and keeps) the files at paths, AT_ONCE at a time,
// saying how far it's got; it throws the first failure, after the rest.
async function fetchAll(paths, label) {
    let done = 0, failed = null;
    const queue = [...paths];
    say(`${label}: 0 of ${paths.length} files…`);
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
        while (queue.length) {
            const path = queue.shift();
            try {
                await offline.fetch(path);
            } catch (e) {
                failed ??= e;
            }
            say(`${label}: ${++done} of ${paths.length} files…`);
        }
    }));
    if (failed) throw failed;
}

// act runs one action (a download or removal) at a time, then draws the
// page again, saying how it went.
async function act(run, done) {
    if (busy) return;
    busy = true;
    for (const b of page.querySelectorAll("main button")) b.disabled = true;
    try {
        await run();
        await draw();
        say(done);
    } catch (e) {
        await draw();
        say(String(e?.message || e), true);
    } finally {
        busy = false;
    }
}

async function draw() {
    const files = offline?.files();
    const main = el("main", { className: "components" });
    if (!files) {
        main.append(el("h1", { className: "crumbs", textContent: "Offline components" }),
            el("p", { textContent: "This copy of the offline client has no list of components to fetch, so it fetches none. " +
                "Unlock a pack from your gateway's /auth/pack, which has the list in it, to use them." }));
        page.replaceChildren(navBar("components"), main);
        return;
    }
    const { state, unlisted } = await offline.check();
    const off = offline.disasmOff();
    const total = (list) => list.reduce((n, f) => n + f.size, 0);
    const rows = GROUPS.map((g) => {
        const mine = files.filter((f) => g.match.test(f.path));
        const kept = mine.filter((f) => state[f.path] === "kept"), damaged = mine.filter((f) => state[f.path] === "damaged");
        const missing = mine.filter((f) => state[f.path] !== "kept");
        // Forgetting one forgets its own files, not one another kept one
        // has too (asm-common.js, while the other's kept).
        const others = GROUPS.filter((o) => o !== g && files.some((f) => o.match.test(f.path)) &&
            files.filter((f) => o.match.test(f.path)).every((f) => state[f.path] === "kept"));
        // (A damaged one too: removed, not left to be fetched again.)
        const own = [...kept, ...damaged].filter((f) => !others.some((o) => o.match.test(f.path)));
        let shown, cls = "";
        if (!mine.length) shown = off.includes(g.id) ? "Turned off on this server" : "Not on this server";
        else if (!missing.length) shown = "Downloaded";
        else if (damaged.length) { shown = `${damaged.length} damaged: download again`; cls = "error"; }
        else if (kept.length) shown = `${kept.length} of ${mine.length} files`;
        else shown = "Not downloaded";
        return el("tr", {},
            el("td", {}, el("strong", { textContent: g.name }), el("br"), el("small", { className: "hint", textContent: g.what })),
            el("td", { className: "num", textContent: mine.length ? humanBytes(total(mine)) : "" }),
            el("td", { className: cls, textContent: shown }),
            el("td", { className: "act" },
                ...(missing.length ? [button(kept.length ? "Download the rest" : "Download",
                    () => act(() => fetchAll(missing.map((f) => f.path), g.name), `${g.name}: downloaded.`))] : []),
                ...(own.length ? [button("Remove", () => act(async () => {
                    for (const f of own) await offline.forget(f.sha256);
                }, `${g.name}: removed from this browser.`))] : [])));
    });
    const keptAll = files.filter((f) => state[f.path] === "kept");
    const storedAll = files.filter((f) => state[f.path] === "kept" || state[f.path] === "damaged");
    const missingAll = files.filter((f) => state[f.path] !== "kept");
    main.append(
        el("h1", { className: "crumbs", textContent: "Offline components" }),
        el("p", { textContent: "Viewers the offline client doesn't carry, fetched through the encrypted tunnel the first time they're needed, " +
            "or here beforehand, and kept in this browser. Each file is checked against the SHA-256 the gateway wrote into tabtop.html " +
            "when it sealed the pack, when it's fetched and each time it's used: one that doesn't match isn't run." }),
        el("p", { className: "components-summary" }, `Kept in this browser: ${humanBytes(total(keptAll))} of ${humanBytes(total(files))}. `,
            ...(missingAll.length ? [button("Download all", () => act(() => fetchAll(missingAll.map((f) => f.path), "All components"), "All components downloaded."))] : []), " ",
            ...(storedAll.length ? [button("Remove all", () => act(async () => {
                for (const f of storedAll) await offline.forget(f.sha256);
            }, "All components removed from this browser."))] : [])),
        status,
        el("table", { className: "file-table components-table" },
            el("thead", {}, el("tr", {}, el("th", { textContent: "Component" }), el("th", { className: "num", textContent: "Size" }),
                el("th", { textContent: "In this browser" }), el("th"))),
            el("tbody", {}, ...rows)),
        ...(unlisted.length ? [el("p", {}, `Kept from an older pack, and no longer used: ${unlisted.length} ${unlisted.length === 1 ? "file" : "files"}, ${humanBytes(total(unlisted))}. `,
            button("Remove them", () => act(async () => {
                for (const f of unlisted) await offline.forget(f.sha256);
            }, "Removed what an older pack kept.")))] : []),
        ...(ABSENT.length ? [el("h2", { textContent: "Not in the offline client" }),
            el("p", { className: "hint", textContent: "These open as text or download instead, as they'd load code from the server: " + ABSENT.join("; ") + "." })] : []),
        el("p", { className: "hint", textContent: "Rendered Markdown and HTML, and EPUB books, need nothing fetched: they're in the offline client." }));
    page.replaceChildren(navBar("components"), main);
}

draw().catch((e) => page.replaceChildren(el("p", { className: "error", textContent: `The components can't be listed: ${e?.message || e}` })));
