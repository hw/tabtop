import { pngSquare } from "./fixtures.mjs";

export async function checkBinary({ inContainer, step, ev, waitFor, open, listed, row, press, cdp, sleep }) {
    await step("files: Kaitai format selection, decoded fields and hex jumps", async () => {
        inContainer("sh", "-c", "cp /bin/ls ~/Downloads/media/inspect.bin; printf 'hello from unknown text\\n' > ~/Downloads/media/notes.unknown");
        await open("fs/#/media/", `${listed}.includes("inspect.bin")`, "the binary fixture");
        await ev(`${row("inspect.bin")}.querySelector("summary").click()`);
        await ev(`[...${row("inspect.bin")}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
        const selector = `document.querySelector('dialog.preview input[aria-label="Binary format"]')`;
        await waitFor(`${selector} && !${selector}.disabled && document.querySelectorAll(".kaitai-format-popup [role=option]").length >= 192`, "all Kaitai formats");
        const modeToggle = `document.querySelector("dialog.preview button.preview-mode-toggle")`;
        // Bytes that aren't text: no switch to a text view.
        if (await ev(`${modeToggle}.hidden && !${modeToggle}.checkVisibility()`) !== true) throw new Error("a binary-only preview offers a text view");
        const arrowAllowed = await ev(`document.querySelector(".hex-dump").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))`);
        if (!arrowAllowed) throw new Error("the lightbox intercepted an arrow key inside the hex pane");
        const select = async id => {
            await ev(`${selector}.value = ${JSON.stringify(id)}; ${selector}.dispatchEvent(new Event("change"))`);
        };
        const node = name => `[...document.querySelectorAll(".kaitai-node")].find(n => n.querySelector(":scope > .kaitai-row > .kaitai-jump")?.textContent === ${JSON.stringify(name)})`;
        await ev(`document.querySelector(".kaitai-format-toggle").click()`);
        await waitFor(`${selector}.getAttribute("aria-expanded") === "true"`, "the format dropdown");
        await ev(`${selector}.value = "network"; ${selector}.dispatchEvent(new Event("input"))`);
        if (await ev(`document.querySelectorAll(".kaitai-format-popup [role=option]").length`) < 25 ||
            !(await ev(`[...document.querySelectorAll(".kaitai-format-popup [role=option]")].every(row => row.textContent.toLowerCase().includes("network"))`))) throw new Error("format category filtering failed");
        const firstMatch = await ev(`${selector}.getAttribute("aria-activedescendant")`);
        await press("ArrowDown");
        if (await ev(`${selector}.getAttribute("aria-activedescendant")`) === firstMatch) throw new Error("keyboard navigation did not move through suggestions");
        await press("Escape");
        if (!(await ev(`!!document.querySelector("dialog.preview[open]") && ${selector}.getAttribute("aria-expanded") === "false"`))) throw new Error("Escape closed the lightbox instead of the dropdown");
        await ev(`${selector}.value = "elf"; ${selector}.dispatchEvent(new Event("input"))`);
        await press("Enter");
        await waitFor(`!!${node("bits")} && document.querySelector(".kaitai-status").textContent.includes("Select a field")`, "decoded ELF fields");
        await ev(`${node("bits")}.querySelector(".kaitai-jump").click()`);
        await waitFor(`document.querySelector(".hex-dump .hex-byte.selected")?.textContent === "02"`, "ELF class byte highlighted");
        const detail = key => `document.querySelector('.kaitai-field-details [data-detail="${key}"]')?.textContent`;
        if (await ev(detail("Path")) !== "elf.bits" || await ev(detail("Type")) !== "u1") throw new Error("field path or type is missing");
        if (!(await ev(`${detail("Enum")}.includes("b64") && ${detail("Offset")}.includes("0x4") && ${detail("Length")} === "1 byte"`))) throw new Error("field enum, offset or length is missing");
        if (!(await ev(`document.querySelector(".kaitai-field-doc").textContent.includes("word size")`))) throw new Error("field documentation is missing");
        await ev(`${node("header")}.querySelector(".kaitai-toggle").click()`);
        await waitFor(`!!${node("sectionHeaders")}`, "ELF section references");
        await ev(`${node("machine")}.querySelector(".kaitai-jump").click()`);
        if (await ev(detail("Byte order")) !== "Little endian") throw new Error("field endianness is missing");
        await ev(`${node("sectionHeaders")}.querySelector(".kaitai-toggle").click()`);
        await waitFor(`${node("sectionHeaders")}.querySelector(".kaitai-children .kaitai-node")`, "decoded section headers");
        await ev(`${node("sectionHeaders")}.querySelector(".kaitai-jump").click()`);
        await waitFor(`!document.querySelector(".hex-dump").textContent.startsWith("00000000")`, "jump to the section table");
        await ev(`${selector}.value = "not-a-format"; ${selector}.dispatchEvent(new Event("change"))`);
        if (await ev(`${selector}.validity.valid`)) throw new Error("an unknown format was accepted");
        if (!(await ev(`!!${node("bits")}`))) throw new Error("editing the format removed the decoded view");
        await ev(`${selector}.value = "png"; ${selector}.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))`);
        await waitFor(`document.querySelector(".kaitai-status").dataset.state === "format-mismatch"`, "wrong format error with hex retained");
        if (!(await ev(`!!document.querySelector(".hex-dump")`))) throw new Error("raw hex disappeared after decoding failed");
        await ev(`${selector}.value = "bcd"; ${selector}.dispatchEvent(new Event("input")); document.querySelector(".kaitai-format-popup [role=option]").click()`);
        await waitFor(`!document.querySelector(".kaitai-params").hidden`, "required format parameters");
        await select("");
        if (!(await ev(`document.querySelector(".kaitai-structure").hidden`))) throw new Error("raw hex mode still shows a decoder");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "binary preview closes");
        inContainer("sh", "-c", "cd ~/Downloads/media; cp /bin/ls far-sections.bin; truncate -s 2000000 far-sections.bin; printf '\\140\\343\\026\\000\\000\\000\\000\\000' | dd of=far-sections.bin bs=1 seek=40 conv=notrunc status=none; cp /bin/ls ~/Downloads/media/truncated.bin; truncate -s 20 ~/Downloads/media/truncated.bin; head -c 100000 /dev/zero > ~/Downloads/media/budget.bin");
        await waitFor(`${listed}.includes("far-sections.bin") && ${listed}.includes("budget.bin") && ${listed}.includes("truncated.bin")`, "partial decoding fixtures");
        const openBinary = async name => {
            await ev(`${row(name)}.querySelector("summary").click()`);
            await ev(`[...${row(name)}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
            await waitFor(`${selector} && !${selector}.disabled`, name);
        };
        const closeBinary = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "partial preview closes");
        };
        await openBinary("far-sections.bin");
        await select("elf");
        await waitFor(`document.querySelector(".kaitai-status").dataset.state === "prefix"`, "successful decoding of the prefix");
        // With the structure beside them, the bytes still fit: no scrolling sideways.
        if (await ev(`(d => d.scrollWidth > d.clientWidth)(document.querySelector("dialog.preview .hex-dump"))`)) throw new Error("the hex and ASCII columns scroll sideways beside a decoder's structure");
        await ev(`${node("header")}.querySelector(".kaitai-toggle").click()`);
        await waitFor(`!!${node("sectionHeaders")}`, "lazy section table outside the prefix");
        await ev(`${node("sectionHeaders")}.querySelector(".kaitai-toggle").click()`);
        await waitFor(`document.querySelector(".kaitai-status").dataset.state === "outside-preview"`, "a missing range is distinct from a format mismatch");
        if (!(await ev(`${node("bits")}.querySelector(".kaitai-value").textContent.includes("b64")`))) throw new Error("earlier decoded fields were lost");
        await ev(`document.querySelector(".kaitai-required-bytes").click()`);
        await waitFor(`document.querySelector(".hex-dump .hex-byte.selected")?.textContent === "00" && document.querySelector(".hex-controls [role=status]").textContent.startsWith("Bytes 1,499,712")`, "jump to the exact required byte range");
        await closeBinary();
        await openBinary("truncated.bin"); await select("elf");
        await waitFor(`document.querySelector(".kaitai-status").dataset.state === "truncated"`, "an actual truncated file");
        if (!(await ev(`${node("bits")}.querySelector(".kaitai-value").textContent.includes("b64")`))) throw new Error("truncated input lost its parsed fields");
        await closeBinary();
        await openBinary("budget.bin"); await select("code_6502");
        await waitFor(`document.querySelector(".kaitai-status").dataset.state === "budget"`, "a resource budget has its own decode state");
        if (!(await ev(`!!${node("operations")} && !!document.querySelector(".hex-dump")`))) throw new Error("budget exhaustion lost partial fields or hex");
        await closeBinary();

        // A known type too big for its own preview (text, over 2 MB): still
        // offered, and shown in hex, read in ranges past the first part.
        inContainer("sh", "-c", "cd ~/Downloads/media; { echo '#!/bin/sh'; echo 'exit 0'; } > big-installer.sh; head -c 3000000 /dev/zero >> big-installer.sh");
        await waitFor(`${listed}.includes("big-installer.sh")`, "a big shell script listed");
        await ev(`${row("big-installer.sh")}.querySelector("summary").click()`);
        await ev(`[...${row("big-installer.sh")}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
        await waitFor(`!!document.querySelector("dialog.preview .hex-dump") && document.querySelector(".hex-controls [role=status]")?.textContent.includes("3,000,017")`, "a text file too big for text shown in hex");
        if (await ev(`document.querySelector("dialog.preview button.preview-mode-toggle")?.checkVisibility() ?? false`)) throw new Error("a known type in hex offers a text view it can't load");
        await closeBinary();

        // A binary's name (.bin, .dll, .exe, .so, libx.so.1) clicked: shown
        // in hex, not downloaded.
        inContainer("sh", "-c", "cd ~/Downloads/media; cp /bin/ls libclick.so.1");
        await waitFor(`${listed}.includes("libclick.so.1")`, "a versioned shared library listed");
        await ev(`${row("libclick.so.1")}.querySelector("td.name a").click()`);
        await waitFor(`!!document.querySelector("dialog.preview .hex-dump") && document.querySelector("dialog.preview .hex-dump .hex-byte")?.textContent === "7f"`, "a shared library's name clicked shows its bytes");
        await closeBinary();

        await ev(`${row("notes.unknown")}.querySelector("summary").click()`);
        await ev(`[...${row("notes.unknown")}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
        await waitFor(`document.querySelector("dialog.preview pre")?.textContent === "hello from unknown text\\n"`, "unknown text preview");
        if (await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").textContent`) !== "") throw new Error("the preview switch is not glyph-only");
        if (await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").title`) !== "Show binary view") throw new Error("the preview switch has no tooltip");
        const connections = await ev("window.sockets.length");
        await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").click()`);
        await waitFor(`${selector} && !${selector}.disabled`, "binary inspection from the shared preview");
        await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").click()`);
        await waitFor(`document.querySelector("dialog.preview pre")?.textContent === "hello from unknown text\\n"`, "switching back to text in the same lightbox");
        if (await ev(`document.querySelectorAll("dialog.preview").length`) !== 1) throw new Error("mode switching opened another lightbox");
        if (await ev("window.sockets.length") !== connections) throw new Error("mode switching fetched the file again");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        // Named as text, but with NULs in it: shown in hex, not said it can't
        // be, and with no switch to a text view.
        inContainer("sh", "-c", "printf 'MZ\\000\\001binary\\000' > ~/Downloads/media/nul.txt");
        await waitFor(`${listed}.includes("nul.txt")`, "a .txt file that isn't text");
        await ev(`${row("nul.txt")}.querySelector("summary").click()`);
        await ev(`[...${row("nul.txt")}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
        await waitFor(`document.querySelector('.hex-dump .hex-byte[data-offset="2"]')?.textContent === "00"`, "a .txt file of binary, in hex");
        if (await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").checkVisibility() || /isn't text/.test(document.querySelector("dialog.preview .body").textContent)`)) {
            throw new Error("a .txt file of binary offers text");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        inContainer("sh", "-c", "yes 'large preview text' | head -c 12000000 > ~/Downloads/media/large.unknown");
        await waitFor(`${listed}.includes("large.unknown")`, "large unknown file");
        await ev(`${row("large.unknown")}.querySelector("summary").click()`);
        await ev(`[...${row("large.unknown")}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
        await waitFor(`document.querySelector("dialog.preview pre")?.textContent.length === 10000000`, "first 10 MB of a larger text file");
        if (!(await ev(`!document.querySelector(".preview-limit").hidden && document.querySelector(".preview-limit").textContent.includes("12,000,000")`))) throw new Error("the partial preview is not labelled");
        if (!(await ev(`document.querySelector("dialog.preview button.edit").hidden`))) throw new Error("a truncated file can be edited");
        const largeConnections = await ev("window.sockets.length");
        await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").click()`);
        await waitFor(`document.querySelector(".hex-controls [role=status]")?.textContent.includes("12,000,000")`, "the full file is available through hex ranges");
        // Address, hex and ASCII, each under its heading.
        const lined = await ev(`(() => { const left = (s) => Math.round(document.querySelector(s).getBoundingClientRect().left);
            return left(".hex-head .hex-byte:nth-child(16)") === left(".hex-dump .hex-row .hex-byte:nth-child(16)") &&
                left(".hex-head .hex-ascii") === left(".hex-dump .hex-row .hex-ascii") && left(".hex-head .hex-addr") === left(".hex-dump .hex-addr"); })()`);
        if (!lined) throw new Error("the hex header doesn't line up with its columns");
        // Dragged with the mouse: in the hex column, out past the row's
        // end, it runs to the row's last byte; ASCII follows.
        const centre = (selector) => ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const mouse = (type, { x, y }) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
        const selectedOf = (kind) => ev(`[...document.querySelectorAll(".hex-dump .${kind}.selected")].map((c) => Number(c.dataset.offset))`);
        const from = await centre(`.hex-dump .hex-byte[data-offset="0"]`);
        const third = await centre(`.hex-dump .hex-byte[data-offset="40"]`);
        const gap = await ev(`document.querySelector('.hex-dump .hex-char[data-offset="32"]').getBoundingClientRect().left - 6`);
        await mouse("mousePressed", from);
        await mouse("mouseMoved", { x: gap, y: third.y });
        await mouse("mouseReleased", { x: gap, y: third.y });
        const hexSel = await selectedOf("hex-byte"), asciiSel = await selectedOf("hex-char");
        if (hexSel.length !== 48 || hexSel[0] !== 0 || hexSel.at(-1) !== 47 || asciiSel.join() !== hexSel.join()) {
            throw new Error(`hex drag past the row's end selected ${hexSel.length} bytes (${hexSel[0]}–${hexSel.at(-1)}), ASCII ${asciiSel.length}`);
        }
        if (!(await ev(`document.querySelector(".hex-controls [role=status]").textContent.endsWith("48 bytes selected (0x0–0x2f)")`))) throw new Error("the selection isn't in the status");
        // In the ASCII column, held below the dump: it scrolls, and the
        // selection follows; hex follows the ASCII.
        const asciiStart = await centre(`.hex-dump .hex-char[data-offset="3"]`);
        const below = await ev(`document.querySelector(".hex-dump").getBoundingClientRect().bottom + 30`);
        await mouse("mousePressed", asciiStart);
        await mouse("mouseMoved", { x: asciiStart.x, y: below });
        await sleep(600);
        await mouse("mouseReleased", { x: asciiStart.x, y: below });
        const scrolled = await ev(`document.querySelector(".hex-dump").scrollTop`);
        const down = await selectedOf("hex-char"), downHex = await selectedOf("hex-byte");
        const shownRows = await ev(`Math.floor(document.querySelector(".hex-dump").clientHeight / document.querySelector(".hex-dump .hex-row").getBoundingClientRect().height)`);
        if (!(scrolled > 0) || down[0] !== 3 || down.length <= shownRows * 16 || downHex.join() !== down.join()) {
            throw new Error(`dragging below: scrolled ${scrolled}, selected ${down.length} from ${down[0]} (${shownRows} rows shown), hex ${downHex.length}`);
        }
        // Ctrl+C copies it (as text, chosen in ASCII); Escape clears it and
        // leaves the preview open.
        await press("c", 2);
        await waitFor(`/Copied [\\d,]+ bytes as text\\.$/.test(document.querySelector(".hex-controls [role=status]").textContent)`, "the selection copied as text");
        await press("Escape");
        if (!(await ev(`!!document.querySelector("dialog.preview[open]") && !document.querySelector(".hex-dump .selected")`))) throw new Error("Escape didn't just clear the hex selection");
        // A slow drag down twenty rows: the dump stays where it is (nothing
        // above it grows or wraps), and the selection only ever grows.
        await ev(`document.querySelector(".hex-dump").scrollTop = 0`);
        const steady = await centre(`.hex-dump .hex-byte[data-offset="0"]`);
        const rowHeight = await ev(`document.querySelector(".hex-dump .hex-row").getBoundingClientRect().height`);
        const dumpTop = () => ev(`document.querySelector(".hex-dump").getBoundingClientRect().top`);
        const top0 = await dumpTop();
        const tops = new Set(), sizes = [];
        await mouse("mousePressed", steady);
        for (let i = 1; i <= 80; i++) {
            const at = { x: steady.x + (i % 16) * 3, y: steady.y + i * rowHeight / 4 };
            await mouse("mouseMoved", at);
            tops.add(Math.round(await dumpTop()));
            sizes.push(await ev(`document.querySelectorAll(".hex-dump .hex-byte.selected").length`));
        }
        await mouse("mouseReleased", { x: steady.x, y: steady.y + 20 * rowHeight });
        // (Within a row, the pointer going left shrinks it by less than a row.)
        const shrank = sizes.filter((n, i) => i && n <= sizes[i - 1] - 16).length;
        if (tops.size !== 1 || [...tops][0] !== Math.round(top0) || shrank) {
            throw new Error(`the dump moved during a drag (tops ${[...tops].join(", ")}, from ${Math.round(top0)}), or the selection jumped back ${shrank} times: ${sizes.join(" ")}`);
        }
        await press("Escape");
        // Four bytes, "larg": the data inspector beside the bytes reads them,
        // each value with a copy glyph, and copies the selection as Base64.
        await ev(`document.querySelector(".hex-dump").scrollTop = 0`);
        await mouse("mousePressed", await centre(`.hex-dump .hex-byte[data-offset="0"]`));
        const fourth = await centre(`.hex-dump .hex-byte[data-offset="3"]`);
        await mouse("mouseMoved", fourth);
        await mouse("mouseReleased", fourth);
        // One value a type, little-endian to start with; BE, big-endian.
        const inspectedNow = () => ev(`(() => { const value = (type) => [...document.querySelectorAll(".hex-inspector tbody tr")]
                .find((tr) => tr.cells[0].textContent === type).cells[1].querySelector(".hex-inspector-value").textContent;
            const dump = document.querySelector(".hex-dump").getBoundingClientRect(), panel = document.querySelector(".hex-inspector").getBoundingClientRect();
            return [document.querySelector(".hex-inspector-at").textContent, value("int32"), value("float32"), value("int64") === "—" ? "" : "8 bytes",
                [...document.querySelectorAll(".hex-inspector tbody tr")].every((tr) => tr.cells.length === 2), panel.left >= dump.right - 1 && panel.top < dump.bottom].join("|"); })()`);
        const littleEndian = await inspectedNow();
        if (littleEndian !== "From 0x0, little-endian|1735549292|1.14460981e+24|8 bytes|true|true") throw new Error(`the data inspector: ${littleEndian}`);
        // "larg": every reading's top bit is clear, so each unsigned one is
        // the signed one's, dimmed.
        if (await ev(`["uint8", "uint16", "uint32", "uint64"].map((type) => getComputedStyle([...document.querySelectorAll(".hex-inspector tbody tr")]
                .find((tr) => tr.cells[0].textContent === type).cells[1].querySelector(".hex-inspector-value")).opacity).join()`) !== "0.45,0.45,0.45,0.45") {
            throw new Error("the unsigned values the same as the signed ones aren't dimmed");
        }
        await ev(`document.querySelector(".hex-inspector .hex-endian-be").click()`);
        const bigEndian = await inspectedNow();
        if (bigEndian !== "From 0x0, big-endian|1818325607|1.09019424e+27|8 bytes|true|true" ||
            await ev(`document.querySelector(".hex-endian-be").getAttribute("aria-pressed") + document.querySelector(".hex-endian-le").getAttribute("aria-pressed")`) !== "truefalse") {
            throw new Error(`the data inspector, big-endian: ${bigEndian}`);
        }
        // Raw, first: the 8 bytes as one hex number, as the order reads them.
        const raw = () => ev(`(() => { const tr = document.querySelector(".hex-inspector tbody tr"); return tr.cells[0].textContent + " " + tr.cells[1].querySelector(".hex-inspector-value").textContent; })()`);
        const rawBig = await raw();
        await ev(`document.querySelector(".hex-inspector .hex-endian-le").click()`);
        const rawLittle = await raw();
        await ev(`document.querySelector(".hex-inspector .hex-endian-be").click()`);
        const pairs = (t) => t.slice(6).match(/../g);
        if (!/^raw 0x[0-9a-f]{16}$/.test(rawBig) || pairs(rawLittle).join() !== pairs(rawBig).reverse().join() || !rawBig.startsWith("raw 0x6c617267")) {
            throw new Error(`the raw row: ${rawBig}, ${rawLittle}`);
        }
        await ev(`[...document.querySelectorAll(".hex-inspector tbody tr")].find((tr) => tr.cells[0].textContent === "int32").cells[1].querySelector("button.hex-inspector-copy").click()`);
        await waitFor(`document.querySelector(".hex-controls [role=status]").textContent.endsWith("Copied int32 (big-endian) 1818325607.")`, "an int32 copied");
        await ev(`document.querySelector(".hex-inspector button.hex-copy-base64").click()`);
        await waitFor(`document.querySelector(".hex-controls [role=status]").textContent.endsWith("Copied 4 bytes as Base64.")`, "the bytes copied as Base64");
        if (await ev(`navigator.clipboard.readText().catch(() => "")`).then((t) => t !== "" && t !== "bGFyZw==")) throw new Error("Base64 copied wrong");
        // Copy as …: a box over the preview, its choices remembered.
        await ev(`document.querySelector(".hex-inspector button.hex-copy-more").click()`);
        await waitFor(`document.querySelector("dialog.hex-copy-format")?.open && document.querySelector("dialog.hex-copy-format").matches(":modal")`, "the Copy as box open");
        await ev(`(() => { const d = document.querySelector("dialog.hex-copy-format");
            d.querySelector(".hex-copy-case").value = "upper"; d.querySelector(".hex-copy-case").dispatchEvent(new Event("change"));
            d.querySelector(".hex-copy-separator").value = "3"; d.querySelector(".hex-copy-separator").dispatchEvent(new Event("change"));
            const p = d.querySelector(".hex-copy-prefix"); p.value = "0x"; p.dispatchEvent(new Event("input")); })()`);
        const sample = await ev(`document.querySelector("dialog.hex-copy-format .hex-copy-sample").textContent`);
        if (sample !== "0x6C, 0x61, 0x72, 0x67") throw new Error(`the Copy as sample: ${sample}`);
        await ev(`document.querySelector("dialog.hex-copy-format button[type=submit]").click()`);
        await waitFor(`!document.querySelector("dialog.hex-copy-format").open && document.querySelector(".hex-controls [role=status]").textContent.endsWith("Copied 4 bytes as hex.")`, "the bytes copied as chosen");
        if (await ev(`navigator.clipboard.readText().catch(() => "")`).then((t) => t !== "" && t !== "0x6C, 0x61, 0x72, 0x67")) throw new Error("Copy as … copied wrong");
        if (!(await ev(`document.querySelector("dialog.preview").open`))) throw new Error("closing the Copy as box closed the preview");
        await ev(`document.querySelector(".hex-inspector button.hex-copy-more").click()`);
        if (await ev(`document.querySelector("dialog.hex-copy-format .hex-copy-prefix").value + "|" + document.querySelector("dialog.hex-copy-format .hex-copy-case").value`) !== "0x|upper") {
            throw new Error("Copy as … didn't remember its choices");
        }
        await ev(`document.querySelector("dialog.hex-copy-format").close()`);
        // Dragged down the offset column, from 0x10's row to 0x30's: those
        // three rows.
        await ev(`document.querySelector(".hex-dump").scrollTop = 0`);
        await mouse("mousePressed", await centre(`.hex-dump .hex-row[data-offset="16"] .hex-addr`));
        const thirdRow = await centre(`.hex-dump .hex-row[data-offset="48"] .hex-addr`);
        await mouse("mouseMoved", thirdRow);
        await mouse("mouseReleased", thirdRow);
        if (await ev(`[...document.querySelectorAll(".hex-dump .hex-byte.selected")].map((c) => Number(c.dataset.offset)).join()`) !== Array.from({ length: 48 }, (_, i) => 16 + i).join()) {
            throw new Error("a drag down the offsets didn't select their rows");
        }
        // Its toggle: a glyph at the right end of the Interpret as row; the
        // bytes take the room when it's hidden.
        const toggle = `document.querySelector(".kaitai-controls > button.hex-inspector-toggle")`;
        if (await ev(`(() => { const t = ${toggle}, row = t?.parentElement.getBoundingClientRect(), r = t?.getBoundingClientRect();
            return !!t && t === t.parentElement.lastElementChild && row.right - r.right < 40 && t.getAttribute("aria-pressed") === "true" && !!t.querySelector("svg"); })()`) !== true) {
            throw new Error("the data inspector's toggle isn't a glyph at the right of the Interpret as row");
        }
        const paneWidth = () => ev(`Math.round(document.querySelector(".hex-pane").getBoundingClientRect().width)`);
        const withPanel = await paneWidth();
        await ev(`${toggle}.click()`);
        if (!(await ev(`document.querySelector(".hex-inspector").hidden && ${toggle}.getAttribute("aria-pressed") === "false"`)) || await paneWidth() <= withPanel) {
            throw new Error("hiding the data inspector didn't give the bytes its room");
        }
        await ev(`${toggle}.click()`);
        await waitFor(`!document.querySelector(".hex-inspector").hidden`, "the data inspector shown again");
        // On a phone: one row, Interpret as, the format and the toggle.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
        try {
            await waitFor(`(() => { const row = document.querySelector(".kaitai-controls"), mid = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; };
                const label = row.querySelector("label"), combo = row.querySelector(".kaitai-format-combo"), t = ${toggle};
                return Math.abs(mid(label) - mid(t)) < 4 && Math.abs(mid(combo) - mid(t)) < 4 && t.getBoundingClientRect().right <= row.getBoundingClientRect().right; })()`, "the Interpret as row, on a phone");
            // < > −1 MB +1 MB on one row; what's to say below, without which
            // bytes are shown.
            const bar = await ev(`(() => { const mid = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
                const buttons = [".hex-previous", ".hex-next", ".hex-previous-range", ".hex-next-range"].map((c) => document.querySelector(".hex-controls " + c));
                const status = document.querySelector(".hex-controls [role=status]");
                return [buttons.map((b) => b.textContent).join(" "), new Set(buttons.map(mid)).size, getComputedStyle(status.querySelector(".hex-range")).display,
                    getComputedStyle(status).display, status.getBoundingClientRect().top >= buttons[0].getBoundingClientRect().bottom].join("|"); })()`);
            if (bar !== "< > −1 MB +1 MB|1|none|block|true") throw new Error(`the byte buttons, on a phone: ${bar}`);
            // Go to on the buttons' row, within the bar; Find on a row of its
            // own, below, as wide as the bar allows; 0x and Aa the same width.
            const forms = await ev(`(() => { const mid = (r) => (r.top + r.bottom) / 2;
                const jump = document.querySelector(".hex-jump").getBoundingClientRect(), find = document.querySelector(".hex-find").getBoundingClientRect();
                const next = document.querySelector(".hex-controls .hex-next-range").getBoundingClientRect(), bar = document.querySelector(".hex-controls");
                const inner = bar.getBoundingClientRect(), pad = parseFloat(getComputedStyle(bar).paddingLeft) + parseFloat(getComputedStyle(bar).paddingRight);
                const mode = document.querySelector(".hex-find-mode"), width = () => Math.round(mode.getBoundingClientRect().width);
                const hexWidth = width(); mode.click(); const asciiWidth = width(); mode.click();
                return [Math.abs(mid(jump) - mid(next)) < 3, jump.left >= next.right, jump.right <= inner.right, find.top >= jump.bottom,
                    Math.abs(find.width - (inner.width - pad)) < 2, hexWidth === asciiWidth, !!mode.querySelector("svg ellipse") && mode.textContent === ""].join("|"); })()`);
            if (forms !== "true|true|true|true|true|true|true") throw new Error(`Go to and Find, on a phone: ${forms}`);
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        if (await ev(`getComputedStyle(document.querySelector(".hex-controls .hex-range")).display`) === "none") throw new Error("which bytes are shown stayed hidden on a wide screen");
        await press("Escape");
        await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").click()`);
        await waitFor(`document.querySelector("dialog.preview pre")?.textContent.length === 10000000`, "the same prefix as text again");
        if (await ev("window.sockets.length") !== largeConnections) throw new Error("switching a truncated preview fetched the file again");
        await ev(`document.querySelector("dialog.preview button.preview-mode-toggle").click()`);
        await waitFor(`!!document.querySelector(".hex-next-range")`, "hex range navigation");
        await ev(`document.querySelector(".hex-jump input").value = "11000000"; document.querySelector(".hex-jump").requestSubmit()`);
        await waitFor(`document.querySelector(".hex-dump")?.textContent.startsWith("00a7d8c0")`, "an encrypted byte range beyond the text prefix");
        if (await ev("window.sockets.length") !== largeConnections + 1) throw new Error("hex did not load exactly one new range");
        await ev(`document.querySelector(".hex-previous-range").click()`);
        await waitFor(`document.querySelector(".hex-controls [role=status]")?.textContent.startsWith("Bytes 10,000,000")`, "the preceding 1 MB range");
        inContainer("sh", "-c", "printf changed >> ~/Downloads/media/large.unknown");
        await ev(`document.querySelector(".hex-previous-range").click()`);
        // This range is already buffered in the text prefix, so move to a changed range instead.
        await waitFor(`document.querySelector(".hex-controls [role=status]")?.textContent.startsWith("Bytes 9,000,000")`, "buffered range");
        await ev(`document.querySelector(".hex-jump input").value = "11000000"; document.querySelector(".hex-jump").requestSubmit()`);
        await waitFor(`document.querySelector(".hex-controls [role=status]")?.textContent.startsWith("Couldn't read this range")`, "changed-file range rejection");
        if (inContainer("sh", "-c", "wc -c < ~/Downloads/media/large.unknown") !== "12000007") throw new Error("preview changed the source file");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        inContainer("sh", "-c", `mkdir -p ~/Downloads/preview-navigation; printf 'mode check' > ~/Downloads/preview-navigation/a.txt; printf '%s' '${pngSquare(1).toString("base64")}' | base64 -d > ~/Downloads/preview-navigation/b.png`);
        await open("fs/#/preview-navigation/", `${listed}.includes("a.txt") && ${listed}.includes("b.png")`, "navigation fixtures");
        const showText = async () => {
            await ev(`${row("a.txt")}.querySelector("td.name a").click()`);
            await waitFor(`document.querySelector("dialog.preview pre")?.textContent === "mode check"`, "the text navigation fixture");
        };
        await showText();
        if (!(await ev(`document.querySelector(".preview-mode-toggle").hidden`))) throw new Error("known text exposes binary view");
        await ev(`document.querySelector(".preview-mode-toggle").click()`);
        if (await ev(`document.querySelector("dialog.preview pre")?.textContent`) !== "mode check") throw new Error("known text switched into binary view");
        await ev(`document.querySelector('dialog.preview button[aria-label="Next (→)"]').click()`);
        await waitFor(`document.querySelector("dialog.preview img")?.naturalWidth === 1`, "the next image uses its native renderer");
        if (!(await ev(`document.querySelector(".preview-mode-toggle").hidden`))) throw new Error("known image exposes binary view");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        inContainer("sh", "-c", "rm -r ~/Downloads/preview-navigation");
        inContainer("sh", "-c", "rm ~/Downloads/media/inspect.bin ~/Downloads/media/nul.txt ~/Downloads/media/notes.unknown ~/Downloads/media/large.unknown ~/Downloads/media/far-sections.bin ~/Downloads/media/truncated.bin ~/Downloads/media/budget.bin");
        return "autocomplete, 191 formats, bounded prefixes, field jumps and preview navigation";
    });
    await step("files: hex search, and bytes edited and saved in place", async () => {
        // 256 bytes: ff fe, then nothing but de ad be ef at 0x40 and MAGIC at 0x80.
        const file = "patch.bin", sh = (command) => inContainer("sh", "-c", `cd ~/Downloads/media && ${command}`);
        sh(`head -c 256 /dev/zero > ${file}; printf '\\377\\376' | dd of=${file} conv=notrunc status=none; ` +
            `printf '\\336\\255\\276\\357' | dd of=${file} bs=1 seek=64 conv=notrunc status=none; printf MAGIC | dd of=${file} bs=1 seek=128 conv=notrunc status=none; ` +
            `printf '\\125\\110\\211\\345\\303' | dd of=${file} bs=1 seek=32 conv=notrunc status=none; ` +
            `printf '\\353\\116' | dd of=${file} bs=1 seek=48 conv=notrunc status=none`);
        const bytesAt = (at, n) => sh(`od -An -tx1 -j ${at} -N ${n} ${file}`).trim();
        const inode = sh(`stat -c %i ${file}`);
        if (bytesAt(64, 4) !== "de ad be ef") throw new Error(`the fixture: ${bytesAt(64, 4)}`);
        await open("fs/#/media/", `${listed}.includes("patch.bin")`, "the patch fixture");
        await ev(`${row("patch.bin")}.querySelector("summary").click()`);
        await ev(`[...${row("patch.bin")}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
        await waitFor(`!!document.querySelector('.hex-dump .hex-byte[data-offset="2"]') && !document.querySelector("dialog.preview button.edit").hidden`, "patch.bin in hex, with Edit");
        const status = `document.querySelector(".hex-controls [role=status]").textContent`;
        const selected = `[...document.querySelectorAll(".hex-dump .hex-byte.selected")].map((c) => Number(c.dataset.offset)).join()`;
        const find = async (mode, text, backward = false) => {
            await ev(`(() => { const m = document.querySelector(".hex-find-mode"); if (m.dataset.mode !== ${JSON.stringify(mode)}) m.click();
                document.querySelector(".hex-find-input").value = ${JSON.stringify(text)}; })()`);
            if (backward) await ev(`document.querySelector(".hex-find-previous").click()`);
            else await ev(`document.querySelector(".hex-find").requestSubmit()`);
        };
        // Hex, with ?? for any byte: the three bytes from 0x40.
        await find("hex", "de ?? be");
        await waitFor(`${status}.endsWith("Found at 0x40.")`, "a hex search with ??");
        if (await ev(selected) !== "64,65,66") throw new Error(`the hex match selected ${await ev(selected)}`);
        // ASCII: MAGIC at 0x80, selected in the ASCII column; on from it, no more.
        await find("ascii", "MAGIC");
        await waitFor(`${status}.endsWith("Found at 0x80.")`, "an ASCII search");
        if (await ev(`document.querySelector(".hex-dump").dataset.selecting`) !== "ascii") throw new Error("the ASCII match isn't selected as text");
        await find("ascii", "MAGIC");
        await waitFor(`${status}.endsWith("Not found after there.")`, "no second MAGIC");
        // Back from 0x80, with a nibble wildcard: de at 0x40.
        await find("hex", "d? a?", true);
        await waitFor(`${status}.endsWith("Found at 0x40.")`, "a backward search with half-byte wildcards");
        // Disassembly, in the inspector: push rbp; mov rbp,rsp; ret at 0x20,
        // found as hex; and as 32-bit code, where 48 is an instruction itself.
        await find("hex", "55 48 89 e5 c3", true);
        await waitFor(`${status}.endsWith("Found at 0x20.")`, "the code found");
        // Its tab, at any width: the panel the instructions', the values
        // put away, the instruction set at the right of the tabs.
        const shown = (s) => `(() => { const e = document.querySelector(${JSON.stringify(s)}); return !!e && e.checkVisibility(); })()`;
        if (await ev(`${shown(".hex-inspector-tabs")} && ${shown(".hex-inspector-values")} && !${shown(".hex-disasm")} && !${shown(".hex-disasm-bitness")}`) !== true) {
            throw new Error("the inspector's tabs, on a wide screen, on Values");
        }
        await ev(`document.querySelector(".hex-inspector-tab-disasm").click()`);
        const wide = await ev(`(() => { const t = document.querySelector(".hex-inspector-tab-disasm").getBoundingClientRect(),
            b = document.querySelector(".hex-disasm-bitness").getBoundingClientRect(), i = document.querySelector(".hex-inspector").getBoundingClientRect();
            return [${shown(".hex-inspector-values")}, ${shown(".hex-inspector-actions")}, ${shown(".hex-endian")}, ${shown(".hex-disasm")},
                b.top < t.bottom && b.bottom > t.top && b.left >= t.right && i.right - b.right < 30].join("|"); })()`);
        if (wide !== "false|false|false|true|true") throw new Error(`the disassembly tab, on a wide screen: ${wide}`);
        // The instruction set as tall as the tabs.
        const heights = await ev(`[".hex-inspector-tab-disasm", ".hex-disasm-bitness"].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().height)).join()`);
        if (heights.split(",")[0] !== heights.split(",")[1]) throw new Error(`the instruction set and the tabs, in height: ${heights}`);
        const disassembled = `[...document.querySelectorAll(".hex-disasm-lines li")].map((li) => li.querySelector(".hex-disasm-at").textContent + " " + li.querySelector(".hex-disasm-text")?.textContent).join("|")`;
        await waitFor(`${disassembled} === "00000020 push rbp|00000021 mov rbp,rsp|00000024 ret"`, "the x86-64 disassembly", 30000);
        await ev(`(() => { const b = document.querySelector(".hex-disasm-bitness"); b.value = "x86-32"; b.dispatchEvent(new Event("change")); })()`);
        await waitFor(`${disassembled} === "00000020 push ebp|00000021 dec eax|00000022 mov ebp,esp|00000024 ret"`, "the 32-bit disassembly");
        await ev(`(() => { const b = document.querySelector(".hex-disasm-bitness"); b.value = "x86-64"; b.dispatchEvent(new Event("change")); })()`);
        // A jump, eb 4e at 0x30, to 0x80: its address a link, there.
        await find("hex", "eb 4e");
        await waitFor(`${status}.endsWith("Found at 0x30.") && ${disassembled} === "00000030 jmp short 0000000000000080h" && !!document.querySelector(".hex-disasm-target")`, "a jump, its target a link");
        await ev(`document.querySelector(".hex-disasm-target").click()`);
        await waitFor(`${selected} === "128" && ${disassembled}.startsWith("00000080 ")`, "the jump's target, its code shown");
        await find("hex", "55 48 89 e5 c3", true);
        await waitFor(`${status}.endsWith("Found at 0x20.")`, "the code found again");
        // On a phone, the panel under the bytes, the tab kept: the
        // disassembly in sight.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
        try {
            await waitFor(`${shown(".hex-inspector-tabs")} && !${shown(".hex-inspector-values")} && ${shown(".hex-disasm")}`, "the inspector's tabs, on a phone");
            await waitFor(`${disassembled} === "00000020 push rbp|00000021 mov rbp,rsp|00000024 ret"`, "the disassembly tab");
            const tab = await ev(`(() => { const i = document.querySelector(".hex-inspector").getBoundingClientRect(), last = [...document.querySelectorAll(".hex-disasm-lines li")].at(-1).getBoundingClientRect();
                return [${shown(".hex-inspector-values")}, ${shown(".hex-inspector-actions")}, last.bottom <= i.bottom && last.top >= i.top,
                    document.querySelector(".hex-inspector-tab-disasm").getAttribute("aria-pressed")].join("|"); })()`);
            if (tab !== "false|false|true|true") throw new Error(`the disassembly tab, on a phone: ${tab}`);
            await ev(`document.querySelector(".hex-inspector-tab-values").click()`);
            if (await ev(`${shown(".hex-disasm")} || !${shown(".hex-inspector-values")}`)) throw new Error("the values tab, on a phone");
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        // Edit: a click on byte 2, then 4 1 4 2 typed: bytes 2 and 3 are "AB".
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!document.querySelector(".hex-dump.editing")`, "editing bytes");
        const centre = (selector) => ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const at = await centre(`.hex-dump .hex-byte[data-offset="2"]`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
        for (const k of ["4", "1", "4", "2"]) await press(k);
        await waitFor(`document.querySelector('.hex-dump .hex-byte[data-offset="3"]').textContent === "42" && ` +
            `document.querySelector('.hex-dump .hex-char[data-offset="2"]').classList.contains("edited") && document.querySelector(".save-status").textContent === "Unsaved changes"`, "two bytes typed over");
        // A value typed in the inspector: uint16, big-endian, 0x1234 at 0x10;
        // Ctrl+Z, back at the bytes, takes both back at once.
        const sixteenth = await centre(`.hex-dump .hex-byte[data-offset="16"]`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: sixteenth.x, y: sixteenth.y, button: "left", clickCount: 1 });
        await ev(`document.querySelector(".hex-inspector .hex-endian-be").click()`);
        const uint16Box = `[...document.querySelectorAll(".hex-inspector tbody tr")].find((tr) => tr.cells[0].textContent === "uint16").cells[1].querySelector("input.hex-inspector-input")`;
        await waitFor(`!!${uint16Box} && getComputedStyle(${uint16Box}).display !== "none" && ${uint16Box}.value === "0"`, "the inspector's value boxes, editing");
        await ev(`(() => { const b = ${uint16Box}; b.focus(); b.select(); })()`);
        await cdp("Input.insertText", { text: "0x1234" });
        await press("Enter");
        await waitFor(`document.querySelector('.hex-dump .hex-byte[data-offset="16"]').textContent === "12" && document.querySelector('.hex-dump .hex-byte[data-offset="17"]').textContent === "34" && ` +
            `document.querySelector('.hex-dump .hex-byte[data-offset="17"]').classList.contains("edited") && ${uint16Box}.value === "4660"`, "a uint16 typed in the inspector");
        await ev(`document.querySelector(".hex-dump").focus()`);
        await press("z", 2);
        await waitFor(`document.querySelector('.hex-dump .hex-byte[data-offset="16"]').textContent === "00" && document.querySelector('.hex-dump .hex-byte[data-offset="17"]').textContent === "00"`, "the uint16 undone at once");
        await ev(`document.querySelector(".hex-inspector .hex-endian-le").click()`);
        // An instruction typed over one in the disassembly: nop over mov
        // rbp,rsp, at 0x21, is 90 and two nops; one that isn't, said. (Found
        // forwards, from 0x10, where the selection is.)
        await ev(`document.querySelector(".hex-inspector-tab-disasm").click()`);
        await find("hex", "55 48 89 e5 c3");
        await waitFor(`${status}.includes("Found at 0x20 (in the saved file).") && document.querySelector(".hex-disasm").classList.contains("editable") && ${disassembled} === "00000020 push rbp|00000021 mov rbp,rsp|00000024 ret"`, "the code, to change");
        const typeLine = async (offset, text) => {
            await ev(`[...document.querySelectorAll(".hex-disasm-lines li")].find((li) => li.querySelector(".hex-disasm-at")?.textContent === ${JSON.stringify(offset)}).click()`);
            await waitFor(`document.activeElement?.classList.contains("hex-disasm-input")`, `the box for the instruction at ${offset}`);
            await ev(`document.activeElement.select()`);
            await cdp("Input.insertText", { text });
            await press("Enter");
        };
        await typeLine("00000021", "nop");
        await waitFor(`${disassembled} === "00000020 push rbp|00000021 nop|00000022 nop|00000023 nop|00000024 ret" && document.querySelector('.hex-dump .hex-byte[data-offset="35"]').classList.contains("edited")`, "nop over mov rbp,rsp");
        if (!(await ev(`document.querySelector(".edit-status").textContent`)).startsWith("Set 0x21 to nop, with 2 nops after it")) throw new Error("what was set isn't said");
        await typeLine("00000024", "bogus");
        await waitFor(`document.querySelector(".edit-status").textContent === '"bogus" isn\\'t an x86 instruction.' && !!document.querySelector(".hex-disasm-input")`, "a line that isn't an instruction");
        await press("Escape");
        await waitFor(`!document.querySelector(".hex-disasm-input") && ${disassembled}.endsWith("00000024 ret")`, "the box put back");
        if (bytesAt(2, 2) !== "00 00") throw new Error("the file changed before Save");
        await press("s", 2);
        await waitFor(`document.querySelector(".save-status").textContent === "Saved"`, "the bytes saved");
        if (bytesAt(0, 4) !== "ff fe 41 42" || bytesAt(0x20, 5) !== "55 90 90 90 c3" || sh(`stat -c %i:%s ${file}`) !== `${inode}:256`) {
            throw new Error(`saved: ${bytesAt(0, 4)}, ${bytesAt(0x20, 5)}, ${sh(`stat -c %i:%s ${file}`)}`);
        }
        // Searching after the save looks in the file as it is now.
        await find("ascii", "AB", true);
        await waitFor(`${status}.endsWith("Found at 0x2.")`, "the saved bytes found");
        // Done: drawn again, from the copy changed as the file was.
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector(".hex-dump.editing") && document.querySelector('.hex-dump .hex-byte[data-offset="2"]')?.textContent === "41"`, "the change, shown after Done");
        // A change not saved: Done asks, and Discard leaves the file alone.
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!document.querySelector(".hex-dump.editing")`, "editing again");
        const fifth = await centre(`.hex-dump .hex-byte[data-offset="4"]`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: fifth.x, y: fifth.y, button: "left", clickCount: 1 });
        await press("7");
        await waitFor(`document.querySelector('.hex-dump .hex-byte[data-offset="4"]').textContent === "70"`, "a byte typed, not saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        const ask = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
        await waitFor(`${ask}?.textContent.includes("aren't saved. Discard them?")`, "asked before discarding");
        await ev(`${ask}.querySelector("button.primary").click()`);
        await waitFor(`!document.querySelector(".hex-dump.editing") && document.querySelector('.hex-dump .hex-byte[data-offset="4"]')?.textContent === "00"`, "the change discarded");
        if (bytesAt(4, 1) !== "00") throw new Error("a discarded change was saved");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        sh(`rm ${file}`);
        return "?? and half-byte wildcards, ASCII, both ways; x86-64 and 32-bit disassembly; a uint16 typed in the inspector and undone; nop typed over an instruction, padded with nops; two bytes typed over and saved in place (same inode and size); Done redraws them; unsaved changes asked about";
    });
    await step("files: ARM, Thumb-2 and MIPS disassembly in the browser worker", async () => {
        const bytes = Buffer.alloc(96);
        bytes.set([0x04, 0, 0, 0x14], 0);
        bytes.set([0x02, 0, 0, 0xea], 16);
        bytes.set([0x08, 0xbf, 0x01, 0x20, 0, 0xf0, 0, 0xf8], 32);
        bytes.set([0x03, 0, 0, 0x10], 48);
        bytes.set([0x10, 0, 0, 0x03], 64);
        bytes.set([0xfd, 0x7b, 0xbf, 0xa9], 80);
        inContainer("sh", "-c", `printf '%s' '${bytes.toString("base64")}' | base64 -d > ~/Downloads/media/arm-mips.bin`);
        await open("fs/#/media/", `${listed}.includes("arm-mips.bin")`, "the ARM/MIPS fixture");
        const preview = async () => {
            await ev(`${row("arm-mips.bin")}.querySelector("summary").click()`);
            await ev(`[...${row("arm-mips.bin")}.querySelectorAll("button")].find(b => b.textContent === "Preview").click()`);
            await waitFor(`!!document.querySelector(".hex-dump .hex-byte")`, "the ARM/MIPS bytes");
        };
        await preview();
        await ev(`if (document.querySelector(".hex-inspector").hidden) document.querySelector(".hex-inspector-toggle").click();
            document.querySelector(".hex-inspector-tab-disasm").click()`);
        const shown = `[...document.querySelectorAll(".hex-disasm-text")].map(e => e.textContent).join("|")`;
        const choose = (mode) => ev(`(() => { const e = document.querySelector(".hex-disasm-bitness"); e.value = ${JSON.stringify(mode)}; e.dispatchEvent(new Event("change")); })()`);
        const panelSize = (axis) => ev(`document.querySelector(".hex-inspector").getBoundingClientRect().${axis}`);
        const dragInspector = async (dx, dy) => {
            const at = await ev(`(() => { const r = document.querySelector(".hex-inspector-resize").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            for (const [type, x, y] of [["mousePressed", at.x, at.y], ["mouseMoved", at.x + dx, at.y + dy], ["mouseReleased", at.x + dx, at.y + dy]]) {
                await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
            }
        };
        let resizedWidth;
        for (const [mode, pattern, text] of [
            ["arm64", "04 00 00 14", "b #0x10"],
            ["arm32", "02 00 00 ea", "b #0x20"],
            ["thumb", "08 bf 01 20 00 f0 00 f8", "it eq|moveq r0, #1|bl #0x28"],
            ["mips32-le", "03 00 00 10", "b 0x40"],
            ["mips64-le", "03 00 00 10", "b 0x40"],
            ["mips32-be", "10 00 00 03", "b 0x50"],
            ["mips64-be", "10 00 00 03", "b 0x50"],
        ]) {
            await choose(mode);
            // Find starts after the current selection; branch navigation
            // or another mode may already have selected this fixture.
            if (await ev(`!!document.querySelector(".hex-byte.selected")`)) {
                await ev(`document.querySelector(".hex-dump").focus()`);
                await press("Escape");
            }
            await ev(`(() => { const e = document.querySelector(".hex-find-mode"); if (e.dataset.mode !== "hex") e.click();
                document.querySelector(".hex-find-input").value = ${JSON.stringify(pattern)}; document.querySelector(".hex-find").requestSubmit(); })()`);
            await waitFor(`${shown} === ${JSON.stringify(text)} && !!document.querySelector(".hex-disasm-target")`, mode + " instructions and target", 30000);
            if (mode === "arm64") {
                if (await ev(`document.querySelector(".hex-disasm-bytes").textContent`) !== "04 00 00 14") throw new Error("ARM instruction bytes changed order");
                await ev(`document.querySelector(".hex-disasm-target").click()`);
                await waitFor(`document.querySelector('.hex-byte[data-offset="16"]').classList.contains("selected")`, "ARM branch navigation");
                await ev(`document.querySelector(".hex-find-input").value = "fd 7b bf a9"; document.querySelector(".hex-find").requestSubmit()`);
                await waitFor(`${shown} === "stp x29, x30, [sp, #-0x10]!"`, "an ARM64 instruction with longer operands");
                const initialWidth = await panelSize("width");
                await dragInspector(-220, 0);
                resizedWidth = await panelSize("width");
                if (resizedWidth < initialWidth + 180) throw new Error(`the inspector did not widen: ${initialWidth} to ${resizedWidth}`);
                if (!(await ev(`(() => { const e = document.querySelector(".hex-disasm-text"); return e.clientWidth >= e.scrollWidth; })()`))) throw new Error("ARM64 operands are still truncated");
                await press("ArrowLeft");
                if (await panelSize("width") < resizedWidth + 15) throw new Error("the inspector divider cannot be resized with the keyboard");
                resizedWidth = await panelSize("width");
                await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
                try {
                    await waitFor(`document.querySelector(".hex-inspector-resize").getAttribute("aria-orientation") === "horizontal"`, "the stacked inspector divider");
                    const height = await panelSize("height");
                    await dragInspector(0, -60);
                    if (await panelSize("height") < height + 25) throw new Error("the stacked inspector did not grow taller");
                    if (await ev(`document.querySelector(".hex-pane").getBoundingClientRect().height`) < 90) throw new Error("the inspector hid the bytes");
                } finally {
                    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
                }
                await waitFor(`document.querySelector(".hex-inspector-resize").getAttribute("aria-orientation") === "vertical"`, "the side inspector divider restored");
            }
        }
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!document.querySelector(".hex-dump.editing") && ${shown} === "b 0x50"`, "MIPS while editing bytes");
        await ev(`document.querySelector(".hex-disasm-lines li").click()`);
        if (await ev(`!!document.querySelector(".hex-disasm-input") || document.querySelector(".hex-disasm").classList.contains("editable")`)) throw new Error("MIPS entered the x86 instruction editor");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await preview();
        if (await ev(`document.querySelector(".hex-disasm-bitness").value`) !== "mips64-be") throw new Error("the MIPS instruction set wasn't remembered");
        await waitFor(`Math.abs(document.querySelector(".hex-inspector").getBoundingClientRect().width - ${resizedWidth}) <= 2`, "the resized inspector width remembered after reopening");
        await ev(`document.querySelector(".hex-inspector-resize").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
        if (await panelSize("width") >= resizedWidth - 100) throw new Error("the inspector divider did not reset");
        // Restore the default for other browser groups.
        await choose("x86-64");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        return "ARM64/A32/Thumb-2, MIPS32/64 LE/BE, branch links, guarded instruction editing; inspector dragging, keyboard resizing, mobile height, saved width and reset";
    });

}
