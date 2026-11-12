import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// SQLite previews: tables and views, rows paged as scrolled, sorted by the
// server, values as SQLite has them, the schema, the switch to its bytes
// and back; a database by its bytes when its name doesn't say; a file
// named as one that isn't, in hex.
export async function checkSQLite(checks) {
    const { work, container, step, ev, waitFor, open, listed } = checks;
    await step("files: SQLite tables and views, paged and sorted by the server, its bytes and back", async () => {
        const file = `${work}/people.sqlite`;
        rmSync(file, { force: true });
        const db = new DatabaseSync(file);
        db.exec(`CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score INTEGER);
CREATE TABLE kinds(big TEXT, data BLOB, empty);
CREATE VIEW best AS SELECT name, score FROM people WHERE score > -3000;`);
        const insert = db.prepare("INSERT INTO people(name, score) VALUES (?, ?)");
        db.exec("BEGIN");
        for (let i = 0; i < 450; i++) insert.run(`person${i}`, -i * 1000);
        db.exec("COMMIT");
        db.prepare("INSERT INTO kinds VALUES (?, ?, NULL)").run("x".repeat(5000), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
        db.close();
        copyFileSync(file, `${work}/renamed.db`);
        writeFileSync(`${work}/fake.sqlite`, "not a database at all\n");
        for (const name of ["people.sqlite", "renamed.db", "fake.sqlite"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        const view = `document.querySelector("dialog.preview .sqlite-view")`;
        const cells = (r) => `[...${view}.querySelectorAll("tbody tr")[${r}].children].map(c => c.textContent)`;
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview closes");
        };
        const clickName = (name) => ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);

        await open("fs/#/media/", `${listed}.includes("people.sqlite") && ${listed}.includes("renamed.db") && ${listed}.includes("fake.sqlite")`, "the databases listed");
        const choose = (table) => ev(`(p => { p.value = ${JSON.stringify(table)}; p.dispatchEvent(new Event("change")); })(${view}.querySelector("select.sqlite-table"))`);
        await clickName("people.sqlite");
        // The first table, by name, to begin with.
        await waitFor(`${view}?.querySelector("select.sqlite-table").value === "kinds" && ${view}.querySelectorAll("tbody tr").length === 1`, "the first table");
        await choose("people");
        await waitFor(`${view}.querySelectorAll("tbody tr").length === 200`, "the first page of rows");
        // A column made wider (→, as a drag would), then fitted again (a
        // double click on its handle).
        const nameHead = `[...${view}.querySelectorAll("thead th")].find(t => t.textContent.startsWith("name"))`;
        const fitted = await ev(`${nameHead}.getBoundingClientRect().width`);
        await ev(`(h => { for (let i = 0; i < 5; i++) h.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); })(${nameHead}.querySelector(".col-resize"))`);
        await waitFor(`Math.abs(${nameHead}.getBoundingClientRect().width - ${fitted} - 100) < 2`, "the name column 100px wider");
        await ev(`${nameHead}.querySelector(".col-resize").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
        await waitFor(`Math.abs(${nameHead}.getBoundingClientRect().width - ${fitted}) < 2`, "the name column fitted again");
        const rowidHead = `${view}.querySelector("thead th.row-number")`;
        const rowidWidth = await ev(`${rowidHead}.getBoundingClientRect().width`);
        await ev(`(h=>{for(let i=0;i<5;i++)h.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));})(${rowidHead}.querySelector(".col-resize"))`);
        await waitFor(`Math.abs(${rowidHead}.getBoundingClientRect().width-${rowidWidth}-100)<2 && Math.abs(${view}.querySelector("tbody th.row-number").getBoundingClientRect().width-${rowidHead}.getBoundingClientRect().width)<2`, "rowid header and cells resized together");
        await ev(`${rowidHead}.querySelector(".col-resize").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))`);
        await waitFor(`Math.abs(${rowidHead}.getBoundingClientRect().width-${rowidWidth})<2`, "rowid fitted again");
        // No more until they're scrolled to.
        await new Promise((r) => setTimeout(r, 500));
        if (await ev(`${view}.querySelectorAll("tbody tr").length`) !== 200) throw new Error("rows loaded before they were scrolled to");
        if (JSON.stringify(await ev(cells(1))) !== JSON.stringify(["2", "2", "person1", "-1000"])) throw new Error(`row 2: ${JSON.stringify(await ev(cells(1)))}`);
        if (JSON.stringify(await ev(`[...${view}.querySelectorAll("thead th")].map(t => t.querySelector("button.col-name")?.textContent ?? t.textContent)`)) !== JSON.stringify(["rowid", "id", "name", "score"])) throw new Error("the column heads");
        await waitFor(`${view}.querySelector(".sqlite-count").textContent === "450 rows"`, "the row count");
        // Scrolled to the end: the rest, a page at a time.
        for (const n of [400, 450]) {
            await ev(`(s => s.scrollTop = s.scrollHeight)(${view}.querySelector(".table-scroll"))`);
            await waitFor(`${view}.querySelectorAll("tbody tr").length === ${n}`, `${n} rows`);
        }
        // Sorted by the server: of every row, not only those loaded.
        await ev(`[...${view}.querySelectorAll("thead button.col-name")].find(b => b.textContent.startsWith("score")).click()`);
        await waitFor(`${view}.querySelector("tbody tr td:last-child")?.textContent === "-449000"`, "sorted by score, ascending");
        await ev(`[...${view}.querySelectorAll("thead button.col-name")].find(b => b.textContent.startsWith("score")).click()`);
        await waitFor(`${view}.querySelector("tbody tr td:last-child")?.textContent === "0"`, "sorted by score, descending");
        // Sorted again and again, quickly: those given up on are ended, on
        // the server too, so the last is answered, not "busy".
        await ev(`(() => { const b = () => [...${view}.querySelectorAll("thead button.col-name")].find(b => b.textContent.startsWith("score")); for (let i = 0; i < 6; i++) b().click(); })()`);
        await waitFor(`${view}.querySelector("tbody tr td:last-child")?.textContent === "0" && ${view}.querySelectorAll("tbody tr").length === 200`, "the last of many sorts");
        if (await ev(`!!${view}.querySelector(".sqlite-more .error")`)) throw new Error(`many sorts: ${await ev(`${view}.querySelector(".sqlite-more").textContent`)}`);
        // Filtered by the server, as the CSV table filters: a column's
        // condition (a number), the rows' search, both, then neither.
        const head = (n) => `[...${view}.querySelectorAll("thead th")].find(t => t.textContent.startsWith(${JSON.stringify(n)}))`;
        if (!(await ev(`${head("score")}.querySelector("button.col-filter svg") !== null`))) throw new Error("SQLite filter funnel missing");
        await ev(`${head("score")}.querySelector("button.col-filter").click()`);
        await ev(`(p=>{p.querySelector("input.filter-value").value="99999";p.querySelector("button.filter-close").click();})(${view}.querySelector(".table-filter-pop"))`);
        await waitFor(`${view}.querySelector(".table-filter-pop").hidden && !${head("score")}.querySelector("button.col-filter").classList.contains("active")`, "SQLite filters closed without applying draft");
        await ev(`${head("score")}.querySelector("button.col-filter").click()`);
        await ev(`(p => { p.querySelector("select.filter-op").value = "≥"; p.querySelector("input.filter-value").value = "-2000"; p.querySelector("button.primary").click(); })(${view}.querySelector(".table-filter-pop"))`);
        await waitFor(`${view}.querySelectorAll("tbody tr").length === 3 && ${view}.querySelector(".sqlite-count").textContent === "3 of 450 rows"`, "rows with score ≥ -2000");
        if (!(await ev(`${head("score")}.querySelector("button.col-filter").classList.contains("active") && ${view}.querySelector(".table-clear-filters").textContent === "Clear the filter"`))) throw new Error("the filter isn't shown as on");
        const typeSearch = (text) => ev(`(s => { s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event("input")); })(${view}.querySelector("input.sqlite-search"))`);
        await typeSearch("person44");
        await waitFor(`${view}.querySelector(".sqlite-more").textContent === "No rows match." && ${view}.querySelector(".sqlite-count").textContent === "0 of 450 rows"`, "both: none");
        await ev(`${view}.querySelector(".table-clear-filters").click()`);
        await waitFor(`${view}.querySelectorAll("tbody tr").length === 200 && ${view}.querySelector(".sqlite-count").textContent === "450 rows"`, "neither: all");
        await typeSearch("PERSON44");
        await waitFor(`${view}.querySelectorAll("tbody tr").length === 11 && ${view}.querySelector(".sqlite-count").textContent === "11 of 450 rows"`, "the search alone: person44, and 440 to 449");
        await ev(`${view}.querySelector(".table-clear-filters").click()`);
        await waitFor(`${view}.querySelectorAll("tbody tr").length === 200`, "unfiltered again");
        // The schema; another table's values; a view.
        await ev(`${view}.querySelector(".sqlite-schema-toggle").click()`);
        if (!(await ev(`${view}.querySelector(".sqlite-sql").textContent.includes("CREATE TABLE people")`))) throw new Error("the schema");
        await choose("kinds");
        await waitFor(`${view}.querySelectorAll("tbody tr").length === 1`, "the kinds table");
        const kinds = await ev(cells(0));
        if (kinds[1].length !== 2001 || !kinds[1].endsWith("…") || kinds[2] !== "blob, 4 bytes: de ad be ef" || kinds[3] !== "NULL") throw new Error(`values: ${JSON.stringify(kinds).slice(0, 200)}`);
        await choose("best");
        await waitFor(`${view}.querySelectorAll("tbody tr").length === 3 && ${view}.querySelector("thead th").textContent === "#"`, "the view's rows");
        // Its bytes, and back to its tables.
        const toggle = `document.querySelector("dialog.preview button.preview-mode-toggle")`;
        if (await ev(`${toggle}.hidden || ${toggle}.title !== "Show binary view"`)) throw new Error("no switch to its bytes");
        await ev(`${toggle}.click()`);
        await waitFor(`document.querySelector("dialog.preview .hex-dump .hex-byte")?.textContent === "53" && ${toggle}.title === "Show tables"`, "its bytes");
        // Interpreted as SQLite already.
        await waitFor(`!document.querySelector("dialog.preview .kaitai-structure").hidden && /sqlite3/i.test(document.querySelector("dialog.preview input[aria-label='Binary format']").value)`, "the sqlite3 decoder chosen");
        await ev(`${toggle}.click()`);
        await waitFor(`${view}?.querySelector("select.sqlite-table").value === "kinds" && ${view}.querySelectorAll("tbody tr").length === 1`, "its tables again");
        await close();

        // By its bytes, though named .db; and one named .sqlite that isn't.
        await clickName("renamed.db");
        await waitFor(`${view}?.querySelectorAll("tbody tr").length === 1`, "a .db database's tables");
        await close();
        await clickName("fake.sqlite");
        await waitFor(`!!document.querySelector("dialog.preview .hex-dump")`, "a file named as a database that isn't one, in hex");
        await close();
        execFileSync("docker", ["exec", container, "rm", "/home/user/Downloads/media/people.sqlite", "/home/user/Downloads/media/renamed.db", "/home/user/Downloads/media/fake.sqlite"]);
        // Back where the next check expects the page to be.
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
    });
}
