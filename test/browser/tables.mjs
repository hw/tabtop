import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export async function checkCells(checks) {
    const { work, container, inContainer, step, ev, waitFor, click, type, open, listed, row, answer, status } = checks;
    await step("files: edit CSV and TSV cells", async () => {
        const original = '\ufeffsep=;\r\nname;note;score\r\nAlice;"hello\r\nworld";10\r\nBob;plain;2\r\n';
        for (const [name, text] of [["edit.csv", original], ["edit.tsv", "name\tvalue\nA\told"], ["broken.csv", 'name,value\nA,"open'],
            ["space.csv", "name age\nAlice 10\nBob 20\n"],
            ["expanded.csv", "name,value\n" + Array.from({ length: 2000 }, (_, i) => `row${i},1`).join("\n")],
            ["directive.csv", "title\nAlice\n"], ["literal-bom.csv", '"\ufeffaccount",balance\nAlice,10\n'],
            ["pending.csv", "name,value\nAlice,10\nBob,20\n"], ["pending.txt", "value=10\nother=20\n"]]) {
            writeFileSync(`${work}/${name}`, text);
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        const openTable = async (name, prepare = async () => {}) => {
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview .table-view")`, "the table");
            await prepare();
            await ev(`document.querySelector("dialog.preview button.edit").click()`);
            await waitFor(`!!document.querySelector("dialog.preview .table-editor")`, "the cell editor");
        };
        const cell = (name, column) => `[...document.querySelectorAll("dialog.preview tbody tr")].find((tr) => tr.children[1].textContent === ${JSON.stringify(name)}).children[${column + 1}]`;
        const change = async (name, column, value, key = "Enter") => {
            await ev(`${cell(name, column)}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
            await waitFor(`!!document.querySelector("textarea.table-cell-editor")`, "the cell's textarea");
            await ev(`(() => { const b = document.querySelector("textarea.table-cell-editor"); b.value = ${JSON.stringify(value)};
                b.dispatchEvent(new Event("input")); b.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })); })()`);
            await waitFor(`!document.querySelector("textarea.table-cell-editor")`, "the cell committed or cancelled");
        };
        const save = () => ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        const status = `document.querySelector("dialog.preview .edit-status")?.textContent`;
        const read = (name) => Buffer.from(inContainer("python3", "-c", `import base64; print(base64.b64encode(open('/home/user/Downloads/media/${name}', 'rb').read()).decode())`), "base64").toString("utf8");
        await openTable("edit.csv");
        await ev(`[...document.querySelectorAll("dialog.preview button.col-name")].find((b) => b.textContent === "score").click()`);
        await waitFor(`document.querySelector("dialog.preview tbody tr").children[1].textContent === "Bob"`, "Bob sorted first");
        await change("Bob", 2, "20");
        await waitFor(`document.querySelector("dialog.preview tbody tr").children[1].textContent === "Alice"`, "the edited score, sorted again");
        const value = 'new;"value"\nnext';
        await change("Bob", 1, value);
        await change("Alice", 2, "999", "Escape");
        await save();
        await waitFor(`${status} === "Saved."`, "the table saved");
        let expected = '\ufeffsep=;\r\nname;note;score\r\nAlice;"hello\r\nworld";10\r\nBob;"new;""value""\nnext";20\r\n';
        if (read("edit.csv") !== expected) {
            throw new Error(`saved CSV: ${JSON.stringify(read("edit.csv"))}`);
        }
        // Filtered edits still change the original record, not its visible position.
        await ev(`(() => { const f = document.querySelector("dialog.preview input.table-filter"); f.value = "Bob"; f.dispatchEvent(new Event("input")); })()`);
        await waitFor(`document.querySelectorAll("dialog.preview tbody tr").length === 1`, "Bob filtered");
        await change("Bob", 2, "21");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!!document.querySelector("dialog:not(.preview)[open]")`, "unsaved cell changes asked about");
        await ev(`document.querySelector("dialog:not(.preview)[open] .buttons button:not(.primary)").click()`);
        await waitFor(`!!document.querySelector("dialog.preview .table-editor")`, "still editing");
        await save();
        await waitFor(`${status} === "Saved."`, "the filtered edit saved");
        expected = expected.replace(';20\r\n', ';21\r\n');
        if (read("edit.csv") !== expected) {
            throw new Error("the filtered edit changed the wrong record");
        }
        await change("Bob", 2, "22");
        // A concurrent writer wins; the table must not overwrite it.
        inContainer("sh", "-c", "printf '\\nexternal' >> ~/Downloads/media/edit.csv");
        await save();
        await waitFor(`${status}?.startsWith("Not saved:")`, "the stale table save refused");
        if (read("edit.csv") !== expected + "\nexternal") {
            throw new Error("the concurrent CSV change was overwritten");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await answer();
        await waitFor(`!document.querySelector("dialog.preview")`, "discarded changes");
        await openTable("edit.tsv");
        await ev(`${cell("A", 1)}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
        await waitFor(`!!document.querySelector("textarea.table-cell-editor")`, "the TSV cell's textarea");
        await ev(`(() => { const b = document.querySelector("textarea.table-cell-editor"); b.value = "new\\tvalue";
            b.dispatchEvent(new Event("input")); b.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })); })()`);
        await waitFor(`${status} === "Saved."`, "the TSV saved");
        if (read("edit.tsv") !== 'name\tvalue\nA\t"new\tvalue"') {
            throw new Error("the TSV delimiter or final newline changed");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the TSV closed");
        await openTable("broken.csv");
        if (await ev(`document.querySelectorAll("dialog.preview td.editable-cell").length || !document.querySelector("dialog.preview button.save-edit").disabled`)) {
            throw new Error("malformed CSV allowed cell editing");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the malformed CSV closed");

        // Entering and leaving Edit keeps the chosen split and headings.
        const count = `document.querySelector("dialog.preview .table-count")?.textContent`;
        await openTable("space.csv", async () => {
            await ev(`(() => { const s = document.querySelector(".table-delimiter"); s.value = " "; s.dispatchEvent(new Event("change"));
                const h = document.querySelector(".table-bar label.check input"); h.checked = false; h.dispatchEvent(new Event("change")); })()`);
            await waitFor(`${count} === "3 rows × 2 columns"`, "the manual split and headings");
        });
        await waitFor(`${count} === "3 rows × 2 columns" && document.querySelector(".table-delimiter").value === " "`, "the same split in Edit");
        await change("Alice", 1, "11");
        await save();
        await waitFor(`${status} === "Saved."`, "the space-separated file saved");
        if (read("space.csv") !== "name age\nAlice 11\nBob 20\n") {
            throw new Error("the chosen delimiter wasn't used to save");
        }
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector(".table-editor") && ${count} === "3 rows × 2 columns"`, "the same table after Done");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the space-separated table closed");

        // A cell in a later batch stays visible and focused after committing.
        await openTable("expanded.csv");
        await ev(`document.querySelector("dialog.preview button.table-more").click()`);
        await waitFor(`document.querySelectorAll("dialog.preview tbody tr").length === 2000`, "all 2,000 rows expanded");
        await change("row1500", 1, "2");
        await waitFor(`document.querySelectorAll("dialog.preview tbody tr").length === 2000
            && document.activeElement === ${cell("row1500", 1)} && document.activeElement.textContent === "2"`, "the later edited row stays visible and focused");
        await save();
        await waitFor(`${status} === "Saved."`, "the expanded table saved");
        if (read("expanded.csv").split("\n")[1501] !== "row1500,2") {
            throw new Error("the later row wasn't saved");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the expanded table closed");

        // Literal sep= text in the first record must survive reopening.
        await openTable("directive.csv", async () => {
            await ev(`(() => { const h = document.querySelector(".table-bar label.check input"); h.checked = false; h.dispatchEvent(new Event("change")); })()`);
        });
        await change("title", 0, "sep=:");
        await save();
        await waitFor(`${status} === "Saved."`, "the literal directive saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector(".table-editor") && ${count} === "2 rows × 1 column"
            && document.querySelector("dialog.preview tbody tr").children[1].textContent === "sep=:"`, "the first record retained");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the literal directive table closed");

        await openTable("literal-bom.csv");
        await change("Alice", 1, "11");
        await save();
        await waitFor(`${status} === "Saved."`, "the literal BOM saved");
        if (read("literal-bom.csv") !== '"\ufeffaccount",balance\nAlice,11\n') {
            throw new Error("a cell's literal U+FEFF was converted to a file BOM");
        }
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector(".table-editor") && document.querySelector("button.col-name")?.textContent === "\ufeffaccount"`, "the literal BOM retained after reopening");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the literal BOM table closed");

        // Hold only the first upload's completion reply, after the server has
        // saved it. Reopening an editor must retain its older snapshot version.
        for (const name of ["pending.csv", "pending.txt"]) {
            const csv = name.endsWith(".csv");
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "the Edit button");
            await ev(`document.querySelector("dialog.preview button.edit").click()`);
            await waitFor(`!!document.querySelector(${JSON.stringify(csv ? ".table-editor" : "textarea.editor")})`, "the first editor");
            await ev(`import("/tabtop/tunnel.js").then(({ Tunnel }) => {
                const original = Tunnel.open; let held = false;
                window.restorePendingSave = () => { Tunnel.open = original; window.releasePendingSave?.(); };
                Tunnel.open = async function (req, ...args) {
                    const t = await original.call(this, req, ...args);
                    if (!held && req.type === "upload" && req.name === ${JSON.stringify(name)}) {
                        held = true; const next = t.next.bind(t);
                        t.next = async () => {
                            const m = await next();
                            if (m?.text && JSON.parse(m.text).name) {
                                await new Promise((resolve) => { window.releasePendingSave = resolve; });
                            }
                            return m;
                        };
                    }
                    return t;
                };
            })`);
            try {
                if (csv) {
                    await change("Alice", 1, "11");
                } else {
                    await ev(`(() => { const b = document.querySelector("textarea.editor"); b.value = "value=11\\nother=20\\n"; b.dispatchEvent(new Event("input")); })()`);
                }
                await save();
                await waitFor(`typeof window.releasePendingSave === "function"`, "the first save's reply held");
                await ev(`document.querySelector("button.done-edit").click()`);
                await answer();
                await waitFor(`!document.querySelector(".table-editor, textarea.editor")`, "the first editor left");
                await ev(`document.querySelector("dialog.preview button.edit").click()`);
                await waitFor(`!!document.querySelector(${JSON.stringify(csv ? ".table-editor" : "textarea.editor")})`, "the older snapshot reopened");
                await ev(`(async () => { window.restorePendingSave(); await new Promise((r) => setTimeout(r, 0)); })()`);
                if (csv) {
                    await change("Bob", 1, "21");
                } else {
                    await ev(`(() => { const b = document.querySelector("textarea.editor"); b.value = "value=10\\nother=21\\n"; b.dispatchEvent(new Event("input")); })()`);
                }
                await save();
                await waitFor(`${status}?.startsWith("Not saved:")`, "the older editor's save refused");
                const expected = csv ? "name,value\nAlice,11\nBob,20\n" : "value=11\nother=20\n";
                if (read(name) !== expected) {
                    throw new Error(`${name}: the pending save was overwritten by an older editor`);
                }
                await ev(`document.querySelector("dialog.preview button.close").click()`);
                await answer();
                await waitFor(`!document.querySelector("dialog.preview")`, "the stale editor closed");
            } finally {
                await ev(`window.restorePendingSave?.(); delete window.restorePendingSave; delete window.releasePendingSave;`);
            }
        }
    });
}

export async function checkStructured(checks) {
    const { work, container, inContainer, step, cdp, ev, waitFor, click, type, open, listed, status, sleep } = checks;
    await step("files: CSV as a table, JSON as a tree", async () => {
        writeFileSync(`${work}/people.csv`, 'name,city,score\r\n"Smith, J","Paris\r\nFR",10\r\nDoe,Rome,9\r\nLee,Oslo,100\r\n');
        const items = Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `item ${i}` }));
        writeFileSync(`${work}/data.json`, JSON.stringify({ items, meta: { deep: { needle: "found" } } }));
        writeFileSync(`${work}/config.json`, '{"a":1,"b":[1,2]}\n');
        // More rows, and more lines that aren't JSON, than a call can take
        // arguments.
        writeFileSync(`${work}/many.csv`, "1,2\n".repeat(150000));
        writeFileSync(`${work}/bad.jsonl`, "x\n".repeat(150000));
        // 500 lists of 500, opened; and 20,000 items, the last found.
        writeFileSync(`${work}/wide.json`, JSON.stringify(Array.from({ length: 500 }, () => Array(500).fill(0))));
        writeFileSync(`${work}/long.json`, JSON.stringify(Array.from({ length: 20000 }, (_, i) => `entry ${i}`)));
        // A graph as Python's json.dump(indent=2) writes one: about 1 MB,
        // 46,000 lines, laid out already.
        writeFileSync(`${work}/graph.json`, JSON.stringify({ directed: true, multigraph: true, graph: {},
            nodes: Array.from({ length: 4000 }, (_, i) => ({ type: "speaker", label: `SPEAKER_${i}`, talk_seconds: i * 1.5, id: `sp:SPEAKER_${i}` })),
            links: Array.from({ length: 4000 }, (_, i) => ({ source: `sp:SPEAKER_${i}`, target: `sp:SPEAKER_${(i * 7) % 4000}`, key: 0, weight: i % 13 })) }, null, 2));
        for (const f of ["people.csv", "data.json", "config.json", "many.csv", "bad.jsonl", "wide.json", "long.json", "graph.json"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${f}`, `${container}:/home/user/Downloads/media/${f}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${f}`]);
        }
        const openFile = async (name, ready, what) => {
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(ready, what);
        };
        const closePreview = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        };

        // The CSV: a table, the quoted comma and line break in their cells.
        const cells = `[...document.querySelectorAll("dialog.preview .table-scroll tbody tr")].map((tr) => [...tr.children].slice(1).map((td) => td.textContent))`;
        const tableCount = `document.querySelector("dialog.preview .table-count")?.textContent`;
        await openFile("people.csv", `${tableCount} === "3 rows × 3 columns"`, "the CSV as a table");
        const first = await ev(cells);
        if (JSON.stringify(first) !== JSON.stringify([["Smith, J", "Paris\r\nFR", "10"], ["Doe", "Rome", "9"], ["Lee", "Oslo", "100"]])) {
            throw new Error(`the table: ${JSON.stringify(first)}`);
        }
        const sortBy = (heading) => ev(`[...document.querySelectorAll("dialog.preview thead th button")].find((b) => b.firstChild.textContent === ${JSON.stringify(heading)}).click()`);
        const scores = `${cells}.map((r) => r[2]).join()`;
        await sortBy("score");
        await waitFor(`${scores} === "9,10,100"`, "sorted by score, as numbers");
        await sortBy("score");
        await waitFor(`${scores} === "100,10,9"`, "sorted by score, the other way");
        await ev(`(() => { const f = document.querySelector("dialog.preview input.table-filter"); f.value = "rome"; f.dispatchEvent(new Event("input")); })()`);
        await waitFor(`${tableCount} === "1 of 3 rows × 3 columns" && ${cells}[0][0] === "Doe"`, "filtered to Rome");
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`document.querySelector("dialog.preview .body pre")?.textContent.includes('"Smith, J"')`, "the CSV as text");
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`!!document.querySelector("dialog.preview .table-view")`, "the table again");
        // Each column filtered by value, as its type is; then all cleared.
        const column = (heading) => `[...document.querySelectorAll("dialog.preview thead tr.heads th")].find((th) => th.querySelector(".col-name")?.textContent === ${JSON.stringify(heading)})`;
        if (!(await ev(`${column("score")}.querySelector("button.col-filter svg") !== null`))) throw new Error("CSV filter funnel missing");
        const beforeFilterClose = await ev(tableCount);
        await ev(`${column("score")}.querySelector("button.col-filter").click()`);
        await ev(`(p=>{p.querySelector("input.filter-value").value="99999";p.querySelector("button.filter-close").click();})(document.querySelector("dialog.preview .table-filter-pop"))`);
        await waitFor(`document.querySelector("dialog.preview .table-filter-pop").hidden`, "CSV filter popup closed");
        if (await ev(tableCount) !== beforeFilterClose) throw new Error("closing CSV filters applied the draft");
        const filterBy = async (heading, op, value) => {
            await ev(`${column(heading)}.querySelector("button.col-filter").click()`);
            await waitFor(`!document.querySelector("dialog.preview .table-filter-pop").hidden`, `${heading}'s filter`);
            await ev(`(() => { const p = document.querySelector("dialog.preview .table-filter-pop");
                p.querySelector("select.filter-op").value = ${JSON.stringify(op)}; p.querySelector("input.filter-value").value = ${JSON.stringify(value)};
                p.querySelector("button.primary").click(); })()`);
        };
        await filterBy("score", ">", "9");
        await waitFor(`${tableCount} === "2 of 3 rows × 3 columns" && ${scores} === "10,100"`, "scores over 9");
        await filterBy("name", "starts", "s");
        await waitFor(`${tableCount} === "1 of 3 rows × 3 columns" && ${cells}[0][0] === "Smith, J" &&
            ${column("name")}.querySelector("button.col-filter").classList.contains("active") && !!${column("name")}.querySelector("button.col-filter svg")`, "names starting s, scores over 9");
        await ev(`document.querySelector("dialog.preview button.table-clear-filters").click()`);
        await waitFor(`${tableCount} === "3 rows × 3 columns"`, "the filters cleared");
        // Several conditions on one column (a range).
        await ev(`${column("score")}.querySelector("button.col-filter").click()`);
        await waitFor(`!document.querySelector("dialog.preview .table-filter-pop").hidden`, "score's filter");
        await ev(`(() => { const p = document.querySelector("dialog.preview .table-filter-pop");
            p.querySelector("select.filter-op").value = "≥"; p.querySelector("input.filter-value").value = "9";
            p.querySelector("button.filter-add").click();
            const rows = p.querySelectorAll(".filter-row");
            rows[1].querySelector("select.filter-op").value = "≤"; rows[1].querySelector("input.filter-value").value = "10";
            p.querySelector("button.primary").click(); })()`);
        await waitFor(`${tableCount} === "2 of 3 rows × 3 columns" && ${scores} === "10,9" &&
            document.querySelector("dialog.preview button.table-clear-filters").textContent === "Clear 2 filters"`, "scores from 9 to 10");
        await ev(`document.querySelector("dialog.preview button.table-clear-filters").click()`);
        await waitFor(`${tableCount} === "3 rows × 3 columns"`, "the range cleared");
        // A number's filter takes only a number.
        await filterBy("score", "<", "ten");
        await waitFor(`document.querySelector("dialog.preview .filter-why")?.textContent === "That's not a number."`, "a number asked for");
        await ev(`document.querySelector("dialog.preview .table-filter-pop").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        // Statistics, of the rows shown: chosen, and kept.
        if (await ev(`document.querySelector("input.table-stats-on").checked || !!document.querySelector(".table-stats-choice input:checked")`)) {
            throw new Error("statistics aren't all off by default");
        }
        await ev(`(() => { const b = document.querySelector("dialog.preview input.table-stats-on"); b.click(); })()`);
        const alignment = await ev(`(() => {
            const bar = document.querySelector(".table-bar"), r = bar.getBoundingClientRect();
            const summary = bar.querySelector(".table-summary").getBoundingClientRect();
            const choices = document.querySelector(".table-stats-choice").getBoundingClientRect();
            const labels = [...document.querySelectorAll(".table-stats-choice label")].map((l) => l.getBoundingClientRect());
            return { right: Math.abs(summary.right - (r.right - parseFloat(getComputedStyle(bar).paddingRight))),
                center: Math.abs((labels[0].left + labels.at(-1).right) / 2 - (choices.left + choices.right) / 2) };
        })()`);
        if (alignment.right > 1 || alignment.center > 1) {
            throw new Error(`table controls aren't aligned: ${JSON.stringify(alignment)}`);
        }
        if (await ev(`!!document.querySelector("dialog.preview tr.stats")`)) {
            throw new Error("statistics were shown before choosing any");
        }
        await ev(`[...document.querySelectorAll(".table-stats-choice label")].filter((l) => ["Sum", "Average", "Max", "Unique"].includes(l.textContent.trim()))
            .forEach((l) => l.querySelector("input").click())`);
        const stat = (key) => `[...document.querySelectorAll("dialog.preview tr.stat-${key} td")].map((td) => td.textContent)`;
        await waitFor(`${stat("sum")}.join() === ",,119" && ${stat("mean")}.join() === ",,39.6666666667" && ${stat("unique")}.join() === "3,3,3"`, "the statistics");
        if (!JSON.parse(await ev(`localStorage.getItem("tabtop.table-stats")`)).on) {
            throw new Error("statistics on wasn't kept");
        }
        // Of the rows filtered in, only; how many, in the corner.
        const corner = `document.querySelector("dialog.preview th.corner").textContent`;
        if (await ev(corner) !== "3 rows") {
            throw new Error(`the corner says ${await ev(corner)}`);
        }
        await filterBy("score", "<", "50");
        await waitFor(`${stat("sum")}.join() === ",,19" && ${stat("max")}.join() === ",,10" && ${corner} === "2 of 3"`, "the statistics of the rows filtered in");
        await ev(`document.querySelector("dialog.preview button.table-clear-filters").click()`);
        await waitFor(`${stat("sum")}.join() === ",,119"`, "all the rows' again");
        // A column's width, dragged by its heading's handle; a double click
        // fits it again.
        const nameWidth = `${column("name")}.getBoundingClientRect().width`;
        const before = await ev(nameWidth);
        const handle = await ev(`(() => { const r = ${column("name")}.querySelector(".col-resize").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: handle[0], y: handle[1], button: "left", clickCount: 1 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle[0] + 150, y: handle[1], button: "left", buttons: 1 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle[0] + 150, y: handle[1], button: "left", clickCount: 1 });
        const after = await ev(nameWidth);
        if (Math.abs(after - before - 150) > 3) {
            throw new Error(`dragged 150 px wider, the column went from ${before} to ${after}`);
        }
        await ev(`${column("name")}.querySelector(".col-resize").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
        await waitFor(`Math.abs(${nameWidth} - ${before}) < 3`, "the column fitted again");
        await ev(`document.querySelector("dialog.preview input.table-stats-on").click()`);
        await waitFor(`!document.querySelector("dialog.preview tr.stats")`, "the statistics off");
        // Split another way, then as found.
        const splitBy = (d) => ev(`(() => { const s = document.querySelector("dialog.preview select.table-delimiter"); s.value = ${JSON.stringify(d)};
            s.dispatchEvent(new Event("change")); })()`);
        await splitBy(";");
        await waitFor(`${tableCount}?.endsWith("× 1 column")`, "split by semicolons: one column");
        await splitBy("");
        await waitFor(`${tableCount} === "3 rows × 3 columns"`, "split as found again");
        await closePreview();
        await openFile("many.csv", `${tableCount} === "150,000 rows × 2 columns" && document.querySelectorAll("dialog.preview tbody tr").length === 1000`,
            "150,000 rows, the first 1,000 shown");
        await closePreview();
        await openFile("wide.json", `!!document.querySelector("dialog.preview .json-tree")`, "500 lists of 500");
        const wide = await ev(`document.querySelectorAll("dialog.preview .json-tree li").length`);
        if (wide > 2600) {
            throw new Error(`${wide} rows made to open 500 lists of 500`);
        }
        await closePreview();
        await openFile("long.json", `!!document.querySelector("dialog.preview .json-tree")`, "20,000 items");
        const started = Date.now();
        await ev(`(() => { const f = document.querySelector("dialog.preview input.json-search"); f.value = "entry 19999";
            f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await waitFor(`document.querySelector("dialog.preview .json-line.current .hit")?.textContent === '"entry 19999"'`, "the last of 20,000, found", 15000);
        const took = Date.now() - started;
        // Made: the first rows, and a few around it, not all before it.
        const around = await ev(`({ rows: document.querySelectorAll("dialog.preview .json-tree li:not(.more)").length,
            gaps: [...document.querySelectorAll("dialog.preview .json-tree li.more")].map((li) => li.textContent) })`);
        if (around.rows > 700 || !around.gaps.some((g) => g.includes("not shown here"))) {
            throw new Error(`to show the last of 20,000: ${JSON.stringify(around)}`);
        }
        await closePreview();
        await openFile("bad.jsonl", `document.querySelector("dialog.preview .json-errors")?.textContent.startsWith("150,000 lines aren't JSON")`,
            "150,000 lines that aren't JSON, said");
        await closePreview();

        // The JSON: a tree; a match in its 1,200 items past those made yet,
        // and one deep down, unfolded to.
        const current = `document.querySelector("dialog.preview .json-line.current")`;
        await openFile("data.json", `!!document.querySelector("dialog.preview .json-tree")`, "the JSON as a tree");
        const made = await ev(`document.querySelectorAll("dialog.preview .json-tree li").length`);
        if (made > 600) {
            throw new Error(`${made} rows made to start`);
        }
        const search = (q) => ev(`(() => { const f = document.querySelector("dialog.preview input.json-search"); f.value = ${JSON.stringify(q)};
            f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await search("item 1100");
        await waitFor(`${current}?.querySelector(".hit")?.textContent === '"item 1100"' && document.querySelector("dialog.preview .json-found").textContent === "1 of 1"`,
            "item 1100, past the first 500");
        await search("needle");
        await waitFor(`${current}?.querySelector(".json-key.hit")?.textContent === "needle"`, "the needle, deep down");
        await ev(`document.querySelector("dialog.preview .json-bar button.json-fold-all").click()`);
        await waitFor(`[...document.querySelectorAll("dialog.preview .json-tree > li > ul")].every((u) => u.hidden)`, "all folded");
        await closePreview();

        // Editing JSON: laid out; broken, and saving it asks first.
        const box = `document.querySelector("dialog.preview textarea.editor")`;
        const status = `document.querySelector("dialog.preview .json-status")?.textContent ?? ""`;
        await openFile("config.json", `!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "config.json, with Edit");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${box} && (${status}) === "It's JSON."`, "the editor, checking");
        await ev(`document.querySelector("dialog.preview button.format").click()`);
        await waitFor(`${box}.value === '{\\n  "a": 1,\\n  "b": [\\n    1,\\n    2\\n  ]\\n}\\n'`, "the JSON laid out");
        await ev(`(() => { const b = ${box}; b.value = '{"a": }\\n'; b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`(${status}).startsWith("Not JSON: a value should be here")`, "the JSON found broken");
        await ev(`document.querySelector(".editor-error-jump").click()`);
        if (!await ev(`document.activeElement === ${box} && ${box}.selectionStart === 6 && ${box}.selectionEnd === 6`)) {
            throw new Error("the JSON error location did not focus its source column");
        }
        await ev(`(() => { const b = ${box}; b.value = '{\\n' + '\\n'.repeat(120) + '"a": }\\n'; b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`document.querySelector(".editor-error-jump")?.textContent === "line 122, column 6"`, "an error further down the file");
        await ev(`document.querySelector(".editor-error-jump").click()`);
        if (!await ev(`${box}.selectionStart === ${box}.value.indexOf("}") && ${box}.scrollTop > 0`)) {
            throw new Error("the JSON error jump did not scroll to the reported line");
        }
        await ev(`${box}.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }))`);
        const top = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
        await waitFor(`${top}?.textContent.includes("isn't JSON as it is now")`, "a question before saving it broken");
        await ev(`${top}.querySelector(".buttons button:not(.primary)").click()`);
        await waitFor(`!document.querySelector("dialog:not(.preview)[open]")`, "the question gone");
        await waitFor(`!document.querySelector(".save-edit").disabled && document.querySelector(".save-status").textContent === "Unsaved changes"`, "Save re-enabled after cancelling validation");
        await ev(`(() => { const b = ${box}; b.value = '{"a": 2}\\n'; b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`(${status}) === "It's JSON."`, "the JSON fixed");
        await ev(`document.querySelector(".save-edit").click()`);
        await waitFor(`document.querySelector("dialog.preview .edit-status")?.textContent === "Saved."`, "the fixed JSON saved");
        const saved = inContainer("cat", "/home/user/Downloads/media/config.json");
        if (saved !== '{"a": 2}') {
            throw new Error(`config.json holds ${JSON.stringify(saved)}`);
        }
        await closePreview();
        // A large JSON file, laid out already: Format leaves it, quickly,
        // and the page still answers after.
        await openFile("graph.json", `!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "graph.json, with Edit");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${box} && (${status}) === "It's JSON."`, "graph.json in the editor, checking", 30000);
        const graphLength = await ev(`${box}.value.length`);
        const formatStarted = Date.now();
        await ev(`document.querySelector("dialog.preview button.format").click()`);
        const formatTook = Date.now() - formatStarted;
        const answered = Date.now();
        await ev(`1`);
        await sleep(500);
        await ev(`1`);
        if (formatTook > 3000 || Date.now() - answered > 3000 || await ev(`${box}.value.length`) !== graphLength) {
            throw new Error(`Format on graph.json: ${formatTook} ms, then ${Date.now() - answered} ms to answer`);
        }
        // Squeezed onto one line, as an edit might leave it: Format lays
        // it out again, in one undoable step, without holding the page up.
        await ev(`(() => { const b = ${box}; b.value = JSON.stringify(JSON.parse(b.value)); b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`${box}.value.length < ${graphLength} && (${status}) === "It's JSON."`, "graph.json squeezed", 30000);
        const relaidStarted = Date.now();
        await ev(`document.querySelector("dialog.preview button.format").click()`);
        const relaidTook = Date.now() - relaidStarted;
        const relaidAnswered = Date.now();
        await ev(`1`);
        await sleep(500);
        await ev(`1`);
        const relaid = await ev(`${box}.value.length`);
        if (relaidTook > 3000 || Date.now() - relaidAnswered > 3000 || relaid !== graphLength) {
            throw new Error(`Format on squeezed graph.json: ${relaidTook} ms, then ${Date.now() - relaidAnswered} ms to answer; ${relaid} characters, want ${graphLength}`);
        }
        // Ctrl+Z undoes that Format, and Ctrl+Shift+Z does it again.
        const keys = (shiftKey) => ev(`${box}.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: ${shiftKey}, bubbles: true, cancelable: true }))`);
        await keys(false);
        if (await ev(`${box}.value.length`) >= graphLength) {
            throw new Error("Ctrl+Z didn't undo Format");
        }
        await keys(true);
        if (await ev(`${box}.value.length`) !== graphLength) {
            throw new Error("Ctrl+Shift+Z didn't lay it out again");
        }
        await closePreview();
        inContainer("sh", "-c", "cd ~/Downloads/media && rm people.csv data.json config.json many.csv bad.jsonl wide.json long.json graph.json");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return `a CSV sorted, filtered by column and value, with statistics, and split another way, quotes and all; 150,000 rows; 500 lists of 500 opened in ${wide} rows; ` +
            `the last of 20,000 found in ${took} ms, ${around.rows} rows made; JSON searched past what's shown, and folded; JSON laid out, and asked about saving broken`;
    });
}
