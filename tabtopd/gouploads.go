package main

// File inputs: a page's <input type=file>. The engine's chooser isn't
// shown (Page.setInterceptFileChooserDialog); it's told (fileChooserOpened,
// with the input), and the person's own browser asks them for files
// (go.js), which it sends here (the go-upload request) into the engine's
// run directory, where the engine reads them (bound at /run/tt, read-only,
// when it's sandboxed); then they're put in the input (DOM.setFileInputFiles),
// as the page's own: it has its input and change events, and the files,
// to read or send (measured in Moli: sandboxed, in another origin's frame
// too). They're kept while the engine runs (a form sends them as it's
// submitted, after), and go with its run directory.
//
// Moli tells of a chooser opened by script without a person's gesture too
// (measured: a timer's input.click()); a browser opens none then, so it's
// passed on only shortly after the person's own input here.
//
// Files dropped on the page are sent so too (a drop's token, asked for as
// they're dropped), then dropped there as the engine's drag (Input.
// dispatchDragEvent, with their paths): one drop each, as Moli gives a
// page only the first of a drop's files (measured, 1.1.27), at the same
// place, one after another. (Their type, as a page reads it, is empty in
// Moli: measured.)

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	goUploadFileMax  = 512 << 20 // a file
	goUploadTabMax   = 1 << 30   // all a tab's, kept while its engine runs
	goUploadCountMax = 32        // a chooser's files
	goUploadKeepFree = 256 << 20 // the disk left free
	// goChooserAfterInput is how long after the person's input a chooser
	// the page opens is theirs (a browser's transient activation is 5 s).
	goChooserAfterInput = 5 * time.Second
	// goChooserFor is how long a chooser waits for its files.
	goChooserFor = 10 * time.Minute
)

// goUploads is a tab's chooser waiting for files, and what it's kept.
// The go-upload requests come on their own goroutines: under mu.
type goUploads struct {
	mu      sync.Mutex
	chooser *goChooser
	total   int64 // the bytes kept
	next    int   // the next directory's number
}

type goChooser struct {
	token    string
	gen      int
	backend  int    // the input, in the engine
	multiple bool   //
	dir      string // the run directory's uploads (the host's path)
	engine   string // the same, as the engine sees it
	opened   time.Time
	files    []*goUpload
}

type goUpload struct {
	path, engine string // the file, the host's path and the engine's
	size         int64
	done         bool
	dropped      bool // let go with its chooser (removed, not counted)
}

// fileChooserOpened is the engine's chooser for an input, opened by the
// page: passed on to the person's browser, if it followed their input.
func (b *goBrowser) fileChooserOpened(ev cdpEvent) {
	var p struct {
		Mode          string `json:"mode"`
		BackendNodeID int    `json:"backendNodeId"`
	}
	if json.Unmarshal(ev.Params, &p) != nil || p.BackendNodeID == 0 {
		return
	}
	if b.inputGen != b.gen || time.Since(b.inputAt) > goChooserAfterInput || b.shown != b.gen || b.e == nil {
		goDebugf("file chooser: not after the person's input: not passed on")
		return
	}
	gen, backend := b.gen, p.BackendNodeID
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		var d struct {
			Node struct {
				Attributes []string `json:"attributes"`
			} `json:"node"`
		}
		if b.cdp.call(ctx, b.page, "DOM.describeNode", map[string]any{"backendNodeId": backend}, &d) != nil {
			return nil
		}
		return d.Node.Attributes
	}, func(r any) {
		attrs, _ := r.([]string)
		if gen != b.gen || attrs == nil {
			return
		}
		var accept string
		for i := 0; i+1 < len(attrs); i += 2 {
			switch strings.ToLower(attrs[i]) {
			case "accept":
				accept = attrs[i+1]
			case "webkitdirectory", "directory":
				b.send(map[string]any{"type": "go-file-chooser-refused", "gen": gen, "why": "The page asks for a folder, which can't be sent to it here."})
				return
			}
		}
		if len(accept) > 512 {
			accept = ""
		}
		c := &goChooser{token: goToken(), gen: gen, backend: backend, multiple: p.Mode == "selectMultiple", opened: time.Now()}
		c.dir, c.engine = b.e.uploadsDir()
		b.uploads.open(c)
		b.send(map[string]any{"type": "go-file-chooser", "gen": gen, "chooser": c.token, "multiple": c.multiple, "accept": accept})
	})
}

// uploadsDir is where an engine's uploads go: the host's path, and the
// engine's.
func (e *goEngine) uploadsDir() (host, engine string) {
	host = filepath.Join(e.run, "uploads")
	if e.cfg.mode == goSandboxed {
		return host, "/run/tt/uploads"
	}
	return host, host
}

// open makes c the chooser waiting for files; one waiting before is let
// go, with what it had.
func (u *goUploads) open(c *goChooser) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.dropLocked()
	u.chooser = c
}

// dropLocked lets the chooser waiting go, its files removed.
func (u *goUploads) dropLocked() {
	c := u.chooser
	if c == nil {
		return
	}
	u.chooser = nil
	for _, f := range c.files {
		os.Remove(f.path)
		os.Remove(filepath.Dir(f.path))
		u.total -= f.size
		f.dropped = true
	}
}

var (
	errUploadChooser = errors.New("The page isn't asking for files now.")
	errUploadMany    = fmt.Errorf("At most %d files can be sent to a page at once.", goUploadCountMax)
)

// begin makes the file name of size for the chooser of token: its place,
// made and open for writing.
func (u *goUploads) begin(token, name string, size int64) (*goUpload, *os.File, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	c := u.chooser
	if c == nil || token == "" || c.token != token || time.Since(c.opened) > goChooserFor {
		return nil, nil, errUploadChooser
	}
	name = goUploadName(name)
	switch {
	case name == "" || size < 0:
		return nil, nil, errors.New("That file's name or size isn't one a page can be given.")
	case len(c.files) >= goUploadCountMax || !c.multiple && len(c.files) >= 1:
		return nil, nil, errUploadMany
	case size > goUploadFileMax:
		return nil, nil, fmt.Errorf("It's %s: a page can be sent files of %s at most here.", humanSize(size), humanSize(goUploadFileMax))
	case u.total+size > goUploadTabMax:
		return nil, nil, fmt.Errorf("This tab's pages have been sent %s already: %s at most, till it's closed.", humanSize(u.total), humanSize(goUploadTabMax))
	}
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return nil, nil, errors.New("The file couldn't be kept for the page.")
	}
	if free, _, ok := diskSpace(c.dir); ok && free-size < goUploadKeepFree {
		return nil, nil, fmt.Errorf("There isn't room for it: it's %s, and %s is free.", humanSize(size), humanSize(max(free-goUploadKeepFree, 0)))
	}
	// Each in a directory of its own, so it keeps its name (the page's
	// File's), the same as another's or not.
	u.next++
	sub := strconv.Itoa(u.next)
	if err := os.Mkdir(filepath.Join(c.dir, sub), 0o755); err != nil {
		return nil, nil, errors.New("The file couldn't be kept for the page.")
	}
	f := &goUpload{path: filepath.Join(c.dir, sub, name), engine: c.engine + "/" + sub + "/" + name, size: size}
	w, err := os.OpenFile(f.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		os.Remove(filepath.Dir(f.path))
		return nil, nil, errors.New("The file couldn't be kept for the page.")
	}
	c.files = append(c.files, f)
	u.total += size
	return f, w, nil
}

// finish says f's all there, or, failed, lets it go.
func (u *goUploads) finish(f *goUpload, ok bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if f.dropped {
		return // (removed with its chooser)
	}
	if ok {
		f.done = true
		return
	}
	os.Remove(f.path)
	os.Remove(filepath.Dir(f.path))
	u.total -= f.size
	if c := u.chooser; c != nil {
		for i, g := range c.files {
			if g == f {
				c.files = append(c.files[:i], c.files[i+1:]...)
				break
			}
		}
	}
}

// take is the chooser of token, done with, if its count files are all
// there: their paths, as the engine sees them; and the input.
func (u *goUploads) take(token string, count int) (paths []string, backend, gen int, ok bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	c := u.chooser
	if c == nil || c.token != token {
		return nil, 0, 0, false
	}
	if count <= 0 || count != len(c.files) {
		u.dropLocked() // cancelled, or not all sent
		return nil, 0, 0, false
	}
	for _, f := range c.files {
		if !f.done {
			u.dropLocked()
			return nil, 0, 0, false
		}
		paths = append(paths, f.engine)
	}
	u.chooser = nil // kept: the page has them
	return paths, c.backend, c.gen, true
}

// chooseFiles is the person's answer to a chooser (Text, its token): Count
// files sent, or none (cancelled). They're put in the page's input.
func (b *goBrowser) chooseFiles(m goClientMsg) {
	paths, backend, gen, ok := b.uploads.take(m.Text, m.Count)
	if !ok {
		return
	}
	if gen != b.gen {
		b.send(map[string]any{"type": "go-file-chooser-refused", "gen": b.gen, "why": "The page went on before the files were sent: they weren't given to it."})
		return
	}
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		return b.cdp.call(ctx, b.page, "DOM.setFileInputFiles", map[string]any{"files": paths, "backendNodeId": backend}, nil)
	}, func(r any) {
		if err, _ := r.(error); err != nil {
			goDebugf("file chooser: setFileInputFiles: %v", err)
			b.send(map[string]any{"type": "go-file-chooser-refused", "gen": b.gen, "why": "The files couldn't be given to the page (its field may be gone)."})
			return
		}
		b.changed(0) // what the page does with them
	})
}

// dropStart is files dropped on the page (Count of them, in generation
// Gen): a chooser of no input, its token sent for them.
func (b *goBrowser) dropStart(m goClientMsg) {
	if m.Gen != b.gen || b.shown != b.gen || b.e == nil || m.Count <= 0 {
		return
	}
	if m.Count > goUploadCountMax {
		b.send(map[string]any{"type": "go-file-chooser-refused", "gen": b.gen, "why": errUploadMany.Error()})
		return
	}
	c := &goChooser{token: goToken(), gen: b.gen, multiple: true, opened: time.Now()}
	c.dir, c.engine = b.e.uploadsDir()
	b.uploads.open(c)
	b.send(map[string]any{"type": "go-drop-ready", "gen": b.gen, "token": c.token})
}

// dropFiles drops the files sent for a drop (Text, its token; Count of
// them) where they were dropped (ID, FX, FY, as a press's place is): each
// a drop of its own.
func (b *goBrowser) dropFiles(m goClientMsg) {
	paths, _, gen, ok := b.uploads.take(m.Text, m.Count)
	if !ok {
		return
	}
	if gen != b.gen || b.shown != b.gen {
		b.send(map[string]any{"type": "go-file-chooser-refused", "gen": b.gen, "why": "The page went on before the files were sent: they weren't dropped on it."})
		return
	}
	if m.Frame != 0 {
		b.dropInFrame(m, paths, gen)
		return
	}
	world := b.world
	b.movesFirst()
	b.acts.add(func() {
		// A drag of text going (another drop's): done with first.
		b.input.drag(b, world, gen, goClientMsg{Type: "cancel"})
		ctx, cancel := context.WithTimeout(context.Background(), goInputWait*time.Duration(1+len(paths)))
		defer cancel()
		x, y, ok := b.at(ctx, world, m.ID, m.FX, m.FY)
		if !ok {
			b.post(func() {
				b.send(map[string]any{"type": "go-file-chooser-refused", "gen": gen, "why": "Where the files were dropped is gone from the page: they weren't dropped on it."})
			})
			return
		}
		for _, p := range paths {
			data := map[string]any{"items": []any{}, "files": []string{p}, "dragOperationsMask": 1 | 2 | 16}
			for _, typ := range []string{"dragEnter", "dragOver", "drop"} {
				err := b.cdp.call(ctx, b.page, "Input.dispatchDragEvent", map[string]any{"type": typ, "x": x, "y": y, "data": data, "modifiers": goModifiers(m)}, nil)
				goDebugf("input %s of a file at %.0f,%.0f: %v", typ, x, y, err)
			}
		}
		b.post(func() { b.afterInput(gen) })
	})
}

// dropInFrame drops the files sent for a drop on an embedded page (m.ID its
// iframe, m.Frame the element there, by the path to it: Route, Docs),
// which the engine's own drag can't be aimed into: put in a hidden input
// of that page's (DOM.setFileInputFiles), and given to its page by its
// world (goagent.js dropIn, godrop.js), all in one drop. Only that page's
// world, and only if it's still the document they were dropped on.
func (b *goBrowser) dropInFrame(m goClientMsg, paths []string, gen int) {
	refuse := func(why string) {
		b.send(map[string]any{"type": "go-file-chooser-refused", "gen": gen, "why": why})
	}
	world, child := b.frameWorldPath(m.ID, m.Route, m.Docs)
	if world == 0 || child == nil {
		refuse("The embedded page the files were dropped on is gone: they weren't dropped on it.")
		return
	}
	if !child.same && m.FDoc != world {
		refuse("The embedded page went on before the files were sent: they weren't dropped on it.")
		return
	}
	if b.acts.waiting() >= goActsWaiting {
		refuse("The page is busy: the files weren't dropped on it.")
		return
	}
	var id [8]byte
	rand.Read(id[:])
	input := "__tabtop_drop_" + hex.EncodeToString(id[:])
	inputJSON, _ := json.Marshal(input)
	what, _ := json.Marshal(map[string]any{"input": input, "id": m.Frame, "fx": goClamp(m.FX, 0, 1), "fy": goClamp(m.FY, 0, 1),
		"shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta})
	arg, _ := json.Marshal(string(what))
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goInputWait*time.Duration(2+len(paths)))
		defer cancel()
		var made struct {
			Result struct {
				ObjectID string `json:"objectId"`
			} `json:"result"`
		}
		err := b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"contextId": world, "returnByValue": false,
			"expression": `(()=>{const i=document.createElement("input");i.type="file";i.multiple=true;i.hidden=true;i.id=` + string(inputJSON) + `;(document.body||document.documentElement).append(i);return i})()`}, &made)
		if err == nil && made.Result.ObjectID == "" {
			err = errors.New("no input made")
		}
		if err == nil {
			err = b.cdp.call(ctx, b.page, "DOM.setFileInputFiles", map[string]any{"objectId": made.Result.ObjectID, "files": paths}, nil)
		}
		result := ""
		if err == nil {
			var r struct {
				Result struct {
					Value string `json:"value"`
				} `json:"result"`
			}
			err = b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"contextId": world, "returnByValue": true, "expression": "__tabtop.dropIn(" + string(arg) + ")"}, &r)
			result = r.Result.Value
		}
		if made.Result.ObjectID != "" {
			b.cdp.call(ctx, b.page, "Runtime.releaseObject", map[string]any{"objectId": made.Result.ObjectID}, nil)
		}
		goDebugf("frame %d: %d files dropped: %s %v", m.ID, len(paths), result, err)
		b.post(func() {
			if gen != b.gen {
				return
			}
			if err != nil || result == "gone" || result == "bad" {
				refuse("The files couldn't be dropped on the embedded page.")
			}
			child.due, child.next, b.framesAt = true, time.Time{}, time.Time{} // read again, next round
			b.afterInput(gen)
		})
	})
}

// goUploadName is a file's name as a page's file has it: no folder, no
// characters a path can't hold; "" if there's nothing left.
func goUploadName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' {
			return -1
		}
		return r
	}, name)
	if name == "." || name == ".." || !utf8.ValidString(name) {
		return ""
	}
	for len(name) > 200 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	return strings.TrimSpace(name)
}

// routeGoUpload takes a file for a tab's chooser (go-upload: GoTab, the
// tab's token, its session's only; Chooser, the chooser's; Name, Size and
// Modified), in chunks, each answered, as an upload's are.
func (g *server) routeGoUpload(c *tunnelCall) {
	if !g.goOn || g.goMode == goUnavailable {
		c.r.fail("The remote browser is turned off or unavailable.")
		return
	}
	tab := g.goTabList().find(c.req.GoTab, c.session)
	if tab == nil {
		c.r.fail("That tab's gone.")
		return
	}
	u := &tab.b.uploads
	f, w, err := u.begin(c.req.Chooser, c.req.Name, c.req.Size)
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	ok := false
	defer func() {
		w.Close()
		u.finish(f, ok)
	}()
	t := c.t
	t.c.SetReadLimit(fileChunk + tunnelOverhead)
	if !c.r.accept(map[string]any{"offset": 0}) {
		return
	}
	for got := int64(0); got < c.req.Size; {
		ctx, cancel := context.WithTimeout(context.Background(), fileStall)
		typ, p, err := t.Read(ctx)
		cancel()
		if err != nil || typ == websocket.MessageText {
			return // lost, or cancelled
		}
		if len(p) == 0 || got+int64(len(p)) > c.req.Size {
			t.Close(websocket.StatusPolicyViolation, "bad upload")
			return
		}
		if _, err := w.Write(p); err != nil {
			c.r.fail("The file couldn't be kept for the page.")
			return
		}
		got += int64(len(p))
		ctx, cancel = context.WithTimeout(context.Background(), tunnelTimeout)
		err = t.Write(ctx, websocket.MessageBinary, nil)
		cancel()
		if err != nil {
			return
		}
	}
	if err := w.Close(); err != nil {
		c.r.fail("The file couldn't be kept for the page.")
		return
	}
	// Its time, as the person's browser has it (the page's File's
	// lastModified), if it's one.
	if m := c.req.Modified; m > 0 && m < 1<<53 {
		at := time.UnixMilli(m)
		os.Chtimes(f.path, at, at)
	}
	ok = true
	c.r.finish(map[string]any{"name": filepath.Base(f.path)})
}

// routeGoUploadFromFiles gives a tab's chooser a file from TabTop's own
// Files (go-upload-files: GoTab, the tab's token, its session's only;
// Chooser, the chooser's; Root and Path, the file, read as the session may
// read it): copied here into the chooser's place, as one sent is kept, not
// sent from the person's browser again. The same limits as a file sent.
func (g *server) routeGoUploadFromFiles(c *tunnelCall) {
	if !g.goOn || g.goMode == goUnavailable {
		c.r.fail("The remote browser is turned off or unavailable.")
		return
	}
	tab := g.goTabList().find(c.req.GoTab, c.session)
	if tab == nil {
		c.r.fail("That tab's gone.")
		return
	}
	item, err := c.files.openFile(c.req.Path)
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	defer item.Close()
	size := item.info.Size()
	u := &tab.b.uploads
	f, w, err := u.begin(c.req.Chooser, path.Base(item.name), size)
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	ok := false
	defer func() {
		w.Close()
		u.finish(f, ok)
	}()
	n, err := io.Copy(w, io.LimitReader(item.file, size+1))
	if err != nil || n != size || w.Close() != nil {
		c.r.fail("The file couldn't be kept for the page.")
		return
	}
	at := item.info.ModTime()
	os.Chtimes(f.path, at, at)
	ok = true
	c.r.finish(map[string]any{"name": filepath.Base(f.path), "size": size})
}
