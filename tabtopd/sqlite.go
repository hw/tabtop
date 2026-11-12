package main

// SQLite previews: a database's tables and views, and their rows a page at
// a time, read by SQLite itself (the system's libsqlite3), so whatever it
// can read shows as it would: overflow pages, UTF-16 text, WITHOUT ROWID
// tables, indexes.
//
// A database is a file from anywhere, so it's read in a child process
// (tabtopd run with sqliteChildArg, as EPUBs are), given the file as its
// stdin, with a deadline and a cap on what it answers, and in it:
//   - opened read-only and immutable (file:/dev/fd/0?immutable=1): nothing
//     is written beside it in Downloads, no lock taken, and no journal or
//     WAL file looked for (so changes still in a -wal file aren't seen:
//     the reply says if there is one);
//   - SQLite's defensive mode, trusted_schema off, query_only on, cell
//     size checks on, extensions not loadable, and a hard heap limit (the
//     child's GOMEMLIMIT doesn't cover C's memory);
//   - each query interrupted at its deadline (a view, a count, or sorting
//     by an unindexed column can take long).
// Only queries made here are run: tables are named by quoting a name the
// schema has, and sorted by a column's position, never by text sent.

// #cgo pkg-config: sqlite3
// #include <stdlib.h>
// #include <sqlite3.h>
// static int db_config_int(sqlite3 *db, int op, int v) { return sqlite3_db_config(db, op, v, (int *)0); }
// static int bind_text(sqlite3_stmt *s, int i, const char *p, int n) { return sqlite3_bind_text(s, i, p, n, SQLITE_TRANSIENT); }
import "C"

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

const (
	sqliteChildArg = "-read-sqlite"
	sqliteTimeout  = 15 * time.Second // the child's, in all
	sqliteQueryFor = 8 * time.Second  // each query's, before it's interrupted
	sqliteCountFor = 4 * time.Second  // a count's: it's only a nicety
	maxSQLiteOut   = 16 << 20         // what the child may answer
	maxSQLiteHeap  = 256 << 20        // SQLite's memory, in the child
	maxSQLiteRows  = 500              // a page of rows, at most
	maxSQLitePage  = 4 << 20          // and about this much of them, encoded
	maxSQLiteText  = 2000             // characters of a text value shown
	maxSQLiteBlob  = 32               // bytes of a blob shown
	maxSQLiteLoad  = 64 << 10         // bytes of a value read whole, if its start can be read alone
	maxSQLiteWhole = 4 << 20          // and if it can't (a view's, a virtual table's, a generated column's)
	maxSQLiteArg   = 96 << 10         // the question, as the child's argument (under MAX_ARG_STRLEN, 128 KiB)
)

var sqliteSlots = newPreviewWork(previewReadConcurrency)

// sqliteOctetLength is whether the SQLite linked has octet_length(): 3.43
// and later (see rows).
var sqliteOctetLength = C.sqlite3_libversion_number() >= 3043000

// sqliteQuery is a "sqlite" request's question (see tunnelRequest.SQLite):
// Op "" (or "schema") for the tables and views, "rows" for a page of a
// table's or view's rows, "count" for how many it has.
type sqliteQuery struct {
	Op    string `json:"op,omitempty"`
	Table string `json:"table,omitempty"`
	// rows: after the row with this rowid (a table's, unsorted), or from
	// Offset (sorted, or a view or WITHOUT ROWID table); at most Limit.
	After  *string `json:"after,omitempty"`
	Offset int64   `json:"offset,omitempty"`
	Limit  int     `json:"limit,omitempty"`
	// rows: sorted by the column at this position (from 0), if it's set,
	// descending with Desc.
	Order *int `json:"order,omitempty"`
	Desc  bool `json:"desc,omitempty"`
	// rows, count: only rows every filter lets through, and that have
	// Search in them (in the column at SearchIn, if it's set; else in any).
	Filters  []sqliteFilter `json:"filters,omitempty"`
	Search   string         `json:"search,omitempty"`
	SearchIn *int           `json:"search_in,omitempty"`
}

// sqliteObject is a table, view, index or trigger in the schema.
type sqliteObject struct {
	Type    string         `json:"type"`
	Name    string         `json:"name"`
	Table   string         `json:"table,omitempty"` // an index's or trigger's
	SQL     string         `json:"sql,omitempty"`
	Columns []sqliteColumn `json:"columns,omitempty"` // a table's or view's
	Rowid   bool           `json:"rowid,omitempty"`   // a table with rowids: paged by them
	Error   string         `json:"error,omitempty"`   // why its columns couldn't be read
	virtual bool           // a virtual table (as source has it)
}

type sqliteColumn struct {
	Name      string `json:"name"`
	Type      string `json:"type,omitempty"`
	PK        int    `json:"pk,omitempty"`
	Hidden    bool   `json:"hidden,omitempty"`
	Generated bool   `json:"-"` // a value computed, not kept: not one to read in part
}

// A value, as sent: nil for NULL, else one of these set. Integers are
// sent as text (64 bits don't fit a JavaScript number), and reals that
// JSON can't carry (infinities) as text too.
type sqliteValue struct {
	Int  *string `json:"i,omitempty"`
	Real any     `json:"r,omitempty"`
	Text *string `json:"t,omitempty"`
	Blob *string `json:"b,omitempty"` // its first bytes, as hex
	Len  int     `json:"n,omitempty"` // a blob's size, or a cut text's, in bytes
	Cut  bool    `json:"cut,omitempty"`
}

type sqliteDB struct {
	db       *C.sqlite3
	encoding string // how its text is kept: "UTF-8", "UTF-16le" or "UTF-16be"
}

type sqliteError struct {
	code int
	msg  string
}

func (e *sqliteError) Error() string {
	switch e.code & 0xff {
	case C.SQLITE_NOTADB:
		return "It isn't an SQLite database (or it's encrypted)."
	case C.SQLITE_CORRUPT:
		return "The database is damaged: " + e.msg
	case C.SQLITE_INTERRUPT:
		return "That took too long, so it was stopped."
	case C.SQLITE_NOMEM:
		return "That needs more memory than a preview may use."
	}
	return e.msg
}

func (d *sqliteDB) err(rc C.int) error {
	if rc == C.SQLITE_OK || rc == C.SQLITE_ROW || rc == C.SQLITE_DONE {
		return nil
	}
	msg := C.GoString(C.sqlite3_errstr(rc))
	if d.db != nil {
		msg = C.GoString(C.sqlite3_errmsg(d.db))
	}
	return &sqliteError{int(rc), msg}
}

// openSQLite opens the database at name: read-only and immutable, hardened
// as above; or, with writable, to make one (tests only).
func openSQLite(name string, writable bool) (*sqliteDB, error) {
	C.sqlite3_hard_heap_limit64(maxSQLiteHeap)
	flags := C.int(C.SQLITE_OPEN_READONLY | C.SQLITE_OPEN_URI | C.SQLITE_OPEN_NOMUTEX)
	if writable {
		flags = C.SQLITE_OPEN_READWRITE | C.SQLITE_OPEN_CREATE | C.SQLITE_OPEN_NOMUTEX
	}
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	d := &sqliteDB{}
	if rc := C.sqlite3_open_v2(cname, &d.db, flags, nil); rc != C.SQLITE_OK {
		err := d.err(rc)
		d.close()
		return nil, err
	}
	C.sqlite3_extended_result_codes(d.db, 1)
	if !writable {
		for _, o := range [][2]C.int{{C.SQLITE_DBCONFIG_DEFENSIVE, 1}, {C.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0},
			{C.SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0}, {C.SQLITE_DBCONFIG_ENABLE_TRIGGER, 0}} {
			if rc := C.db_config_int(d.db, o[0], o[1]); rc != C.SQLITE_OK {
				d.close()
				return nil, errors.New("SQLite couldn't be made safe to read this with")
			}
		}
		if err := d.exec("PRAGMA query_only = ON; PRAGMA cell_size_check = ON;"); err != nil {
			d.close()
			return nil, err
		}
	}
	// (Fixed once the database's made: read the once.)
	d.encoding = "UTF-8"
	if st, err := d.prepare("PRAGMA encoding"); err == nil {
		if ok, _ := st.next(); ok {
			d.encoding = st.text(0)
		}
		st.close()
	}
	return d, nil
}

func (d *sqliteDB) close() {
	if d.db != nil {
		C.sqlite3_close_v2(d.db)
		d.db = nil
	}
}

// exec runs sql, statements and all, with no rows wanted.
func (d *sqliteDB) exec(sql string) error {
	csql := C.CString(sql)
	defer C.free(unsafe.Pointer(csql))
	return d.err(C.sqlite3_exec(d.db, csql, nil, nil, nil))
}

// within runs f, interrupting what SQLite's doing if it isn't done by
// limit. An interrupt already on its way is waited for, so it can't land
// on what's run next, or on the database once it's closed.
func (d *sqliteDB) within(limit time.Duration, f func() error) error {
	db := d.db
	fired := make(chan struct{})
	t := time.AfterFunc(limit, func() {
		C.sqlite3_interrupt(db)
		close(fired)
	})
	defer func() {
		if !t.Stop() {
			<-fired
		}
	}()
	return f()
}

type sqliteStmt struct {
	d *sqliteDB
	s *C.sqlite3_stmt
}

// prepare makes sql a statement, its ? bound to args (strings, int64s or
// float64s).
func (d *sqliteDB) prepare(sql string, args ...any) (*sqliteStmt, error) {
	csql := C.CString(sql)
	defer C.free(unsafe.Pointer(csql))
	st := &sqliteStmt{d: d}
	if rc := C.sqlite3_prepare_v2(d.db, csql, -1, &st.s, nil); rc != C.SQLITE_OK {
		return nil, d.err(rc)
	}
	for i, a := range args {
		var rc C.int
		switch v := a.(type) {
		case int64:
			rc = C.sqlite3_bind_int64(st.s, C.int(i+1), C.sqlite3_int64(v))
		case float64:
			rc = C.sqlite3_bind_double(st.s, C.int(i+1), C.double(v))
		case string:
			cs := C.CString(v)
			rc = C.bind_text(st.s, C.int(i+1), cs, C.int(len(v)))
			C.free(unsafe.Pointer(cs))
		}
		if rc != C.SQLITE_OK {
			st.close()
			return nil, d.err(rc)
		}
	}
	return st, nil
}

func (st *sqliteStmt) close() { C.sqlite3_finalize(st.s) }

// next steps to the next row: false at the end, or on an error (err says).
func (st *sqliteStmt) next() (bool, error) {
	switch rc := C.sqlite3_step(st.s); rc {
	case C.SQLITE_ROW:
		return true, nil
	case C.SQLITE_DONE:
		return false, nil
	default:
		return false, st.d.err(rc)
	}
}

func (st *sqliteStmt) columns() int { return int(C.sqlite3_column_count(st.s)) }
func (st *sqliteStmt) name(i int) string {
	return C.GoString(C.sqlite3_column_name(st.s, C.int(i)))
}
func (st *sqliteStmt) text(i int) string {
	p := C.sqlite3_column_text(st.s, C.int(i))
	if p == nil {
		return ""
	}
	return C.GoStringN((*C.char)(unsafe.Pointer(p)), C.sqlite3_column_bytes(st.s, C.int(i)))
}
func (st *sqliteStmt) int(i int) int64 { return int64(C.sqlite3_column_int64(st.s, C.int(i))) }

// decltype is column i's declared type, or "" (an expression's).
func (st *sqliteStmt) decltype(i int) string {
	if p := C.sqlite3_column_decltype(st.s, C.int(i)); p != nil {
		return C.GoString(p)
	}
	return ""
}

// value is column i of the row, as sent (nil for NULL).
func (st *sqliteStmt) value(i int) *sqliteValue {
	ci := C.int(i)
	switch C.sqlite3_column_type(st.s, ci) {
	case C.SQLITE_INTEGER:
		s := strconv.FormatInt(st.int(i), 10)
		return &sqliteValue{Int: &s}
	case C.SQLITE_FLOAT:
		f := float64(C.sqlite3_column_double(st.s, ci))
		if math.IsInf(f, 0) || math.IsNaN(f) {
			return &sqliteValue{Real: strconv.FormatFloat(f, 'g', -1, 64)}
		}
		return &sqliteValue{Real: f}
	case C.SQLITE_TEXT:
		// No more copied than the characters shown could take (4 bytes
		// each at most). (SQLite has the value whole, here: rows reads
		// only values no bigger than maxSQLiteLoad this way.)
		p := C.sqlite3_column_text(st.s, ci)
		n := int(C.sqlite3_column_bytes(st.s, ci))
		s := ""
		if p != nil {
			s = C.GoStringN((*C.char)(unsafe.Pointer(p)), C.int(min(n, 4*maxSQLiteText)))
		}
		v := &sqliteValue{Text: &s}
		if n > len(s) || utf8.RuneCountInString(s) > maxSQLiteText {
			short := s
			if k := runeOffset(s, maxSQLiteText); k >= 0 {
				short = s[:k]
			}
			v.Text, v.Cut, v.Len = &short, true, n
		}
		return v
	case C.SQLITE_BLOB:
		n := int(C.sqlite3_column_bytes(st.s, ci))
		p := C.sqlite3_column_blob(st.s, ci)
		head := ""
		if p != nil {
			head = hex.EncodeToString(C.GoBytes(p, C.int(min(n, maxSQLiteBlob))))
		}
		return &sqliteValue{Blob: &head, Len: n}
	}
	return nil
}

// cell is a value of the row st is on, as sent (nil for NULL), from the
// columns at, at+1 and at+2: its type, its size in bytes, and the value,
// if it's small enough to read whole (see rows). Bigger text or a bigger
// blob is cut short: its start is read from table at rowid, in column (""
// if it can't be: then it's shown as its size alone).
func (d *sqliteDB) cell(st *sqliteStmt, at int, table, column string, rowid int64) *sqliteValue {
	kind := st.text(at)
	n := int(st.int(at + 1))
	if kind != "text" && kind != "blob" || C.sqlite3_column_type(st.s, C.int(at+2)) != C.SQLITE_NULL {
		v := st.value(at + 2)
		// A size as the database keeps it, whether or not it was read
		// whole (UTF-16's, not UTF-8's).
		if v != nil && v.Cut {
			v.Len = n
		}
		return v
	}
	if kind == "blob" {
		head := hex.EncodeToString(d.head(table, column, rowid, maxSQLiteBlob))
		return &sqliteValue{Blob: &head, Len: n}
	}
	text := ""
	if encoding := d.encoding; encoding == "UTF-8" {
		text = string(d.head(table, column, rowid, 4*maxSQLiteText))
	} else if b := d.head(table, column, rowid, 4*maxSQLiteText); len(b) >= 2 {
		// UTF-16, as the database keeps its text: two bytes a unit.
		units := make([]uint16, len(b)/2)
		for i := range units {
			if d.encoding == "UTF-16be" {
				units[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
			} else {
				units[i] = uint16(b[2*i+1])<<8 | uint16(b[2*i])
			}
		}
		text = string(utf16.Decode(units))
	}
	if k := runeOffset(text, maxSQLiteText); k >= 0 {
		text = text[:k]
	}
	return &sqliteValue{Text: &text, Cut: true, Len: n}
}

// head is the first bytes (up to max) of the value in column of table at
// rowid, read without reading it all; nil if it can't be read so.
func (d *sqliteDB) head(table, column string, rowid int64, max int) []byte {
	if table == "" {
		return nil
	}
	cdb, ctable, ccolumn := C.CString("main"), C.CString(table), C.CString(column)
	defer C.free(unsafe.Pointer(cdb))
	defer C.free(unsafe.Pointer(ctable))
	defer C.free(unsafe.Pointer(ccolumn))
	var b *C.sqlite3_blob
	if C.sqlite3_blob_open(d.db, cdb, ctable, ccolumn, C.sqlite3_int64(rowid), 0, &b) != C.SQLITE_OK {
		if b != nil {
			C.sqlite3_blob_close(b)
		}
		return nil
	}
	defer C.sqlite3_blob_close(b)
	n := min(int(C.sqlite3_blob_bytes(b)), max)
	if n <= 0 {
		return nil
	}
	buf := make([]byte, n)
	if C.sqlite3_blob_read(b, unsafe.Pointer(&buf[0]), C.int(n), 0) != C.SQLITE_OK {
		return nil
	}
	return buf
}

// sqliteMemoryUsed is the most memory SQLite has had at once since it
// was last asked (reset), for tests.
func sqliteMemoryUsed(reset bool) int64 {
	r := C.int(0)
	if reset {
		r = 1
	}
	return int64(C.sqlite3_memory_highwater(r))
}

// runeOffset is the byte offset in s of its nth character (as ranging
// over s counts them), or -1 if it has no more than n.
func runeOffset(s string, n int) int {
	for k := range s {
		if n == 0 {
			return k
		}
		n--
	}
	return -1
}

// quoteIdent is name as an SQL identifier.
func quoteIdent(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

// schema is the database's tables, views, indexes and triggers, with each
// table's and view's columns, and a little about the database.
func (d *sqliteDB) schema() (map[string]any, error) {
	var objects []sqliteObject
	err := d.within(sqliteQueryFor, func() error {
		st, err := d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type = 'table' DESC, type = 'view' DESC, type, name")
		if err != nil {
			return err
		}
		defer st.close()
		for {
			ok, err := st.next()
			if err != nil {
				return err
			}
			if !ok {
				return nil
			}
			o := sqliteObject{Type: st.text(0), Name: st.text(1), SQL: st.text(3)}
			if o.Type == "index" || o.Type == "trigger" {
				o.Table = st.text(2)
			}
			objects = append(objects, o)
		}
	})
	if err != nil {
		return nil, err
	}
	for i := range objects {
		o := &objects[i]
		if o.Type != "table" && o.Type != "view" {
			continue
		}
		cols, err := d.columnsOf(o.Name)
		if err != nil {
			o.Error = err.Error()
			continue
		}
		o.Columns = cols
		o.Rowid = o.Type == "table" && d.rowidOf(o.Name, cols) != ""
	}
	info := map[string]any{"objects": objects}
	_ = d.within(sqliteQueryFor, func() error {
		// (Not journal_mode: opened immutable, it says "delete" whatever
		// the file is; see tunnelSQLite.)
		for _, p := range []string{"page_size", "page_count", "encoding", "user_version", "application_id"} {
			st, err := d.prepare("PRAGMA " + p)
			if err != nil {
				continue
			}
			if ok, _ := st.next(); ok {
				if C.sqlite3_column_type(st.s, 0) == C.SQLITE_INTEGER {
					info[p] = st.int(0)
				} else {
					info[p] = st.text(0)
				}
			}
			st.close()
		}
		return nil
	})
	return info, nil
}

// columnsOf is the columns of the table or view name, hidden ones too.
func (d *sqliteDB) columnsOf(name string) ([]sqliteColumn, error) {
	var cols []sqliteColumn
	err := d.within(sqliteQueryFor, func() error {
		st, err := d.prepare("SELECT name, type, pk, hidden FROM pragma_table_xinfo(?)", name)
		if err != nil {
			return err
		}
		defer st.close()
		for {
			ok, err := st.next()
			if err != nil || !ok {
				return err
			}
			// (1: a virtual table's hidden column; 2 and 3, generated
			// ones, which * gives.)
			cols = append(cols, sqliteColumn{Name: st.text(0), Type: st.text(1), PK: int(st.int(2)), Hidden: st.int(3) == 1, Generated: st.int(3) >= 2})
		}
	})
	return cols, err
}

// rowidOf is a name for the table's rowid that none of its columns has
// taken, or "" if it has none (WITHOUT ROWID, or every name taken).
func (d *sqliteDB) rowidOf(table string, cols []sqliteColumn) string {
	for _, alias := range []string{"rowid", "_rowid_", "oid"} {
		if slices.ContainsFunc(cols, func(c sqliteColumn) bool { return strings.EqualFold(c.Name, alias) }) {
			continue
		}
		st, err := d.prepare("SELECT " + alias + " FROM " + quoteIdent(table) + " LIMIT 0")
		if err != nil {
			return ""
		}
		st.close()
		return alias
	}
	return ""
}

// object is the table or view called name, as the schema has it.
func (d *sqliteDB) object(name string) (sqliteObject, error) {
	st, err := d.prepare("SELECT type, coalesce(sql, '') FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')", name)
	if err != nil {
		return sqliteObject{}, err
	}
	defer st.close()
	ok, err := st.next()
	if err != nil {
		return sqliteObject{}, err
	}
	if !ok {
		return sqliteObject{}, fmt.Errorf("There's no table or view called %s.", name)
	}
	o := sqliteObject{Type: st.text(0), Name: name}
	o.virtual = strings.HasPrefix(strings.ToUpper(strings.TrimSpace(st.text(1))), "CREATE VIRTUAL")
	if o.Columns, err = d.columnsOf(name); err != nil {
		return o, err
	}
	return o, nil
}

// sqliteFilter is a condition on a column, by its position (from 0): as
// the CSV table's are (see FILTER_OPS in table-view.js), by the column's
// type as the page takes it, "number", "date" or "text".
type sqliteFilter struct {
	Column int    `json:"column"`
	Type   string `json:"type"`
	Op     string `json:"op"`
	Value  string `json:"value"`
}

const (
	maxSQLiteFilters    = 64
	maxSQLiteFilterText = 1000 // characters of a value or search
)

// sqliteDate is a date, maybe with a time, as filters take one.
// (As DATE in table-view.js; SQLite reads an offset only as ±HH:MM.)
var (
	sqliteDate   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$`)
	sqliteOffset = regexp.MustCompile(`([+-]\d{2})(\d{2})$`)
)

// sqliteSource is the table or view a question is about, as a query:
// WITH q(k, c0, c1, …), its rowid (if it has one) as k and its columns
// renamed by their positions, so that what's asked of them names only
// names made here (and a view whose columns share a name is no trouble);
// with the conditions q's filters and search make, and their arguments.
type sqliteSource struct {
	with  string
	conds []string
	args  []any
	names []string // the columns' own names
	types []string // as declared ("" for an expression's)
	rowid bool
	parts []string // for each column, the table its values' starts can be read from alone ("" if they can't)
}

// textOf is column c as text, lower case (ASCII), NULL as "", for matching.
func textOf(c string) string { return "lower(coalesce(CAST(" + c + " AS TEXT), ''))" }

func (d *sqliteDB) source(q sqliteQuery) (*sqliteSource, error) {
	o, err := d.object(q.Table)
	if err != nil {
		return nil, err
	}
	from := quoteIdent(o.Name)
	src := &sqliteSource{}
	// The columns * gives, as the schema has them: not a virtual table's
	// hidden ones. (A view's of the same name, renamed "name:1", as * has
	// them too. Not asked of a SELECT * as well: for a view, that's
	// compiling it once more, for every page.)
	var shown []sqliteColumn
	for _, c := range o.Columns {
		if !c.Hidden {
			shown = append(shown, c)
		}
	}
	for _, c := range shown {
		src.names = append(src.names, c.Name)
		src.types = append(src.types, c.Type)
	}
	n := len(src.names)
	src.parts = make([]string, n)
	cols, sel := make([]string, 0, n+1), "*"
	if o.Type == "table" {
		if alias := d.rowidOf(o.Name, o.Columns); alias != "" {
			src.rowid, sel = true, alias+", *"
			cols = append(cols, "k")
			// Read in part: an ordinary rowid table's own values, not a
			// virtual table's, nor generated ones (SQLite won't).
			if !o.virtual {
				for i, c := range shown {
					if !c.Generated {
						src.parts[i] = o.Name
					}
				}
			}
		}
	}
	for i := range n {
		cols = append(cols, fmt.Sprintf("c%d", i))
	}
	src.with = "WITH q(" + strings.Join(cols, ", ") + ") AS (SELECT " + sel + " FROM " + from + ") "

	if len(q.Filters) > maxSQLiteFilters {
		return nil, errors.New("That's too many conditions.")
	}
	for _, f := range q.Filters {
		if f.Column < 0 || f.Column >= n {
			return nil, errors.New("That's not a column to filter by.")
		}
		if utf8.RuneCountInString(f.Value) > maxSQLiteFilterText {
			return nil, errors.New("That's too long to filter by.")
		}
		c := fmt.Sprintf("c%d", f.Column)
		switch f.Type {
		case "number":
			op, ok := map[string]string{"=": "=", "≠": "<>", "≥": ">=", "≤": "<=", "<": "<", ">": ">"}[f.Op]
			if !ok {
				return nil, errors.New("That's not a way to compare numbers.")
			}
			v := strings.TrimSpace(f.Value)
			var arg any
			if i, err := strconv.ParseInt(v, 10, 64); err == nil {
				arg = i
			} else if r, err := strconv.ParseFloat(v, 64); err == nil && !math.IsInf(r, 0) && !math.IsNaN(r) {
				arg = r
			} else {
				return nil, errors.New("That's not a number.")
			}
			// Only numbers: text, blobs and NULLs match none of them.
			src.conds = append(src.conds, "(typeof("+c+") IN ('integer', 'real') AND "+c+" "+op+" ?)")
			src.args = append(src.args, arg)
		case "date":
			op, ok := map[string]string{"<": "<", ">": ">", "=": "="}[f.Op]
			v := strings.TrimSpace(f.Value)
			if !ok || !sqliteDate.MatchString(v) {
				return nil, errors.New("A date is written YYYY-MM-DD (and a time, if you like).")
			}
			if len(v) > 16 {
				v = sqliteOffset.ReplaceAllString(v, "$1:$2")
			}
			// A day: by the day; with a time, to the moment.
			if len(v) == 10 {
				src.conds = append(src.conds, "(date("+sqliteWhen(c)+") "+op+" ?)")
			} else {
				src.conds = append(src.conds, "("+sqliteWhen(c)+" "+op+" julianday(?))")
			}
			src.args = append(src.args, v)
		case "text":
			if f.Value == "" {
				return nil, errors.New("Give some text.")
			}
			t := textOf(c)
			var cond string
			switch strings.TrimPrefix(f.Op, "!") {
			case "contains":
				cond = "instr(" + t + ", lower(?)) > 0"
				src.args = append(src.args, f.Value)
			case "starts":
				cond = "substr(" + t + ", 1, length(?)) = lower(?)"
				src.args = append(src.args, f.Value, f.Value)
			case "ends":
				cond = "substr(" + t + ", -length(?)) = lower(?)"
				src.args = append(src.args, f.Value, f.Value)
			default:
				return nil, errors.New("That's not a way to match text.")
			}
			if strings.HasPrefix(f.Op, "!") {
				cond = "NOT (" + cond + ")"
			}
			src.conds = append(src.conds, "("+cond+")")
		default:
			return nil, errors.New("That's not a way to filter.")
		}
	}
	// The search: in a column, or any.
	if q.Search != "" {
		if utf8.RuneCountInString(q.Search) > maxSQLiteFilterText {
			return nil, errors.New("That's too long to look for.")
		}
		in := make([]int, 0, n)
		if q.SearchIn != nil {
			if *q.SearchIn < 0 || *q.SearchIn >= n {
				return nil, errors.New("That's not a column to look in.")
			}
			in = append(in, *q.SearchIn)
		} else {
			for i := range n {
				in = append(in, i)
			}
		}
		var alts []string
		for _, i := range in {
			alts = append(alts, "instr("+textOf(fmt.Sprintf("c%d", i))+", lower(?)) > 0")
			src.args = append(src.args, q.Search)
		}
		src.conds = append(src.conds, "("+strings.Join(alts, " OR ")+")")
	}
	return src, nil
}

// where is src's conditions, and more, as a WHERE clause ("" if none).
func where(conds ...string) string {
	if len(conds) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(conds, " AND ")
}

// rows answers q: a page of the table's or view's rows (as filtered),
// each its values in the order of its columns, with the columns' names
// and declared types, "rowids" (a rowid table's, unsorted: the last is
// where the next page starts) and "more".
func (d *sqliteDB) rows(q sqliteQuery) (map[string]any, error) {
	src, err := d.source(q)
	if err != nil {
		return nil, err
	}
	limit := q.Limit
	if limit <= 0 || limit > maxSQLiteRows {
		limit = maxSQLiteRows
	}
	n := len(src.names)
	keyed := src.rowid && q.Order == nil
	conds, args := slices.Clone(src.conds), slices.Clone(src.args)
	order := ""
	if keyed {
		if q.After != nil {
			after, err := strconv.ParseInt(*q.After, 10, 64)
			if err != nil {
				return nil, errors.New("That's not a row to carry on from.")
			}
			conds = append(conds, "k > ?")
			args = append(args, after)
		}
		order = " ORDER BY k"
	} else if q.Order != nil {
		if *q.Order < 0 || *q.Order >= n {
			return nil, errors.New("That's not a column to sort by.")
		}
		dir := ""
		if q.Desc {
			dir = " DESC"
		}
		order = fmt.Sprintf(" ORDER BY c%d%s", *q.Order, dir)
		// Rows that sort the same, in the same order each page: by rowid,
		// or (with none) by the other columns.
		if src.rowid {
			order += ", k"
		} else {
			for i := range n {
				if i != *q.Order {
					order += fmt.Sprintf(", c%d", i)
				}
			}
		}
	}
	offset := q.Offset
	if keyed || offset < 0 {
		offset = 0
	}
	// Each column as its type, its size, and its value only if that's
	// small enough: typeof() and octet_length() don't need a value read,
	// so one bigger than the child's memory doesn't stop the row being
	// shown (see cell). Small enough is smaller where its start can be
	// read alone. (Sorted by a column, SQLite may still read its values;
	// and before 3.43, there's no octet_length(), nor this saving.)
	sel := make([]string, 0, 3*n+1)
	if src.rowid {
		sel = append(sel, "k")
	}
	sizeOf := "octet_length(%s)"
	if !sqliteOctetLength {
		sizeOf = "length(CAST(%s AS BLOB))"
	}
	for i := range n {
		c := fmt.Sprintf("c%d", i)
		whole := maxSQLiteWhole
		if src.parts[i] != "" {
			whole = maxSQLiteLoad
		}
		bytes := fmt.Sprintf(sizeOf, c)
		sel = append(sel, "typeof("+c+")", bytes, fmt.Sprintf("CASE WHEN %s <= %d THEN %s END", bytes, whole, c))
	}
	sql := src.with + "SELECT " + strings.Join(sel, ", ") + " FROM q" + where(conds...) + order + " LIMIT ? OFFSET ?"
	args = append(args, int64(limit+1), offset)
	lead := 0 // columns before the table's own: k
	if src.rowid {
		lead = 1
	}

	var rows [][]*sqliteValue
	var keys []string
	more, size := false, 0
	err = d.within(sqliteQueryFor, func() error {
		st, err := d.prepare(sql, args...)
		if err != nil {
			return err
		}
		defer st.close()
		for {
			ok, err := st.next()
			if err != nil || !ok {
				return err
			}
			if len(rows) == limit || size > maxSQLitePage {
				more = true
				return nil
			}
			row := make([]*sqliteValue, 0, n)
			var rowid int64
			if lead == 1 {
				rowid = st.int(0)
			}
			for i := range n {
				v := d.cell(st, lead+3*i, src.parts[i], src.names[i], rowid)
				row = append(row, v)
				if v != nil {
					switch {
					case v.Text != nil:
						size += jsonTextLen(*v.Text) + 16
					case v.Blob != nil:
						size += len(*v.Blob) + 24
					default:
						size += 24
					}
				} else {
					size += 6
				}
			}
			rows = append(rows, row)
			if lead == 1 {
				keys = append(keys, strconv.FormatInt(rowid, 10))
			}
		}
	})
	if err != nil {
		return nil, err
	}
	res := map[string]any{"columns": src.names, "types": src.types, "rows": rows, "more": more}
	if lead == 1 {
		res["rowids"] = keys
	}
	return res, nil
}

// count is how many rows the table or view has (as q's filters and search
// leave it), or -1 if counting them takes too long.
func (d *sqliteDB) count(q sqliteQuery) (int64, error) {
	src, err := d.source(q)
	if err != nil {
		return 0, err
	}
	n := int64(-1)
	err = d.within(sqliteCountFor, func() error {
		st, err := d.prepare(src.with+"SELECT count(*) FROM q"+where(src.conds...), src.args...)
		if err != nil {
			return err
		}
		defer st.close()
		if ok, err := st.next(); err != nil || !ok {
			return err
		}
		n = st.int(0)
		return nil
	})
	var se *sqliteError
	if errors.As(err, &se) && se.code&0xff == C.SQLITE_INTERRUPT {
		return -1, nil
	}
	return n, err
}

// readSQLiteChild is the child's part (see the top of this file): the
// database on stdin, the question as args[0], the answer, as JSON, on
// stdout; on failure, why, on stdout, and exit status 1, or 2 if it isn't
// a database SQLite can read (see errSQLiteNotDatabase).
func readSQLiteChild(args []string) int {
	fail := func(err error) int {
		os.Stdout.WriteString(err.Error())
		var se *sqliteError
		if errors.As(err, &se) && (se.code&0xff == C.SQLITE_NOTADB || se.code&0xff == C.SQLITE_CORRUPT) {
			return 2
		}
		return 1
	}
	var q sqliteQuery
	if len(args) != 1 || json.Unmarshal([]byte(args[0]), &q) != nil {
		return fail(errors.New("not a question the child answers"))
	}
	d, err := openSQLite("file:/dev/fd/0?immutable=1", false)
	if err != nil {
		return fail(err)
	}
	defer d.close()
	var res any
	switch q.Op {
	case "", "schema":
		res, err = d.schema()
	case "rows":
		res, err = d.rows(q)
	case "count":
		var n int64
		n, err = d.count(q)
		res = map[string]any{"count": n}
	default:
		err = errors.New("not a question the child answers")
	}
	if err != nil {
		return fail(err)
	}
	b, err := json.Marshal(res)
	if err != nil {
		return fail(err)
	}
	os.Stdout.Write(b)
	return 0
}

// notDatabaseError is a file SQLite can't read as a database (not one, or
// damaged): the page shows it another way (see tunnelSQLite).
type notDatabaseError struct{ msg string }

func (e *notDatabaseError) Error() string { return e.msg }

// readSQLiteIsolated asks a child about the database open as f, killing
// it if ctx ends first.
func readSQLiteIsolated(ctx context.Context, f *os.File, q sqliteQuery) (json.RawMessage, error) {
	release, ok := sqliteSlots.acquireContext(ctx)
	if !ok && ctx.Err() != nil {
		return nil, ctx.Err()
	} else if !ok {
		return nil, errors.New("Other databases are being read; try again in a moment.")
	}
	defer release()
	// The question goes to the child as one argument, which the kernel
	// keeps under 128 KiB: filters escaped as they're sent can take more.
	b, _ := json.Marshal(q)
	if len(b) > maxSQLiteArg {
		return nil, errors.New("Those filters are too long; try fewer or shorter ones.")
	}
	result := runIsolatedChild(isolatedChild{Context: ctx, Args: []string{sqliteChildArg, string(b)}, Input: f, Timeout: sqliteTimeout, OutputLimit: maxSQLiteOut})
	switch {
	case ctx.Err() != nil:
		return nil, ctx.Err()
	case result.TimedOut:
		return nil, errors.New("That took too long, so it was stopped.")
	case result.Overflow:
		return nil, errors.New("That's too much to show at once.")
	case result.Err != nil && result.ExitCode == 2 && len(result.Output) < 500:
		return nil, &notDatabaseError{string(result.Output)}
	case result.Err != nil && result.ExitCode == 1 && len(result.Output) < 500:
		return nil, errors.New(string(result.Output))
	case result.Err != nil:
		return nil, errors.New("It couldn't be read as a database.")
	}
	return result.Output, nil
}

// tunnelSQLite answers a "sqlite" request: req.SQLite asked of the database
// at req.Path, as the page read it; with the schema, its size and version,
// and whether a -wal file beside it holds changes not shown.
func (g *server) tunnelSQLite(req tunnelRequest, r *tunnelResponder) {
	opened, err := openDownloadsFile(g.downloadsDir, req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	st := opened.info
	if req.changedSinceRead(st) {
		r.fail(errReopen(" to see it as it is").Error())
		return
	}
	var q sqliteQuery
	if req.SQLite != nil {
		q = *req.SQLite
	}
	// Ended, its child killed and its slot freed, if the page gives up on
	// it (another table chosen, say, or the preview closed): nothing more
	// is read from the tunnel.
	ctx := r.t.CloseRead(context.Background())
	out, err := readSQLiteIsolated(ctx, opened.file, q)
	if ctx.Err() != nil {
		return
	}
	var notDB *notDatabaseError
	if errors.As(err, &notDB) {
		r.failCode(err.Error(), "not-database")
		return
	}
	if err != nil {
		r.fail(err.Error())
		return
	}
	res := map[string]any{"size": st.Size(), "mtime": fileVersion(st), "answer": out}
	if q.Op == "" || q.Op == "schema" {
		// In WAL mode, its header says (its read and write versions 2);
		// changes may then be in a -wal file beside it, which isn't read.
		hdr := make([]byte, 20)
		if _, err := opened.file.ReadAt(hdr, 0); err == nil && hdr[18] == 2 && hdr[19] == 2 {
			res["wal_mode"] = true
		}
		if w, err := opened.store.root.Lstat(opened.name + "-wal"); err == nil && w.Mode().IsRegular() && w.Size() > 0 {
			res["wal"] = true
		}
	}
	r.finish(res)
}

// sqliteExec runs script in the database at name, made if it isn't there:
// for tests, which can't use cgo themselves.
func sqliteExec(name, script string) error {
	d, err := openSQLite(name, true)
	if err != nil {
		return err
	}
	defer d.close()
	return d.exec(script)
}

// sqliteWhen is the moment column c's value says, as a Julian day, or NULL:
// text as SQLite reads dates; a number as SQLite's "auto" reads one (a
// Julian day, from year 0 to 9999, or else Unix time), but Unix time in
// milliseconds if it's that large (as apps keep it: seconds that many
// would be past the year 5000).
func sqliteWhen(c string) string {
	return "(CASE typeof(" + c + ") WHEN 'text' THEN julianday(" + c + ")" +
		" WHEN 'integer' THEN " + sqliteNumberWhen(c) + " WHEN 'real' THEN " + sqliteNumberWhen(c) + " END)"
}

func sqliteNumberWhen(c string) string {
	return "(CASE WHEN " + c + " >= 1721059.5 AND " + c + " < 5373484.5 THEN " + c +
		" WHEN abs(" + c + ") >= 100000000000 THEN julianday(" + c + " / 1000.0, 'unixepoch')" +
		" ELSE julianday(" + c + ", 'unixepoch') END)"
}

// jsonTextLen is how long s is as encoding/json writes it in a string: a
// control character as \u00XX (or \n, \r, \t, \b, \f), quotes and
// backslashes escaped, <, > and & as \u003c and the like, U+2028 and
// U+2029 escaped, and each byte of invalid UTF-8 as U+FFFD.
func jsonTextLen(s string) int {
	n := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\t' || c == '\b' || c == '\f':
				n += 2
			case c < 0x20 || c == '<' || c == '>' || c == '&':
				n += 6
			default:
				n++
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			n += 3 // U+FFFD, as UTF-8
		case r == '\u2028', r == '\u2029':
			n += 6
		default:
			n += size
		}
		i += size
	}
	return n
}
