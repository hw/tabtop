// The SQLite preview: a database's tables and views, and their rows a page
// at a time, asked of the server, which reads it with SQLite (see
// sqlite.go). Sorting a column, or filtering the rows (by column, as the
// CSV table does, or by what's in them), asks the server to, so it's of
// every row, not only those loaded.
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { resizeHandle, widthRule, MIN_WIDTH, MAX_WIDTH, FILTER_OPS, FILTER_KIND_NAMES, openFilterPopup } from "./table-view.js";

const PAGE = 200;          // rows asked for at a time
const MAX_SHOWN = 50_000;  // rows loaded into the page, at most
let views = 0;             // for each one's width rules

// columnKind is how a column declared as decl (its type in the schema,
// or "" for an expression's) is filtered: as a number, a date or text, as
// SQLite's own type affinities read it, dates (which it keeps as numbers
// or text) apart.
export function columnKind(decl = "") {
    const d = decl.toUpperCase();
    if (/DATE|TIME/.test(d)) return "date";
    if (/CHAR|CLOB|TEXT/.test(d) || d === "" || d.includes("BLOB")) return "text";
    return "number"; // INT, REAL, FLOA, DOUB, NUMERIC, DECIMAL, BOOLEAN…
}


// cellText is how a value (as sqlite.go sends it) shows: its text, a
// class, and a title saying more, if there's more.
export function cellText(v) {
    if (v == null) return { text: "NULL", className: "null" };
    if (v.i != null) return { text: v.i, className: "type-number" };
    if (v.r != null) return { text: typeof v.r === "number" ? String(v.r) : v.r.replace(/^\+/, ""), className: "type-number" };
    if (v.t != null) {
        return v.cut
            ? { text: `${v.t}…`, className: "cut", title: `${v.n.toLocaleString()} bytes; the first ${v.t.length.toLocaleString()} characters are shown` }
            : { text: v.t, className: "" };
    }
    if (v.b != null) {
        const head = v.b.match(/../g)?.join(" ") ?? "";
        return { text: `blob, ${v.n.toLocaleString()} byte${v.n === 1 ? "" : "s"}${head ? `: ${head}${v.n * 2 > v.b.length ? " …" : ""}` : ""}`, className: "blob" };
    }
    return { text: "", className: "" };
}

// sqliteView shows the database named name: schema, as the server
// describes it; wal, whether a -wal file beside it holds changes not
// shown; ask(question, signal), the server's answer to a question about
// it (aborting signal gives up on it, there too). Its stop() gives up on
// any still being asked.
export function sqliteView({ name, schema, wal = false, ask }) {
    const objects = schema.objects ?? [];
    const browsable = objects.filter((o) => o.type === "table" || o.type === "view");
    const pick = el("select", { className: "sqlite-table" });
    pick.setAttribute("aria-label", "Table or view");
    for (const [type, label] of [["table", "Tables"], ["view", "Views"]]) {
        const of = browsable.filter((o) => o.type === type);
        if (of.length) pick.append(el("optgroup", { label }, ...of.map((o) => el("option", { value: o.name, textContent: o.name }))));
    }
    const count = el("span", { className: "hint sqlite-count" });
    count.setAttribute("aria-live", "polite");
    const schemaToggle = el("button", { type: "button", className: "sqlite-schema-toggle", textContent: "Schema" });
    schemaToggle.setAttribute("aria-pressed", "false");
    const facts = [schema.encoding, schema.page_size && schema.page_count != null
        ? `${Number(schema.page_count).toLocaleString()} pages of ${Number(schema.page_size).toLocaleString()} bytes` : "",
    schema.wal_mode ? "WAL mode" : ""].filter(Boolean).join(" · ");
    // Rows with this in them (in a column, or any), as the CSV table's.
    const search = el("input", { type: "search", className: "table-filter sqlite-search", placeholder: "Filter rows", spellcheck: false, autocomplete: "off" });
    search.setAttribute("aria-label", "Show only rows with this in them");
    const searchIn = el("select", { className: "table-column" });
    searchIn.setAttribute("aria-label", "In which column");
    const clearFilters = el("button", { type: "button", className: "table-clear-filters", textContent: "Clear filters", hidden: true });
    const bar = el("div", { className: "table-bar sqlite-bar" }, pick, search, searchIn, clearFilters, count, schemaToggle,
        el("span", { className: "hint sqlite-facts", textContent: facts }));
    const notes = el("div", { className: "sqlite-notes" });
    if (wal) {
        notes.append(el("p", { className: "hint", textContent: `${name}-wal, beside it, holds changes not yet written into ${name}: they aren't shown.` }));
    }
    const sqlPanel = el("pre", { className: "sqlite-sql", hidden: true });
    const thead = el("thead");
    const tbody = el("tbody");
    const more = el("p", { className: "hint sqlite-more" });
    const scroll = el("div", { className: "table-scroll" }, el("table", {}, thead, tbody), more);
    // Columns' widths, as dragged (see resizeHandle): the table's, kept as
    // it's sorted or more rows come, forgotten when another's chosen.
    const widths = new Map();
    const widthRules = el("style");
    const id = `s${++views}`;
    const showWidths = () => { widthRules.textContent = [...widths].map(([c, w]) => widthRule(id, c, w)).join("\n"); };
    const pop = el("div", { className: "table-filter-pop", hidden: true });
    const view = el("div", { className: "sqlite-view" }, bar, notes, sqlPanel, scroll, pop, widthRules);
    view.dataset.table = id;

    if (!browsable.length) {
        bar.replaceChildren(el("span", { className: "hint", textContent: "This database has no tables or views." }), schemaToggle);
        scroll.hidden = true;
    }

    // What's shown: the table, its columns, rows so far, and where the
    // next page starts; each choice numbered, so a slow answer to an
    // earlier one is dropped.
    let current = null, columns = [], kinds = [], loaded = 0, after = null, done = false, loading = false;
    // The filters, by column: [{op, value}, …], all to match; and the total
    // of the table's rows, unfiltered, once known.
    const filters = new Map();
    let total = null;
    const filtering = () => filters.size > 0 || search.value !== "";
    // The filters as the server takes them (see sqliteFilter).
    const filtered = (q) => {
        const list = [...filters].flatMap(([column, fs]) => fs.map((f) => ({ column, type: kinds[column], op: f.op, value: f.value })));
        if (list.length) q.filters = list;
        if (search.value) {
            q.search = search.value;
            if (searchIn.value !== "") q.search_in = Number(searchIn.value);
        }
        return q;
    };
    let order = null, desc = false, asked = 0, stopped = false;
    // What's being asked: rows (given up on when they're asked for again,
    // sorted another way, say), and the count (when another table's
    // chosen); so the server stops too, and its slots are free.
    let rowsAsking = null, countAsking = null;

    const showSQL = () => {
        const o = objects.find((x) => x.name === current?.name);
        const related = objects.filter((x) => x.table === current?.name && x.sql);
        sqlPanel.textContent = [o?.sql, ...related.map((x) => x.sql)].filter(Boolean).map((s) => `${s};`).join("\n\n")
            || (o ? "(No SQL is kept for this.)" : "");
    };
    schemaToggle.addEventListener("click", () => {
        sqlPanel.hidden = !sqlPanel.hidden;
        schemaToggle.setAttribute("aria-pressed", String(!sqlPanel.hidden));
        if (!sqlPanel.hidden && !browsable.length) {
            sqlPanel.textContent = objects.map((o) => o.sql).filter(Boolean).map((s) => `${s};`).join("\n\n") || "(Empty.)";
        }
    });

    const heads = () => {
        const rowHead = el("th", { className: "row-number corner", textContent: current.rowid ? "rowid" : "#" });
        const resizer = (label, i) => resizeHandle(label, {
            width: (cell) => widths.get(i) ?? cell.getBoundingClientRect().width,
            set: (w) => { widths.set(i, Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)))); showWidths(); },
            fit: () => { widths.delete(i); showWidths(); },
        });
        rowHead.append(resizer(current.rowid ? "rowid" : "row number", -1));
        const cells = columns.map((c, i) => {
            const type = types[i] ?? "";
            const label = el("button", { type: "button", className: "col-name",
                textContent: c + (order === i ? (desc ? " ▾" : " ▴") : ""),
                title: `${type ? `${type}. ` : ""}Sort by ${c}${order === i ? (desc ? " (sorted descending; click for unsorted)" : " (sorted ascending; click for descending)") : ""}` });
            label.addEventListener("click", () => {
                if (order !== i) { order = i; desc = false; } else if (!desc) desc = true; else { order = null; desc = false; }
                reload();
            });
            const fs = filters.get(i);
            const how = fs?.length ? fs.map((f) => `${FILTER_OPS[kinds[i]][f.op]} ${f.value}`).join(" and ") : "";
            const funnel = el("button", { type: "button", className: `col-filter glyph${fs?.length ? " active" : ""}`,
                title: fs?.length ? `${c} ${how}: click to change` : `Filter by ${c} (as ${FILTER_KIND_NAMES[kinds[i]]})` });
            funnel.innerHTML = iconSVG("filter");
            funnel.setAttribute("aria-label", funnel.title);
            funnel.addEventListener("click", () => openFilter(i, funnel));
            const th = el("th", { className: `type-${kinds[i]}` }, el("div", { className: "col-head" }, label, funnel), resizer(c, i));
            if (order === i) th.setAttribute("aria-sort", desc ? "descending" : "ascending");
            return th;
        });
        thead.replaceChildren(el("tr", { className: "heads" }, rowHead, ...cells));
    };

    const loadMore = async () => {
        if (!current || current.error || !rowsAsking || loading || done || stopped) return;
        loading = true;
        const mine = asked;
        const signal = rowsAsking.signal;
        more.textContent = "Loading…";
        try {
            const q = filtered({ op: "rows", table: current.name, limit: PAGE });
            if (order != null) { q.order = order; q.desc = desc; }
            if (current.rowid && order == null) { if (after != null) q.after = after; } else q.offset = loaded;
            const got = await ask(q, signal);
            if (mine !== asked) return;
            if (!loaded) { setColumns(got.columns ?? [], got.types ?? []); heads(); }
            const rowids = got.rowids ?? null;
            const frag = document.createDocumentFragment();
            (got.rows ?? []).forEach((row, r) => {
                const label = rowids ? rowids[r] : String(loaded + r + 1);
                const tr = el("tr", {}, el("th", { className: "row-number", textContent: label }));
                for (const v of row) {
                    const { text, className, title } = cellText(v);
                    const td = el("td", { className, textContent: text });
                    if (title) td.title = title;
                    tr.append(td);
                }
                frag.append(tr);
            });
            tbody.append(frag);
            loaded += got.rows?.length ?? 0;
            if (rowids?.length) after = rowids.at(-1);
            done = !got.more || loaded >= MAX_SHOWN;
            more.textContent = !loaded ? (filtering() ? "No rows match." : "No rows.")
                : got.more && loaded >= MAX_SHOWN ? `The first ${loaded.toLocaleString()} rows are shown; sort to see others first.` : "";
            if (!done) queueMicrotask(checkMore);
        } catch (err) {
            if (mine !== asked) return;
            more.textContent = "";
            more.append(el("span", { className: "error", textContent: `Couldn't read ${current.name}: ${err.message} ` }));
            const retry = el("button", { type: "button", textContent: "Retry" });
            retry.addEventListener("click", () => { done = false; more.textContent = ""; loadMore(); });
            more.append(retry);
            done = true;
        } finally {
            if (mine === asked) loading = false;
        }
    };
    // More rows as the end comes near: within a few screens' worth of
    // rows. (Not before the grid's laid out, when every distance is 0.)
    const checkMore = () => {
        if (done || loading || !view.isConnected || !scroll.clientHeight) return;
        if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 600) loadMore();
    };
    scroll.addEventListener("scroll", checkMore, { passive: true });

    // types: the columns' declared types; kinds, how each is filtered.
    let types = [];
    const setColumns = (names, declared) => {
        const was = searchIn.value;
        columns = names;
        types = declared;
        kinds = names.map((_, i) => columnKind(declared[i]));
        searchIn.replaceChildren(el("option", { value: "", textContent: "Any column" }),
            ...names.map((n, i) => el("option", { value: String(i), textContent: n })));
        searchIn.value = was !== "" && Number(was) < names.length ? was : "";
    };
    const reload = () => {
        asked++;
        pop.hidden = true;
        const n = filters.size + (search.value ? 1 : 0);
        clearFilters.hidden = !n;
        clearFilters.textContent = n === 1 ? "Clear the filter" : `Clear ${n} filters`;
        rowsAsking?.abort();
        rowsAsking = new AbortController();
        loaded = 0; after = null; done = false; loading = false;
        tbody.replaceChildren();
        more.textContent = "";
        if (current) heads();
        return loadMore();
    };
    // recount says how many rows there are (as filtered, and of how many),
    // once the first are in: one question at a time.
    const rows = (n) => `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
    const recount = async () => {
        countAsking?.abort();
        const counting = countAsking = new AbortController();
        const table = current?.name;
        const still = () => countAsking === counting && current?.name === table && !stopped;
        try {
            if (total === null) {
                const got = await ask({ op: "count", table }, counting.signal);
                if (!still()) return;
                total = got.count;
            }
            if (!filtering()) {
                count.textContent = total < 0 ? "Many rows (counting them took too long)" : rows(total);
                return;
            }
            count.textContent = "Counting…";
            const got = await ask(filtered({ op: "count", table }), counting.signal);
            if (!still()) return;
            const of = total < 0 ? "" : ` of ${total.toLocaleString()}`;
            count.textContent = got.count < 0 ? `Many rows match${of ? ` (${of.trim()})` : ""}` : `${got.count.toLocaleString()}${of} rows`;
        } catch { if (still()) count.textContent = ""; }
    };
    // refilter shows the rows as the filters now leave them.
    const refilter = async () => {
        await reload();
        if (!stopped) recount();
    };
    const choose = async (table) => {
        current = browsable.find((o) => o.name === table) ?? null;
        order = null; desc = false;
        const shown = (current?.columns ?? []).filter((c) => !c.hidden);
        filters.clear();
        search.value = "";
        total = null;
        setColumns(shown.map((c) => c.name), shown.map((c) => c.type ?? ""));
        widths.clear();
        showWidths();
        showSQL();
        count.textContent = "";
        if (!current) return;
        countAsking?.abort();
        countAsking = null;
        if (current.error) {
            // Nothing more to ask of it: no rows loaded as it's scrolled.
            asked++;
            rowsAsking?.abort();
            rowsAsking = null;
            done = true; loading = false;
            thead.replaceChildren(); tbody.replaceChildren();
            more.textContent = `${current.name} can't be read: ${current.error}`;
            return;
        }
        await reload();
        if (current?.name !== table || stopped) return;
        recount();
    };

    // openFilter shows, by the button at, the filters of column c, to
    // change: one or more conditions for its kind, all to match (as the
    // CSV table's: see table-view.js).
    const openFilter = (c, at) => openFilterPopup({ pop, view, at, title: columns[c], kind: kinds[c], current: filters.get(c),
        onApply: (next) => {
            if (next.length) filters.set(c, next);
            else filters.delete(c);
            refilter();
        } });
    // A click elsewhere closes it.
    view.addEventListener("click", (e) => {
        if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.("button.col-filter")) pop.hidden = true;
    });
    // Typed in the search: asked once typing pauses.
    let typing = null;
    search.addEventListener("input", () => {
        clearTimeout(typing);
        typing = setTimeout(refilter, 300);
    });
    searchIn.addEventListener("change", () => { if (search.value) refilter(); });
    clearFilters.addEventListener("click", () => {
        filters.clear();
        search.value = "";
        refilter();
    });
    pick.addEventListener("change", () => choose(pick.value));
    view.sqlite = { choose, get table() { return current?.name ?? null; } };
    view.stop = () => {
        stopped = true;
        clearTimeout(typing);
        asked++;
        rowsAsking?.abort();
        countAsking?.abort();
    };
    if (browsable.length) {
        // The first table that isn't SQLite's own, if there is one.
        const first = browsable.find((o) => o.type === "table" && !o.name.startsWith("sqlite_")) ?? browsable[0];
        pick.value = first.name;
        choose(first.name);
    }
    return view;
}
