package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// sqliteFixture makes the test database: rows enough for pages, values of
// each kind (negative and 64-bit integers, an infinity, text and a blob on
// overflow pages), a WITHOUT ROWID table, a table with a column called
// rowid, a view, an index and a trigger.
func sqliteFixture(t *testing.T, file string) {
	t.Helper()
	var b strings.Builder
	b.WriteString(`PRAGMA journal_mode = DELETE;
CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score INTEGER);
CREATE INDEX people_score ON people(score);
CREATE TABLE kinds(i INTEGER, r REAL, t TEXT, b BLOB);
CREATE TABLE pairs(k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID;
CREATE TABLE shadow(rowid TEXT, _rowid_ TEXT, oid TEXT);
CREATE TABLE ties(k TEXT PRIMARY KEY, same INTEGER) WITHOUT ROWID;
CREATE VIEW top AS SELECT name, score FROM people WHERE score > -5000;
CREATE TRIGGER people_touch AFTER UPDATE ON people BEGIN SELECT 1; END;
BEGIN;
`)
	for i := range 1200 {
		fmt.Fprintf(&b, "INSERT INTO people(name, score) VALUES ('person%d', %d);\n", i, -i*1000)
	}
	b.WriteString(`INSERT INTO kinds VALUES (-9223372036854775808, 1e999, NULL, NULL);
INSERT INTO kinds VALUES (9223372036854775807, -1.5, printf('%.*c', 10000, 'x'), zeroblob(100000));
INSERT INTO kinds VALUES (NULL, NULL, 'héllo', x'00ff10');
INSERT INTO pairs VALUES ('b', 2), ('a', 1), ('c', 3);
INSERT INTO shadow VALUES ('x', 'y', 'z');
INSERT INTO ties VALUES ('c', 1), ('a', 1), ('b', 1);
COMMIT;
`)
	if err := sqliteExec(file, b.String()); err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteTunnel(t *testing.T) {
	g, srv := newE2EServer(t)
	// Longer than testCtx's: some 30 children are started, each slow to
	// start under the race detector.
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "data.sqlite")
	sqliteFixture(t, file)
	ask := func(name string, q *sqliteQuery) map[string]any {
		t.Helper()
		return openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: name, SQLite: q})
	}
	answer := func(r map[string]any) map[string]any {
		t.Helper()
		a, ok := r["answer"].(map[string]any)
		if !ok {
			t.Fatalf("no answer: %v", r)
		}
		return a
	}
	before, _ := os.ReadDir(g.downloadsDir)

	// The schema: tables first, then views, then the rest; columns, and
	// which tables page by rowid.
	r := ask("data.sqlite", nil)
	st, _ := os.Stat(file)
	if r["size"] != float64(st.Size()) || r["mtime"] != fileVersion(st) || r["wal"] != nil || r["wal_mode"] != nil {
		t.Fatalf("reply: %v", r)
	}
	a := answer(r)
	var objects []sqliteObject
	raw, _ := json.Marshal(a["objects"])
	json.Unmarshal(raw, &objects)
	var names []string
	byName := map[string]sqliteObject{}
	for _, o := range objects {
		names = append(names, o.Type+":"+o.Name)
		byName[o.Name] = o
	}
	want := []string{"table:kinds", "table:pairs", "table:people", "table:shadow", "table:ties", "view:top", "index:people_score", "trigger:people_touch"}
	if !slices.Equal(names, want) {
		t.Fatalf("objects: %v", names)
	}
	if p := byName["people"]; !p.Rowid || len(p.Columns) != 3 || p.Columns[0].Name != "id" || p.Columns[0].PK != 1 || !strings.Contains(p.SQL, "CREATE TABLE people") {
		t.Errorf("people: %+v", p)
	}
	if byName["pairs"].Rowid || byName["shadow"].Rowid || byName["top"].Rowid {
		t.Error("rowids claimed for a WITHOUT ROWID table, a table whose columns take every rowid name, or a view")
	}
	if byName["people_score"].Table != "people" || a["encoding"] != "UTF-8" || a["page_size"] == nil {
		t.Errorf("index or info: %+v %v", byName["people_score"], a)
	}

	// Rows a page at a time, by rowid.
	rows := func(q sqliteQuery) map[string]any {
		t.Helper()
		return answer(ask("data.sqlite", &q))
	}
	page := rows(sqliteQuery{Op: "rows", Table: "people", Limit: 500})
	got := page["rows"].([]any)
	keys := page["rowids"].([]any)
	if len(got) != 500 || page["more"] != true || keys[499] != "500" || !slices.Equal(anyStrings(page["columns"]), []string{"id", "name", "score"}) {
		t.Fatalf("first page: %d rows, more %v, last key %v, columns %v", len(got), page["more"], keys[len(keys)-1], page["columns"])
	}
	if c := got[1].([]any); c[1].(map[string]any)["t"] != "person1" || c[2].(map[string]any)["i"] != "-1000" {
		t.Errorf("row 2: %v", c)
	}
	after := "1000"
	last := rows(sqliteQuery{Op: "rows", Table: "people", Limit: 500, After: &after})
	if n := len(last["rows"].([]any)); n != 200 || last["more"] != false {
		t.Errorf("last page: %d rows, more %v", n, last["more"])
	}
	// Sorted by a column's position: the score's, descending (then by
	// rowid), from an offset.
	order := 2
	sorted := rows(sqliteQuery{Op: "rows", Table: "people", Limit: 2, Order: &order, Desc: true, Offset: 1})
	if s := sorted["rows"].([]any); s[0].([]any)[2].(map[string]any)["i"] != "-1000" || s[1].([]any)[2].(map[string]any)["i"] != "-2000" {
		t.Errorf("sorted: %v", s)
	}
	// Each kind of value: 64-bit integers as text, an infinity, NULL, text
	// and a blob cut short (with their sizes), and non-ASCII text.
	kinds := rows(sqliteQuery{Op: "rows", Table: "kinds"})["rows"].([]any)
	k0, k1, k2 := kinds[0].([]any), kinds[1].([]any), kinds[2].([]any)
	if k0[0].(map[string]any)["i"] != "-9223372036854775808" || k0[1].(map[string]any)["r"] != "+Inf" || k0[2] != nil || k0[3] != nil {
		t.Errorf("row 1: %v", k0)
	}
	text, blob := k1[2].(map[string]any), k1[3].(map[string]any)
	if k1[0].(map[string]any)["i"] != "9223372036854775807" || k1[1].(map[string]any)["r"] != -1.5 ||
		len(text["t"].(string)) != maxSQLiteText || text["cut"] != true || text["n"] != float64(10000) ||
		blob["b"] != strings.Repeat("00", maxSQLiteBlob) || blob["n"] != float64(100000) {
		t.Errorf("row 2: %v", k1)
	}
	if k2[2].(map[string]any)["t"] != "héllo" || k2[3].(map[string]any)["b"] != "00ff10" || k2[3].(map[string]any)["n"] != float64(3) {
		t.Errorf("row 3: %v", k2)
	}
	// No rowid to page by: by offset.
	pairs := rows(sqliteQuery{Op: "rows", Table: "pairs", Limit: 2, Offset: 1})
	if p := pairs["rows"].([]any); len(p) != 2 || p[0].([]any)[0].(map[string]any)["t"] != "b" || pairs["rowids"] != nil || pairs["more"] != false {
		t.Errorf("pairs: %v", pairs)
	}
	// Sorted, with no rowid: ties broken by the other columns, so pages
	// don't repeat or skip rows.
	zero := 1
	var seen []string
	for offset := int64(0); offset < 3; offset++ {
		p := rows(sqliteQuery{Op: "rows", Table: "ties", Order: &zero, Offset: offset, Limit: 1})["rows"].([]any)
		seen = append(seen, p[0].([]any)[0].(map[string]any)["t"].(string))
	}
	if !slices.Equal(seen, []string{"a", "b", "c"}) {
		t.Errorf("tied rows, a page each: %v", seen)
	}
	if sh := rows(sqliteQuery{Op: "rows", Table: "shadow"}); len(sh["rows"].([]any)) != 1 || sh["rowids"] != nil {
		t.Errorf("shadow: %v", sh)
	}
	if v := rows(sqliteQuery{Op: "rows", Table: "top", Limit: 3}); len(v["rows"].([]any)) != 3 || v["more"] != true {
		t.Errorf("view: %v", v)
	}
	// Counts.
	for table, n := range map[string]float64{"people": 1200, "pairs": 3, "top": 5} {
		if c := rows(sqliteQuery{Op: "count", Table: table}); c["count"] != n {
			t.Errorf("count of %s: %v", table, c)
		}
	}

	// Only tables and views it has, by their names: nothing else run.
	for _, bad := range []string{"nope", `people"; DROP TABLE people; --`, "people_score", "sqlite_schema"} {
		if r := ask("data.sqlite", &sqliteQuery{Op: "rows", Table: bad}); r["error"] == nil {
			t.Errorf("%q: %v", bad, r)
		}
	}
	bad := -1
	if r := ask("data.sqlite", &sqliteQuery{Op: "rows", Table: "people", Order: &bad}); r["error"] == nil {
		t.Errorf("a negative column: %v", r)
	}
	if r := ask("data.sqlite", &sqliteQuery{Op: "nope"}); r["error"] == nil {
		t.Errorf("an unknown question: %v", r)
	}
	// As the page read it, or not at all.
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: "data.sqlite", IfMtime: "1-1", IfSize: st.Size()}); r["error"] == nil {
		t.Errorf("an old version: %v", r)
	}
	// Nothing written beside it, nor changed in it.
	after2, _ := os.ReadDir(g.downloadsDir)
	if len(after2) != len(before) {
		t.Errorf("files beside it: %v", after2)
	}
	if st2, _ := os.Stat(file); fileVersion(st2) != fileVersion(st) {
		t.Error("the database was changed by reading it")
	}

	// Changes in a -wal file beside it: said to be unseen.
	os.WriteFile(file+"-wal", []byte("not empty"), 0o600)
	if r := ask("data.sqlite", nil); r["wal"] != true {
		t.Errorf("wal: %v", r)
	}

	// Not a database; damaged; empty; UTF-16.
	os.WriteFile(filepath.Join(g.downloadsDir, "notes.db"), []byte(strings.Repeat("not a database\n", 100)), 0o600)
	if r := ask("notes.db", nil); !strings.Contains(fmt.Sprint(r["error"]), "isn't an SQLite database") || r["code"] != "not-database" {
		t.Errorf("not a database: %v", r)
	}
	data, _ := os.ReadFile(file)
	damaged := slices.Clone(data)
	for i := 4096; i < len(damaged); i += 7 {
		damaged[i] ^= 0x5a
	}
	os.WriteFile(filepath.Join(g.downloadsDir, "damaged.sqlite"), damaged, 0o600)
	if r := ask("damaged.sqlite", &sqliteQuery{Op: "rows", Table: "people"}); r["error"] == nil || r["code"] != "not-database" {
		t.Errorf("damaged: %v", r)
	}
	utf16 := filepath.Join(g.downloadsDir, "utf16.sqlite")
	if err := sqliteExec(utf16, "PRAGMA encoding = 'UTF-16le'; CREATE TABLE t(s TEXT); INSERT INTO t VALUES ('héllo wörld');"); err != nil {
		t.Fatal(err)
	}
	if a := answer(ask("utf16.sqlite", nil)); a["encoding"] != "UTF-16le" {
		t.Errorf("utf-16 schema: %v", a)
	} else if v := answer(ask("utf16.sqlite", &sqliteQuery{Op: "rows", Table: "t"})); v["rows"].([]any)[0].([]any)[0].(map[string]any)["t"] != "héllo wörld" {
		t.Errorf("utf-16 text: %v", v)
	}
}

// TestSQLiteSlow: a view that would take long is stopped: counted, it's
// "don't know" (-1); read, an error saying so; in time either way.
func TestSQLiteSlow(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "slow.sqlite")
	if err := sqliteExec(file, `CREATE VIEW forever AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n ORDER BY i % 7;`); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: "slow.sqlite", SQLite: &sqliteQuery{Op: "count", Table: "forever"}})
	if a, _ := r["answer"].(map[string]any); a["count"] != float64(-1) || time.Since(start) > sqliteCountFor+3*time.Second {
		t.Errorf("count: %v after %v", r, time.Since(start))
	}
}

// TestSQLiteGivenUp: a question the page gives up on (its tunnel closed)
// ends its child, freeing its slot, rather than running on to its deadline.
func TestSQLiteGivenUp(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "slow.sqlite")
	if err := sqliteExec(file, `CREATE VIEW forever AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n ORDER BY i % 7;`); err != nil {
		t.Fatal(err)
	}
	tc := openSession(t, ctx, srv.URL, s)
	b, _ := json.Marshal(tunnelRequest{Type: "sqlite", Path: "slow.sqlite", SQLite: &sqliteQuery{Op: "count", Table: "forever"}})
	if err := tc.write(ctx, msgText, b); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(sqliteSlots.slots) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the count never began")
		}
		time.Sleep(10 * time.Millisecond)
	}
	start := time.Now()
	tc.c.CloseNow()
	for len(sqliteSlots.slots) != 0 {
		if time.Since(start) > sqliteCountFor/2 {
			t.Fatalf("still counting %v after the page gave up", time.Since(start))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func anyStrings(v any) []string {
	var out []string
	for _, s := range v.([]any) {
		out = append(out, s.(string))
	}
	return out
}

// TestSQLiteWAL: a database in WAL mode, copied while it's open (as an
// app's often are): the main file alone, and with its -wal beside it.
func TestSQLiteWAL(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	src := filepath.Join(t.TempDir(), "live.sqlite")
	w, err := openSQLite(src, true)
	if err != nil {
		t.Fatal(err)
	}
	defer w.close()
	if err := w.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
CREATE TABLE early(x); INSERT INTO early VALUES (1);
PRAGMA wal_checkpoint(TRUNCATE);
CREATE TABLE late(y); INSERT INTO late VALUES (2);`); err != nil {
		t.Fatal(err)
	}
	main, _ := os.ReadFile(src)
	walData, _ := os.ReadFile(src + "-wal")
	if len(walData) == 0 {
		t.Fatal("no WAL to test with")
	}
	os.WriteFile(filepath.Join(g.downloadsDir, "alone.sqlite"), main, 0o600)
	os.WriteFile(filepath.Join(g.downloadsDir, "paired.sqlite"), main, 0o600)
	os.WriteFile(filepath.Join(g.downloadsDir, "paired.sqlite-wal"), walData, 0o600)
	for name, wantWAL := range map[string]bool{"alone.sqlite": false, "paired.sqlite": true} {
		r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: name})
		a, ok := r["answer"].(map[string]any)
		if !ok {
			t.Fatalf("%s: %v", name, r)
		}
		raw, _ := json.Marshal(a["objects"])
		var objects []sqliteObject
		json.Unmarshal(raw, &objects)
		var names []string
		for _, o := range objects {
			names = append(names, o.Name)
		}
		// What was checkpointed into the main file; not what's only in the WAL.
		if !slices.Equal(names, []string{"early"}) || (r["wal"] == true) != wantWAL {
			t.Errorf("%s: objects %v, wal %v", name, names, r["wal"])
		}
		if r["wal_mode"] != true {
			t.Errorf("%s: not said to be in WAL mode: %v", name, r)
		}
		if v := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: name, SQLite: &sqliteQuery{Op: "rows", Table: "early"}}); v["error"] != nil {
			t.Errorf("%s rows: %v", name, v)
		}
	}
}

// TestSQLiteFilters: rows, and counts, as filters by column and a search
// leave them: numbers, dates and text as the CSV table filters them, all
// done by SQLite, of every row; values bound, never part of the SQL.
func TestSQLiteFilters(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "f.sqlite")
	var b strings.Builder
	b.WriteString("CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score INTEGER, born DATE);\nBEGIN;\n")
	for i := range 300 {
		fmt.Fprintf(&b, "INSERT INTO people(name, score, born) VALUES ('Person%d', %d, '20%02d-0%d-15 10:30');\n", i, -i*10, i%30, 1+i%9)
	}
	b.WriteString(`INSERT INTO people(name, score, born) VALUES (NULL, 'not a number', 'someday');
CREATE TABLE pairs(a TEXT, a2 TEXT); INSERT INTO pairs VALUES ('x', 'y'), ('X-ray', 'z');
CREATE VIEW twice AS SELECT a, a FROM pairs;
CREATE TABLE events(at DATETIME);
INSERT INTO events VALUES (1136214245), (1136214245000), (2453738.1278), ('2006-01-02'), ('later'), (NULL), (x'00');
COMMIT;`)
	if err := sqliteExec(file, b.String()); err != nil {
		t.Fatal(err)
	}
	ask := func(q sqliteQuery) map[string]any {
		t.Helper()
		r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: "f.sqlite", SQLite: &q})
		a, ok := r["answer"].(map[string]any)
		if !ok {
			return r
		}
		return a
	}
	count := func(table string, filters []sqliteFilter, search string, in *int) any {
		t.Helper()
		return ask(sqliteQuery{Op: "count", Table: table, Filters: filters, Search: search, SearchIn: in})["count"]
	}
	f := func(c int, typ, op, v string) sqliteFilter {
		return sqliteFilter{Column: c, Type: typ, Op: op, Value: v}
	}
	for name, c := range map[string]struct {
		filters []sqliteFilter
		want    float64
	}{
		// Numbers: only numbers match (not the text in row 301).
		"score ≥ -100":         {[]sqliteFilter{f(2, "number", "≥", "-100")}, 11},
		"score ≠ 0":            {[]sqliteFilter{f(2, "number", "≠", "0")}, 299},
		"a range, two at once": {[]sqliteFilter{f(2, "number", "<", "-50"), f(2, "number", ">", "-100.5")}, 5},
		"score = 1e1":          {[]sqliteFilter{f(2, "number", "=", "1e1")}, 0},
		// Dates: by the day, or to the moment; "someday" isn't one.
		// (Year i%30, month 1+i%9: each pair one row in 90.)
		"born on 2005-06-15":  {[]sqliteFilter{f(3, "date", "=", "2005-06-15")}, 4},
		"born after 2029":     {[]sqliteFilter{f(3, "date", ">", "2029-01-01")}, 10},
		"born before a time":  {[]sqliteFilter{f(3, "date", "<", "2000-01-15 10:31")}, 4},
		"not before 10:30":    {[]sqliteFilter{f(3, "date", "<", "2000-01-15 10:30")}, 0},
		"an offset, no colon": {[]sqliteFilter{f(3, "date", "<", "2000-01-15T12:31+0200")}, 4},
		// Text, ignoring case; NULL is empty text.
		"contains 'person1'":   {[]sqliteFilter{f(1, "text", "contains", "person1")}, 111},
		"starts 'PERSON29'":    {[]sqliteFilter{f(1, "text", "starts", "PERSON29")}, 11},
		"ends '99'":            {[]sqliteFilter{f(1, "text", "ends", "99")}, 3},
		"doesn't contain 'p'":  {[]sqliteFilter{f(1, "text", "!contains", "p")}, 1},
		"SQL, as plain text":   {[]sqliteFilter{f(1, "text", "contains", "') OR 1=1 --")}, 0},
		"a number column text": {[]sqliteFilter{f(2, "text", "contains", "number")}, 1},
	} {
		if got := count("people", c.filters, "", nil); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
	// Dates kept as numbers: Unix time in seconds or milliseconds, and
	// Julian days, all 2006-01-02 (at about 15:04 UTC); not text that
	// isn't a date, a blob or NULL.
	for name, c := range map[string]struct {
		filter sqliteFilter
		want   float64
	}{
		"on the day":     {f(0, "date", "=", "2006-01-02"), 4},
		"after it":       {f(0, "date", ">", "2006-01-02"), 0},
		"before 15:00":   {f(0, "date", "<", "2006-01-02 15:00"), 1},
		"before 15:05":   {f(0, "date", "<", "2006-01-02 15:05"), 4},
		"after 15:04:04": {f(0, "date", ">", "2006-01-02 15:04:04"), 2},
	} {
		if got := count("events", []sqliteFilter{c.filter}, "", nil); got != c.want {
			t.Errorf("events %s: %v, want %v", name, got, c.want)
		}
	}
	// A search: in any column, or one.
	one := 1
	if got := count("people", nil, "SOMEDAY", nil); got != float64(1) {
		t.Errorf("search anywhere: %v", got)
	}
	if got := count("people", nil, "someday", &one); got != float64(0) {
		t.Errorf("search in name: %v", got)
	}
	// A view whose columns share a name: by position, each its own.
	second := 1
	if got := count("twice", []sqliteFilter{f(1, "text", "starts", "x-")}, "", nil); got != float64(1) {
		t.Errorf("twice: %v", got)
	}
	// (SQLite names the second "a:1".)
	if v := ask(sqliteQuery{Op: "rows", Table: "twice", Order: &second, Desc: true}); len(anyStrings(v["columns"])) != 2 || len(v["rows"].([]any)) != 2 {
		t.Errorf("twice's columns: %v", v)
	}
	// Rows, filtered, a page at a time by rowid, with the columns' types.
	q := sqliteQuery{Op: "rows", Table: "people", Limit: 50, Filters: []sqliteFilter{f(1, "text", "contains", "person1")}}
	page := ask(q)
	if len(page["rows"].([]any)) != 50 || page["more"] != true || !slices.Equal(anyStrings(page["types"]), []string{"INTEGER", "TEXT", "INTEGER", "DATE"}) {
		t.Fatalf("filtered page: %d rows, more %v, types %v", len(page["rows"].([]any)), page["more"], page["types"])
	}
	seen := len(page["rows"].([]any))
	for page["more"] == true {
		keys := page["rowids"].([]any)
		after := keys[len(keys)-1].(string)
		q.After = &after
		page = ask(q)
		seen += len(page["rows"].([]any))
	}
	if seen != 111 {
		t.Errorf("paged through %d filtered rows, want 111", seen)
	}
	// Refused: what isn't a filter.
	for name, bad := range map[string]sqliteQuery{
		"no such column":   {Op: "rows", Table: "people", Filters: []sqliteFilter{f(9, "text", "contains", "x")}},
		"not a number":     {Op: "rows", Table: "people", Filters: []sqliteFilter{f(2, "number", "=", "1; DROP TABLE people")}},
		"not a date":       {Op: "rows", Table: "people", Filters: []sqliteFilter{f(3, "date", "=", "15/06/2005")}},
		"a number's op":    {Op: "rows", Table: "people", Filters: []sqliteFilter{f(2, "number", "contains", "1")}},
		"no such type":     {Op: "rows", Table: "people", Filters: []sqliteFilter{f(2, "sql", "=", "1")}},
		"empty text":       {Op: "rows", Table: "people", Filters: []sqliteFilter{f(1, "text", "contains", "")}},
		"too long":         {Op: "rows", Table: "people", Search: strings.Repeat("x", maxSQLiteFilterText+1)},
		"search elsewhere": {Op: "rows", Table: "people", Search: "x", SearchIn: &[]int{4}[0]},
	} {
		if r := ask(bad); r["error"] == nil {
			t.Errorf("%s: %v", name, r)
		}
	}
	if got := count("people", nil, "", nil); got != float64(301) {
		t.Errorf("unfiltered: %v", got)
	}
}

// jsonTextLen is how long encoding/json writes a string (less its quotes),
// whatever's in it: control characters, HTML's, invalid UTF-8.
func TestJSONTextLen(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	pool := []string{"a", "é", "\x00", "\x1f", "\b", "\f", "\n", "\t", "\"", "\\", "<", "&", " ", " ", "\xff", "\xe2\x80", "日本"}
	for range 2000 {
		var b strings.Builder
		for range r.IntN(40) {
			b.WriteString(pool[r.IntN(len(pool))])
		}
		s := b.String()
		enc, _ := json.Marshal(s)
		if got, want := jsonTextLen(s), len(enc)-2; got != want {
			t.Fatalf("%q: %d, encoded %d (%s)", s, got, want, enc)
		}
	}
}

// TestSQLiteControlCharacters: text full of control characters, which JSON
// writes six bytes each, is counted so when a page is filled: a shorter
// page, rather than one too much for the child to answer.
func TestSQLiteControlCharacters(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "ctl.sqlite")
	cols := "a, b, c, d, e, f, g, h"
	cell := "replace(hex(zeroblob(2000)), '00', char(1))" // 2000 U+0001s
	err := sqliteExec(file, "CREATE TABLE ctl("+cols+");\n"+
		"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) "+
		"INSERT INTO ctl SELECT "+strings.Repeat(cell+", ", 7)+cell+" FROM n;")
	if err != nil {
		t.Fatal(err)
	}
	r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: "ctl.sqlite", SQLite: &sqliteQuery{Op: "rows", Table: "ctl", Limit: 500}})
	a, ok := r["answer"].(map[string]any)
	if !ok {
		t.Fatalf("no page: %v", r)
	}
	if n := len(a["rows"].([]any)); n == 0 || n == 500 || a["more"] != true {
		t.Errorf("%d rows, more %v: want a shorter page, and more", n, a["more"])
	}
}

// A big text value: only its start read, cut at characters, not bytes,
// with its whole size in bytes.
func TestSQLiteBigText(t *testing.T) {
	file := filepath.Join(t.TempDir(), "big.sqlite")
	err := sqliteExec(file, "CREATE TABLE big(t TEXT);\n"+
		"INSERT INTO big VALUES (printf('%.*c', 3000, 'é')), (printf('%.*c', 20000000, 'x')), ('short é');")
	if err != nil {
		t.Fatal(err)
	}
	d, err := openSQLite(file, false)
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	got, err := d.rows(sqliteQuery{Op: "rows", Table: "big"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	var page struct{ Rows [][]sqliteValue }
	if err := json.Unmarshal(b, &page); err != nil {
		t.Fatal(err)
	}
	accents, xs, short := page.Rows[0][0], page.Rows[1][0], page.Rows[2][0]
	if *accents.Text != strings.Repeat("é", maxSQLiteText) || !accents.Cut || accents.Len != 6000 {
		t.Errorf("accents: %d characters, cut %v, %d bytes", utf8.RuneCountInString(*accents.Text), accents.Cut, accents.Len)
	}
	if *xs.Text != strings.Repeat("x", maxSQLiteText) || !xs.Cut || xs.Len != 20000000 {
		t.Errorf("xs: %d characters, cut %v, %d bytes", len(*xs.Text), xs.Cut, xs.Len)
	}
	if *short.Text != "short é" || short.Cut || short.Len != 0 {
		t.Errorf("short: %+v", short)
	}
}

// A question too long to be the child's argument is refused as that, not
// taken for a file that isn't a database.
func TestSQLiteQueryTooLong(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s := login(t, ctx, srv.URL, code(0))
	sqliteFixture(t, filepath.Join(g.downloadsDir, "long.sqlite"))
	var filters []sqliteFilter
	for range maxSQLiteFilters {
		filters = append(filters, sqliteFilter{Column: 1, Type: "text", Op: "contains", Value: strings.Repeat("<", maxSQLiteFilterText)})
	}
	r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "sqlite", Path: "long.sqlite",
		SQLite: &sqliteQuery{Op: "rows", Table: "people", Limit: 10, Filters: filters}})
	if msg, _ := r["error"].(string); !strings.Contains(msg, "filters are too long") {
		t.Errorf("got %v", r)
	}
}

// within waits for an interrupt already fired before it returns.
func TestSQLiteWithinWaits(t *testing.T) {
	d, err := openSQLite(filepath.Join(t.TempDir(), "w.sqlite"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	for range 200 {
		d.within(time.Microsecond, func() error {
			time.Sleep(10 * time.Microsecond)
			return nil
		})
	}
	if err := d.exec("CREATE TABLE t(a); INSERT INTO t VALUES (1);"); err != nil {
		t.Errorf("interrupted afterwards: %v", err)
	}
}
