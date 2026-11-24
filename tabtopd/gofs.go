package main

// File System Access requests are kept apart from the other device APIs.
// The viewer retains native handles; open-file bytes are staged to the
// engine's private run directory and then exposed as a disk-backed File.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type goFSRequest struct {
	Handle        string `json:"handle,omitempty"`
	Name          string `json:"name,omitempty"`
	Size          int64  `json:"size,omitempty"`
	Offset        int64  `json:"offset,omitempty"`
	Value         string `json:"value,omitempty"`
	FileID        string `json:"fileId,omitempty"`
	PickerOptions struct {
		Multiple  bool              `json:"multiple"`
		Types     []json.RawMessage `json:"types"`
		Exclude   bool              `json:"excludeAcceptAllOption"`
		Suggested string            `json:"suggestedName"`
	} `json:"pickerOptions,omitempty"`
}

type goFSHandle struct {
	// write: a save destination's (fs-save), the only kind written; an
	// opened file's is read only, as the person chose it to be.
	write                        bool
	name, mime, path, enginePath string
	size, modified               int64
	gen, world                   int
	transfer                     string
	waiters                      []string
}

type goFSRead struct {
	token, handle, name, path, enginePath string
	gen, world                            int
	size, modified                        int64
	dir                                   string
	file                                  *os.File
	started                               bool
	waiters                               []string
}

type goFileSystem struct {
	mu       sync.Mutex
	handles  map[string]*goFSHandle // viewer's random handle -> its server-side metadata
	reads    map[string]*goFSRead   // transfer token -> staged read
	byFile   map[string]*goFSRead   // viewer handle -> active staged read
	total    int64                  // staged bytes retained for this page
	reserved int64                  // reads in progress, included in the per-tab budget
	// writes: a saved file's pieces sent to the person's browser, not yet
	// answered (by the token it's asked by), so many at once.
	writes map[string]*goDevicePending
}

// goFSWritesMax is how many of a page's file pieces (fs-write) may be with
// the person's browser at once: the page sends 32 (godevice.js).
const goFSWritesMax = 64

// fsWritable: handle is a save destination of this page's, in world.
func (b *goBrowser) fsWritable(handle string, gen, world int) bool {
	b.fs.mu.Lock()
	defer b.fs.mu.Unlock()
	h := b.fs.handles[handle]
	return h != nil && h.write && h.gen == gen && h.world == world
}

// fsWrite sends a piece of a saved file to the person's browser, without
// waiting for the one before it to be answered (deviceAnswer: fsWriteAnswer).
func (b *goBrowser) fsWrite(gen int, origin string, a goDeviceAsk) {
	if b.fs.writes == nil {
		b.fs.writes = make(map[string]*goDevicePending)
	}
	if len(b.fs.writes) >= goFSWritesMax {
		b.agentCall(b.world, "deviceReply", map[string]any{"id": a.ID, "error": "InvalidStateError"})
		return
	}
	p := &goDevicePending{a.ID, goToken(), a.Kind, gen, b.world, time.Now()}
	b.fs.writes[p.token] = p
	b.send(map[string]any{"type": "go-device", "gen": gen, "ask": p.token, "origin": origin, "kind": a.Kind, "fs": a.FS})
}

// fsWriteAnswer answers the page's piece the person's browser has written
// (or failed to); false if m's for none.
func (b *goBrowser) fsWriteAnswer(m goClientMsg) bool {
	p := b.fs.writes[m.Text]
	if p == nil {
		return false
	}
	delete(b.fs.writes, m.Text)
	if p.gen != b.gen || p.world != b.world {
		return true
	}
	reply := map[string]any{"id": p.id}
	if !m.Accept {
		reply["error"] = goDeviceError(m.Value)
	}
	b.agentCall(p.world, "deviceReply", reply)
	return true
}

func validGoFSAsk(kind string, fs *goFSRequest) bool {
	if fs == nil || len(fs.Value) > 48<<10 {
		return false
	}
	switch kind {
	case "fs-open":
		return fs.Handle == "" && fs.Name == "" && fs.Value == "" && fs.Size == 0 && fs.Offset == 0 && len(fs.PickerOptions.Types) <= 16 && pickerTypesSize(fs.PickerOptions.Types) <= 8<<10
	case "fs-save":
		return fs.Handle == "" && len(fs.Name) <= 255 && len(fs.PickerOptions.Types) <= 16 && pickerTypesSize(fs.PickerOptions.Types) <= 8<<10
	case "fs-read":
		return goPasteID.MatchString(fs.Handle) && goPasteID.MatchString(fs.FileID) && fs.Value == "" && fs.Size == 0 && fs.Offset == 0
	case "fs-begin":
		return goPasteID.MatchString(fs.Handle) && (fs.Value == "" || fs.Value == "keep")
	case "fs-write":
		if !goPasteID.MatchString(fs.Handle) || fs.Offset < 0 || len(fs.Value) > base64.StdEncoding.EncodedLen(24<<10) {
			return false
		}
		data, err := base64.StdEncoding.Strict().DecodeString(fs.Value)
		return err == nil && len(data) <= 24<<10
	case "fs-truncate":
		return goPasteID.MatchString(fs.Handle) && fs.Size >= 0 && fs.Value == ""
	case "fs-close", "fs-abort":
		return goPasteID.MatchString(fs.Handle) && fs.Value == ""
	default:
		return false
	}
}

func pickerTypesSize(types []json.RawMessage) int {
	size := 0
	for _, typ := range types {
		if !json.Valid(typ) {
			return 1 << 30
		}
		size += len(typ)
	}
	return size
}

// validateGoFSReply validates native picker results before the page sees
// them. The 512 MiB bound matches /go's existing per-file upload policy.
func validateGoFSReply(kind, value string) (map[string]any, string) {
	if kind == "fs-open" {
		var result struct {
			Files []struct {
				Handle       string `json:"handle"`
				Name         string `json:"name"`
				Type         string `json:"type"`
				Size         int64  `json:"size"`
				LastModified int64  `json:"lastModified"`
			} `json:"files"`
		}
		if len(value) > 32<<10 || json.Unmarshal([]byte(value), &result) != nil || len(result.Files) == 0 || len(result.Files) > 32 {
			return nil, "DataError"
		}
		for _, f := range result.Files {
			if !goPasteID.MatchString(f.Handle) || !validFSHandleName(f.Name) || len(f.Type) > 128 || f.Size < 0 || f.Size > goUploadFileMax {
				return nil, "NotSupportedError"
			}
		}
		return map[string]any{"value": value}, ""
	}
	if kind == "fs-save" {
		var result struct {
			Handle string `json:"handle"`
			Name   string `json:"name"`
			Size   int64  `json:"size"`
		}
		if len(value) > 2048 || json.Unmarshal([]byte(value), &result) != nil || !goPasteID.MatchString(result.Handle) || !validFSHandleName(result.Name) || result.Size < 0 || result.Size > goUploadFileMax {
			return nil, "DataError"
		}
		return map[string]any{"value": value}, ""
	}
	if strings.HasPrefix(kind, "fs-") {
		return map[string]any{"value": value}, ""
	}
	return nil, "DataError"
}

// rememberFSHandles keeps the handles a picker gave (fs-open's files, or
// fs-save's one), so the page can read them (getFile: fsReadRequest).
func (b *goBrowser) rememberFSHandles(kind, value string, gen, world int) bool {
	var result struct {
		Files []struct {
			Handle       string `json:"handle"`
			Name         string `json:"name"`
			Type         string `json:"type"`
			Size         int64  `json:"size"`
			LastModified int64  `json:"lastModified"`
		} `json:"files"`
	}
	if kind == "fs-save" {
		value = `{"files":[` + value + `]}`
	}
	if json.Unmarshal([]byte(value), &result) != nil {
		return false
	}
	b.fs.mu.Lock()
	defer b.fs.mu.Unlock()
	if b.fs.handles == nil {
		b.fs.handles = make(map[string]*goFSHandle)
	}
	for _, f := range result.Files {
		b.fs.handles[f.Handle] = &goFSHandle{write: kind == "fs-save", name: f.Name, mime: f.Type, size: f.Size, modified: f.LastModified, gen: gen, world: world}
	}
	return true
}

// fsReadRequest accepts a page's getFile() request, starts one binary upload
// from the viewer, and immediately releases the page's RPC. Once staged,
// CDP attaches the temp path to a hidden file input and the page gets the
// engine's native, disk-backed File object.
func (b *goBrowser) fsReadRequest(gen, world int, requestID string, fs *goFSRequest) {
	b.fs.mu.Lock()
	h := b.fs.handles[fs.Handle]
	if h == nil || h.gen != gen || h.world != world {
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotAllowedError"})
		return
	}
	if h.path != "" {
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "value": `{"staged":true}`})
		b.deliverFSFile(gen, world, requestID, fs.FileID, h.enginePath)
		return
	}
	if h.transfer != "" {
		r := b.fs.reads[h.transfer]
		if r == nil {
			b.fs.mu.Unlock()
			b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotReadableError"})
			return
		}
		r.waiters = append(r.waiters, fs.FileID)
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "value": `{"staged":true}`})
		return
	}
	if h.size > goUploadFileMax || b.fs.total+b.fs.reserved+h.size > goUploadTabMax {
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotSupportedError"})
		return
	}
	hostDir, engineDir := b.e.uploadsDir()
	if err := os.MkdirAll(hostDir, 0o700); err != nil {
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotReadableError"})
		return
	}
	if free, _, ok := diskSpace(hostDir); ok && free-h.size < goUploadKeepFree {
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotReadableError"})
		return
	}
	dir, err := os.MkdirTemp(hostDir, ".tabtop-fs-*")
	if err != nil {
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotReadableError"})
		return
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		os.RemoveAll(dir)
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotReadableError"})
		return
	}
	filePath := filepath.Join(dir, h.name)
	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		os.RemoveAll(dir)
		b.fs.mu.Unlock()
		b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "error": "NotReadableError"})
		return
	}
	token := goToken()
	if b.fs.reads == nil {
		b.fs.reads = make(map[string]*goFSRead)
	}
	rel, _ := filepath.Rel(hostDir, filePath)
	r := &goFSRead{token: token, handle: fs.Handle, name: h.name, path: filePath, dir: dir, enginePath: path.Join(engineDir, filepath.ToSlash(rel)), gen: gen, world: world, size: h.size, modified: h.modified, file: f, waiters: []string{fs.FileID}}
	h.transfer = token
	b.fs.reads[token] = r
	b.fs.byFile = ensureGoFSReadMap(b.fs.byFile)
	b.fs.byFile[fs.Handle] = r
	b.fs.reserved += h.size
	b.fs.mu.Unlock()
	b.send(map[string]any{"type": "go-fs-read", "gen": gen, "transfer": token, "handle": fs.Handle, "name": h.name, "size": h.size, "origin": goOrigin(b.docURL)})
	b.agentCall(world, "deviceReply", map[string]any{"id": requestID, "value": `{"staged":true}`})
}

func ensureGoFSReadMap(m map[string]*goFSRead) map[string]*goFSRead {
	if m == nil {
		return make(map[string]*goFSRead)
	}
	return m
}

func (b *goBrowser) fsReadTransfer(token string, size, modified int64) (*goFSRead, error) {
	b.fs.mu.Lock()
	defer b.fs.mu.Unlock()
	r := b.fs.reads[token]
	// (Not b.gen: this runs on the tunnel's goroutine. A read of a page
	// left is gone from reads already: resetFileSystem.)
	if r == nil || r.started || size < 0 || size > goUploadFileMax || b.fs.total+b.fs.reserved-r.size+size > goUploadTabMax {
		return nil, errors.New("That picked file is no longer being read.")
	}
	b.fs.reserved += size - r.size
	r.size, r.modified = size, modified
	if h := b.fs.handles[r.handle]; h != nil {
		h.size, h.modified = size, modified
	}
	r.started = true
	return r, nil
}

// routeGoFSUpload streams one user-picked file into the engine's run
// directory. Its binary window and acknowledgements match go-upload, but
// the file is private staging for getFile(), never a file in /fs/.
func (g *server) routeGoFSUpload(c *tunnelCall) {
	if !g.goOn || g.goMode == goUnavailable {
		c.r.fail("The remote browser is turned off or unavailable.")
		return
	}
	tab := g.goTabList().find(c.req.GoTab, c.session)
	if tab == nil {
		c.r.fail("That tab's gone.")
		return
	}
	r, err := tab.b.fsReadTransfer(c.req.Transfer, c.req.Size, c.req.Modified)
	if err != nil || c.req.Size != r.size {
		c.r.fail("That picked file is no longer being read.")
		return
	}
	ok := false
	// Finished on the tab's own goroutine, where its page's generation and
	// world are read (fsReadFinished).
	defer func() { tab.b.post(func() { tab.b.fsReadFinished(r.token, ok) }) }()
	t := c.t
	t.c.SetReadLimit(fileChunk + tunnelOverhead)
	if !c.r.accept(map[string]any{"offset": 0}) {
		return
	}
	for got := int64(0); got < r.size; {
		ctx, cancel := context.WithTimeout(context.Background(), fileStall)
		typ, data, readErr := t.Read(ctx)
		cancel()
		if readErr != nil || typ == websocket.MessageText {
			return
		}
		if typ != websocket.MessageBinary || len(data) == 0 || got+int64(len(data)) > r.size {
			t.Close(websocket.StatusPolicyViolation, "bad file stream")
			return
		}
		if _, err = r.file.Write(data); err != nil {
			c.r.fail("The picked file couldn't be staged for the page.")
			return
		}
		got += int64(len(data))
		ctx, cancel = context.WithTimeout(context.Background(), tunnelTimeout)
		err = t.Write(ctx, websocket.MessageBinary, nil)
		cancel()
		if err != nil {
			return
		}
	}
	if err = r.file.Sync(); err != nil {
		c.r.fail("The picked file couldn't be staged for the page.")
		return
	}
	ok = true
	c.r.finish(map[string]any{"name": filepath.Base(r.path), "size": r.size})
}

func (b *goBrowser) fsReadFinished(token string, ok bool) {
	b.fs.mu.Lock()
	r := b.fs.reads[token]
	if r == nil {
		b.fs.mu.Unlock()
		return
	}
	delete(b.fs.reads, token)
	delete(b.fs.byFile, r.handle)
	b.fs.reserved -= r.size
	h := b.fs.handles[r.handle]
	if h != nil {
		h.transfer = ""
	}
	if ok && h != nil && r.gen == b.gen {
		h.path, h.enginePath = r.path, r.enginePath
		b.fs.total += r.size
	} else {
		os.RemoveAll(r.dir)
	}
	if r.file != nil {
		r.file.Close()
		r.file = nil
	}
	waiters := append([]string(nil), r.waiters...)
	b.fs.mu.Unlock()
	if !ok || h == nil || r.gen != b.gen {
		for _, id := range waiters {
			b.agentCall(r.world, "fsReadError", id, "NotReadableError")
		}
		return
	}
	if r.modified > 0 && r.modified < 1<<53 {
		modified := time.UnixMilli(r.modified)
		_ = os.Chtimes(r.path, modified, modified)
	}
	for _, id := range waiters {
		b.deliverFSFile(r.gen, r.world, "", id, r.enginePath)
	}
}

// fsWritten: a write to handle closed, so a copy staged before it is out of
// date (staged again at the next getFile).
func (b *goBrowser) fsWritten(handle string) {
	b.fs.mu.Lock()
	defer b.fs.mu.Unlock()
	h := b.fs.handles[handle]
	if h == nil || h.path == "" {
		return
	}
	os.RemoveAll(filepath.Dir(h.path))
	b.fs.total -= h.size
	h.path, h.enginePath = "", ""
}

func (b *goBrowser) abortFSRead(token string) {
	b.fs.mu.Lock()
	r := b.fs.reads[token]
	b.fs.mu.Unlock()
	if r != nil {
		b.fsReadFinished(token, false)
	}
}

func (b *goBrowser) deliverFSFile(gen, world int, _ string, fileID, enginePath string) {
	if !goPasteID.MatchString(fileID) {
		return
	}
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goActTimeout)
		defer cancel()
		inputID := "__tabtop_fs_" + fileID
		idJSON, _ := json.Marshal(inputID)
		// (Each says "true": evaluate reads a string. The page's world is
		// told the input's id, as text, and takes its File from the
		// document both worlds share: an object in an event's detail
		// isn't passed from this world to the page's.)
		_, _, err := b.evaluate(ctx, world, `(()=>{const id=`+string(idJSON)+`;let i=document.getElementById(id);if(!i){i=document.createElement("input");i.type="file";i.hidden=true;i.id=id;(document.body||document.documentElement).append(i)}return "true"})()`)
		if err != nil {
			return err
		}
		var doc struct {
			Root struct {
				NodeID int `json:"nodeId"`
			} `json:"root"`
		}
		if err = b.cdp.call(ctx, b.page, "DOM.getDocument", map[string]any{"depth": 0, "pierce": true}, &doc); err != nil || doc.Root.NodeID == 0 {
			return errors.New("document unavailable")
		}
		var node struct {
			NodeID int `json:"nodeId"`
		}
		if err = b.cdp.call(ctx, b.page, "DOM.querySelector", map[string]any{"nodeId": doc.Root.NodeID, "selector": "#" + inputID}, &node); err != nil || node.NodeID == 0 {
			return errors.New("file input unavailable")
		}
		if err = b.cdp.call(ctx, b.page, "DOM.setFileInputFiles", map[string]any{"nodeId": node.NodeID, "files": []string{enginePath}}, nil); err != nil {
			return err
		}
		fileIDJSON, _ := json.Marshal(fileID)
		_, value, err := b.evaluate(ctx, world, `(()=>{const id=`+string(idJSON)+`,f=document.getElementById(id)?.files?.[0];if(!f)return "false";document.dispatchEvent(new CustomEvent("__tabtop_fs_file",{detail:JSON.stringify({id:`+string(fileIDJSON)+`,input:id})}));document.getElementById(id)?.remove();return "true"})()`)
		if err != nil || value != "true" {
			return errors.New("file couldn't be attached")
		}
		return nil
	}, func(result any) {
		// A navigation or viewer change invalidates the isolated world. In
		// particular, don't report a late staging error into the next page.
		if b.gen != gen || b.world != world {
			return
		}
		if err, ok := result.(error); ok && err != nil {
			b.agentCall(world, "fsReadError", fileID, "NotReadableError")
		}
	})
}

func (b *goBrowser) resetFileSystem() {
	b.fs.mu.Lock()
	for _, r := range b.fs.reads {
		if r.file != nil {
			r.file.Close()
		}
		os.RemoveAll(r.dir)
	}
	for _, h := range b.fs.handles {
		if h.path != "" {
			os.RemoveAll(filepath.Dir(h.path))
		}
	}
	b.fs.handles = nil
	b.fs.writes = nil
	b.fs.reads = nil
	b.fs.byFile = nil
	b.fs.total = 0
	b.fs.reserved = 0
	b.fs.mu.Unlock()
}

func validFSHandleName(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= 255 && !strings.ContainsAny(name, "/\\\x00")
}
