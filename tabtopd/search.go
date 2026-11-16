package main

// Searching the text of the files in a folder, and those in it.
//
// The walk is walkTree's: links aren't followed, nor is anything outside
// the root reached; Trash, and unfinished uploads, aren't looked in. Text
// is matched line by line, with Go's regular expressions (RE2), which take
// time in proportion to what they read, whatever the pattern. A search
// keeps to limits on what it reads, how long it takes and what it finds,
// and says which it reached.

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	searchMaxQuery   = 500
	searchMaxMatches = 1000
	searchPerFile    = 100     // lines found in one file
	searchMaxFile    = 8 << 20 // larger files aren't read
	searchMaxBytes   = 512 << 20
	searchMaxEntries = 200000
	searchMaxLine    = 1 << 20 // a longer line ends the file's search
	searchTextTime   = 30 * time.Second
	searchContext    = 80 // characters shown either side of what's found
	searchBatch      = 50
	searchPeek       = 8000 // what's looked at, at a file's start, to tell it's text
)

// searchMatch is a line found: in the file at Path, its Line'th, shown as
// Before, Match (what matched) and After, cut short around it.
type searchMatch struct {
	Path   string `json:"path"`
	Line   int    `json:"line"`
	Before string `json:"before"`
	Match  string `json:"match"`
	After  string `json:"after"`
}

var errSearchStop = errors.New("stop")

// textSearchSlots bounds the searches of files' text going at once.
var textSearchSlots = make(chan struct{}, 3)

// searchQuery compiles req's query, as searchText uses it.
func searchQuery(req tunnelRequest) (*regexp.Regexp, error) {
	q := req.Query
	if q == "" || len(q) > searchMaxQuery || !utf8.ValidString(q) || strings.ContainsAny(q, "\n\r") {
		return nil, errors.New("Search for 1 to 500 characters, on one line.")
	}
	if !req.Regex {
		q = regexp.QuoteMeta(q)
	}
	if !req.MatchCase {
		q = "(?i)" + q
	}
	re, err := regexp.Compile(q)
	if err != nil {
		return nil, errors.New("That's not a regular expression that can be used: " + strings.TrimPrefix(err.Error(), "error parsing regexp: "))
	}
	if re.MatchString("") {
		return nil, errors.New("That would match every line: search for something.")
	}
	return re, nil
}

// cut is s cut to about n characters, from its end if fromEnd, at a
// character's edge, marked where it's cut.
func cut(s string, n int, fromEnd bool) string {
	if len(s) <= n {
		return s
	}
	if fromEnd {
		i := len(s) - n
		for i < len(s) && !utf8.RuneStart(s[i]) {
			i++
		}
		return "…" + s[i:]
	}
	i := n
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return s[:i] + "…"
}

// searchStats is how a search went.
type searchStats struct {
	files, matches int
	bytes          int64
	entries        int
	unreadable     int    // folders that couldn't be opened, passed over
	reason         string // why it stopped short, if it did
}

// searchText looks for re in the files in the folder dir of s, info its
// Lstat, calling found with each line found, until ctx ends.
func (s *downloadStore) searchText(ctx context.Context, dir string, info fs.FileInfo, re *regexp.Regexp, found func(searchMatch)) (searchStats, error) {
	var st searchStats
	deadline := time.Now().Add(searchTextTime)
	err := walkTree(ctx, s.root, dir, info, func(p string, info fs.FileInfo) error {
		base := path.Base(p)
		st.entries++
		switch {
		case hiddenDownloadName(base), path.Dir(p) == "." && s.isTrashTop(base):
			return fs.SkipDir
		case st.entries > searchMaxEntries:
			st.reason = "it looked through as many files and folders as it can"
			return errSearchStop
		case time.Now().After(deadline):
			st.reason = "it took as long as it can"
			return errSearchStop
		case !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > searchMaxFile:
			return nil
		case st.bytes >= searchMaxBytes:
			st.reason = "it read as much as it can"
			return errSearchStop
		}
		n, err := s.searchTextFile(ctx, p, info, re, func(m searchMatch) {
			st.matches++
			found(m)
		}, searchMaxMatches-st.matches)
		// What was read: all of a text file; of another, what was looked
		// at to tell it isn't text.
		if n >= 0 {
			st.files++
			st.bytes += info.Size()
		} else {
			st.bytes += min(info.Size(), searchPeek)
		}
		if err != nil {
			return err
		}
		if st.matches >= searchMaxMatches {
			st.reason = "it found as many lines as it shows"
			return errSearchStop
		}
		return nil
	}, func(_ string, why error) error {
		// Changed or gone as it was searched: passed over too.
		if errors.Is(why, fs.ErrPermission) {
			st.unreadable++
		}
		return nil
	})
	if errors.Is(err, errSearchStop) {
		err = nil
	}
	return st, err
}

// searchTextFile looks for re in the file at p, of info, if it's text, finding
// at most most lines; it says how many it found, or -1 if it wasn't text.
func (s *downloadStore) searchTextFile(ctx context.Context, p string, info fs.FileInfo, re *regexp.Regexp, found func(searchMatch), most int) (int, error) {
	f, err := s.root.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, nil
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !os.SameFile(st, info) {
		return -1, nil
	}
	r := bufio.NewReaderSize(io.LimitReader(f, searchMaxFile), 64<<10)
	if head, _ := r.Peek(searchPeek); bytes.IndexByte(head, 0) >= 0 {
		return -1, nil // not text
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), searchMaxLine)
	n, line := 0, 0
	for sc.Scan() {
		line++
		if line%1024 == 0 && ctx.Err() != nil {
			return n, ctx.Err()
		}
		b := sc.Bytes()
		if !re.Match(b) {
			continue
		}
		// Shown as text: where it matches in that, not in the bytes, which
		// may not be valid UTF-8 before it.
		text := strings.ToValidUTF8(string(bytes.TrimRight(b, "\r")), "\uFFFD")
		loc := re.FindStringIndex(text)
		if loc == nil {
			continue
		}
		found(searchMatch{Path: p, Line: line,
			Before: cut(text[:loc[0]], searchContext, true),
			Match:  cut(text[loc[0]:loc[1]], 2*searchContext, false),
			After:  cut(text[loc[1]:], searchContext, false)})
		if n++; n >= min(most, searchPerFile) {
			break
		}
	}
	return n, nil // a line too long ends it, as an unreadable part does
}

// tunnelSearch answers a search request (see tunnelRequest.Query). Accepted
// ({"in": the folder looked in}), it sends {"found": [searchMatch]} as it
// finds them, and ends with {"files" read, "matches", and "stopped"
// saying why it stopped short, if it did}. A text message cancels it, as
// the page going does.
func (g *fileService) tunnelSearch(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	re, err := searchQuery(req)
	if err != nil {
		r.fail(err.Error())
		return
	}
	store, err := g.openStore()
	if err != nil {
		r.fail(errDownloadsMissing.Error())
		return
	}
	defer store.Close()
	asked := path.Clean(strings.Trim(req.Path, "/"))
	dir, err := store.canonical(asked)
	if err != nil {
		r.fail(errNoFolder.Error())
		return
	}
	info, err := store.root.Lstat(dir)
	if err != nil || !info.IsDir() || store.trashPathHere(dir) {
		r.fail(errNoFolder.Error())
		return
	}
	// Found where it was asked for, as the page has it, though it may be
	// through a link: under asked, not dir.
	shown := func(p string) string {
		if dir != "." {
			p = strings.TrimPrefix(strings.TrimPrefix(p, dir), "/")
		}
		return path.Join(asked, p)
	}
	// A few at once, over the whole gateway: each can read hundreds of
	// megabytes, and the desktop and terminals are served beside them.
	select {
	case textSearchSlots <- struct{}{}:
		defer func() { <-textSearchSlots }()
	default:
		r.fail("Other searches are going on: stop one, or wait for it, then search again.")
		return
	}
	if !r.accept(map[string]any{"in": asked}) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var cancelled atomic.Bool
	gone := cancelOnText(t, func() { cancelled.Store(true); cancel() })
	go func() {
		select {
		case <-gone:
			cancel()
		case <-ctx.Done():
		}
	}()
	var batch []searchMatch
	last := time.Now()
	flush := func() {
		if len(batch) > 0 {
			if writeJSON(t, map[string]any{"found": batch}) != nil {
				cancel()
			}
			batch, last = nil, time.Now()
		}
	}
	st, err := store.searchText(ctx, dir, info, re, func(m searchMatch) {
		m.Path = shown(m.Path)
		batch = append(batch, m)
		if len(batch) >= searchBatch || time.Since(last) > 200*time.Millisecond {
			flush()
		}
	})
	flush()
	if err != nil && !errors.Is(err, context.Canceled) {
		r.fail("The search stopped: " + uploadError(err))
		return
	}
	if cancelled.Load() || ctx.Err() != nil {
		r.fail("cancelled")
		return
	}
	r.finish(map[string]any{"files": st.files, "matches": st.matches, "stopped": st.reason, "unreadable": st.unreadable})
}
