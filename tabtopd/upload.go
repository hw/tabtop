package main

// Uploads into ~/Downloads from the files page, through the tunnel. A file
// is written to a hidden temporary file in its folder first, then linked
// under its name, which never replaces a file already there: a clash gets
// " (1)", " (2)" and so on before the extension instead. Only when the page
// asks to replace (the person chose to) is it renamed over the file
// instead. An upload cut off by the connection is kept a while, so the
// page can carry on from where it stopped rather than send it all again.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

// Uploads in progress are written to files named with this prefix, which
// listings leave out.
const uploadTempPrefix = ".tabtop-upload-"

// The longest a file's name can be, in bytes, on Linux file systems.
const maxNameBytes = 255

// uploadTempName matches exactly the names startUpload makes.
var uploadTempName = regexp.MustCompile(`^` + regexp.QuoteMeta(uploadTempPrefix) + `[0-9a-f]{16}\.part$`)

// removeStaleUploads removes the temporary files under dir of uploads cut
// off by a crash or a forced stop, which no one else removes: those last
// written before started. It runs before the gateway serves anything, so
// none are still going; another gateway sharing dir isn't supported.
// Symlinked folders aren't followed. It returns after budget at most, even
// if a read of the file system hangs, so a huge or slow tree can't hold up
// the start for long: the search stops there, removing nothing more, and
// what it didn't get to waits for the next start.
func removeStaleUploads(dir string, started time.Time, budget time.Duration) {
	if time.Since(started) >= budget {
		return
	}
	var stop atomic.Bool
	removed := make(chan int, 1)
	go func() {
		root, err := os.OpenRoot(dir)
		if err != nil {
			removed <- 0
			return
		}
		defer root.Close()
		removed <- walkStaleUploads(root, []string{"."}, started, &stop)
	}()
	timer := time.NewTimer(budget - time.Since(started))
	defer timer.Stop()
	select {
	case n := <-removed:
		if n > 0 {
			log.Printf("removed %d unfinished uploads left from before a restart", n)
		}
	case <-timer.C:
		stop.Store(true)
		log.Printf("stopped looking for unfinished uploads after %v; the rest are looked for at the next start", budget)
	}
}

// walkStaleUploads does removeStaleUploads's search, until stop, reading
// folders a batch at a time so it can stop part way through a big one,
// starting with dirs. It goes through root, so a folder swapped for a
// symlink while it's queued can't lead it out.
func walkStaleUploads(root *os.Root, dirs []string, started time.Time, stop *atomic.Bool) int {
	n := 0
	for len(dirs) > 0 && !stop.Load() {
		d := dirs[len(dirs)-1]
		dirs = dirs[:len(dirs)-1]
		f, err := root.Open(d)
		if err != nil {
			continue
		}
		for !stop.Load() {
			des, err := f.ReadDir(256)
			for _, de := range des {
				p := path.Join(d, de.Name())
				switch {
				case de.IsDir(): // not a symlink to one: its type is the link's
					dirs = append(dirs, p)
				case de.Type().IsRegular() && uploadTempName.MatchString(de.Name()):
					if info, err := de.Info(); err == nil && info.ModTime().Before(started) && !stop.Load() && root.Remove(p) == nil {
						n++
					}
				}
			}
			if err != nil {
				break
			}
		}
		f.Close()
	}
	return n
}

var (
	errUploadName    = errors.New("That name can't be used for a file.")
	errReplaceFolder = errors.New("A folder has that name, so it can't be replaced.")
)

// validUploadName reports whether name can be a file's name in a folder:
// one path segment, not a temporary upload's.
func validUploadName(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= maxNameBytes && utf8.ValidString(name) &&
		!strings.ContainsAny(name, "/\x00") && !strings.HasPrefix(name, uploadTempPrefix)
}

// upload is a file being uploaded into dir in root.
type upload struct {
	root     *os.Root
	dir, tmp string
	f        *os.File
	unsynced bool // saved, but its folder may not be on disk yet
}

// id names the upload to resume it (see keepPartial): its temporary
// file's random part.
func (u *upload) id() string {
	return strings.TrimSuffix(strings.TrimPrefix(path.Base(u.tmp), uploadTempPrefix), ".part")
}

// startUpload creates the temporary file for an upload into dir.
func startUpload(root *os.Root, dir string) (*upload, error) {
	st, err := root.Stat(dir)
	if err != nil || !st.IsDir() {
		return nil, fs.ErrNotExist
	}
	b := make([]byte, 8)
	rand.Read(b)
	tmp := path.Join(dir, uploadTempPrefix+hex.EncodeToString(b)+".part")
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	return &upload{root: root, dir: dir, tmp: tmp, f: f}, nil
}

func (u *upload) Write(p []byte) (int, error) { return u.f.Write(p) }

// abort removes the temporary file.
func (u *upload) abort() {
	u.f.Close()
	u.root.Remove(u.tmp)
}

// finish saves the upload as name, or as the first free name like it, and
// returns the name it got. With replace, it's saved as name even if a file
// has that name, replacing it in one step, but never a folder.
func (u *upload) finish(name string, replace bool) (string, error) {
	defer u.root.Remove(u.tmp)
	// On disk before the page is told it's saved, so a power cut can't
	// lose it after.
	if err := u.f.Sync(); err != nil {
		u.f.Close()
		return "", err
	}
	if err := u.f.Close(); err != nil {
		return "", err
	}
	ext := path.Ext(name)
	if ext == name {
		ext = "" // ".bashrc" is all name
	}
	base := strings.TrimSuffix(name, ext)
	if replace {
		target := path.Join(u.dir, name)
		if st, err := u.root.Lstat(target); err == nil && st.IsDir() {
			return "", errReplaceFolder
		}
		if err := u.root.Rename(u.tmp, target); err != nil {
			return "", err
		}
		if err := syncDir(u.root, u.dir); err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOTSUP) {
			log.Printf("upload saved as %s, but syncing its folder failed: %v", target, err)
			u.unsynced = true
		}
		return name, nil
	}
	for i := 0; i < 1000; i++ {
		got := name
		if i > 0 {
			got = numberedName(base, ext, i)
		}
		// Unlike a rename, a link fails rather than replace a file.
		err := u.root.Link(u.tmp, path.Join(u.dir, got))
		if err == nil {
			// And the folder, so the name is. If that fails, the file is
			// still saved, so the upload is too, with a warning; unless
			// the file system can't sync a folder at all, where the file
			// being synced is as far as it goes (and saying so on every
			// upload would only be noise).
			if err := syncDir(u.root, u.dir); err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOTSUP) {
				log.Printf("upload saved as %s, but syncing its folder failed: %v", path.Join(u.dir, got), err)
				u.unsynced = true
			}
			return got, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", errors.New("too many files with that name")
}

const (
	// How long an upload cut off is kept to resume.
	partialKeep = time.Hour
	// Uploads cut off kept at once; past that, the oldest goes.
	maxPartials = 16
)

// partialUpload is an upload cut off, kept to resume: its temporary file,
// in its folder dir, holding held bytes of a file size bytes long.
type partialUpload struct {
	dir, tmp   string
	size, held int64
	kept     time.Time
	timer    *time.Timer
}

// keepPartial keeps u, an upload of a file size bytes long cut off by the
// connection, for partialKeep, so the page can resume it by its id with
// claimPartial; after that, or once maxPartials newer ones are kept, it's
// deleted, or sooner if an upload needs the room (see reclaimPartials). A
// restart deletes it too (see removeStaleUploads).
func (g *server) keepPartial(u *upload, size int64) {
	held := int64(0)
	if st, err := u.f.Stat(); err == nil {
		held = st.Size()
	}
	u.f.Close()
	p := &partialUpload{dir: u.dir, tmp: u.tmp, size: size, held: held, kept: time.Now()}
	id := u.id()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.partials == nil {
		g.partials = map[string]*partialUpload{}
	}
	if len(g.partials) >= maxPartials {
		g.dropPartialLocked(g.oldestPartialLocked())
	}
	g.partials[id] = p
	p.timer = time.AfterFunc(partialKeep, func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.partials[id] == p {
			g.dropPartialLocked(id)
		}
	})
}

// oldestPartialLocked is the id of the upload kept longest, or "" if none
// is. g.mu must be held.
func (g *server) oldestPartialLocked() string {
	oldest := ""
	for k, q := range g.partials {
		if oldest == "" || q.kept.Before(g.partials[oldest].kept) {
			oldest = k
		}
	}
	return oldest
}

// reclaimPartials deletes uploads kept to resume, the oldest first, until
// need bytes are free for the gateway's files, or none are left, and
// returns the bytes free then (see diskSpace). A page reloaded or closed
// part way through an upload can't resume it, so the room those take is
// only borrowed.
func (g *server) reclaimPartials(need int64) (int64, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for {
		free, _, ok := diskSpace(g.downloadsDir)
		if !ok || free >= need || len(g.partials) == 0 {
			return free, ok
		}
		g.dropPartialLocked(g.oldestPartialLocked())
	}
}

// uploadRoom is diskSpace for the gateway's files, counting the room the
// uploads kept to resume take as free, since an upload that needs it gets
// it (see reclaimPartials).
func (g *server) uploadRoom() (free, total int64, ok bool) {
	free, total, ok = diskSpace(g.downloadsDir)
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, p := range g.partials {
		free += p.held
	}
	return min(free, total), total, ok
}

// dropPartialLocked deletes the upload kept as id. g.mu must be held.
func (g *server) dropPartialLocked(id string) {
	p := g.partials[id]
	delete(g.partials, id)
	p.timer.Stop()
	if root, err := os.OpenRoot(g.downloadsDir); err == nil {
		root.Remove(p.tmp)
		root.Close()
	}
}

// activeUpload is an upload going on, through t, which can be resumed
// before the server notices its connection is lost: resumed is then set,
// and its connection closed, and over is closed once it's kept.
type activeUpload struct {
	t       *tunnel
	resumed atomic.Bool
	over    chan struct{}
}

// claimPartial takes the upload kept as id (see keepPartial) to carry on
// with, if it's into dir and of a file size bytes long, and returns it
// and how much of the file it has; else nil, and the page starts again.
// If that upload still seems to be going on, as when the page has lost its
// connection before the server noticed, it's stopped and kept first.
func (g *server) claimPartial(root *os.Root, id, dir string, size int64) (*upload, int64) {
	g.mu.Lock()
	if a := g.uploads[id]; a != nil {
		g.mu.Unlock()
		a.resumed.Store(true)
		a.t.c.CloseNow()
		select {
		case <-a.over:
		case <-time.After(5 * time.Second):
			return nil, 0
		}
		g.mu.Lock()
	}
	p := g.partials[id]
	if p == nil || p.dir != dir || p.size != size {
		g.mu.Unlock()
		return nil, 0
	}
	delete(g.partials, id)
	p.timer.Stop()
	g.mu.Unlock()
	f, err := root.OpenFile(p.tmp, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return nil, 0
	}
	u := &upload{root: root, dir: dir, tmp: p.tmp, f: f}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > size {
		u.abort()
		return nil, 0
	}
	return u, st.Size()
}

// numberedName is "base (i)ext", with base cut short (at a character's
// end) if that would be longer than a name can be. If the extension leaves
// no room, it's cut short as part of the name instead.
func numberedName(base, ext string, i int) string {
	suffix := fmt.Sprintf(" (%d)", i)
	room := maxNameBytes - len(suffix) - len(ext)
	if room < 1 {
		base, ext = base+ext, ""
		room = maxNameBytes - len(suffix)
	}
	for len(base) > room {
		_, size := utf8.DecodeLastRuneInString(base)
		base = base[:len(base)-size]
	}
	return base + suffix + ext
}

func syncDir(root *os.Root, dir string) error {
	d, err := root.Open(dir)
	if err != nil {
		return err
	}
	err = d.Sync()
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	return err
}

// makeFolder creates the folder name in dir, or the first free name like
// it, as an upload does for a file, and returns the name it got: an
// uploaded folder never merges into one already there.
func makeFolder(root *os.Root, dir, name string) (string, error) {
	if !validUploadName(name) {
		return "", errUploadName
	}
	if st, err := root.Stat(dir); err != nil || !st.IsDir() {
		return "", fs.ErrNotExist
	}
	for i := 0; i < 1000; i++ {
		got := name
		if i > 0 {
			got = numberedName(name, "", i) // "photos.2024 (1)": a folder has no extension
		}
		err := root.Mkdir(path.Join(dir, got), 0o755)
		if err == nil {
			syncDir(root, dir) // only files are promised to be on disk
			return got, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", errors.New("too many folders with that name")
}

// tunnelMkdir answers a mkdir request, for a folder req.Name in req.Path,
// with {"name":...}, the name it got.
func (g *server) tunnelMkdir(t *tunnel, req tunnelRequest, reply func(map[string]any) bool, fail func(string)) {
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail(uploadError(fs.ErrNotExist))
		return
	}
	defer root.Close()
	dir := strings.Trim(req.Path, "/")
	if dir == "" {
		dir = "."
	}
	name, err := makeFolder(root, dir, req.Name)
	if err != nil {
		log.Printf("folder %q: %v", path.Join(dir, req.Name), err)
		fail(uploadError(err))
		return
	}
	log.Printf("folder %s created through the tunnel", path.Join(dir, name))
	reply(map[string]any{"name": name})
	t.Close(websocket.StatusNormalClosure, "")
}

// uploadError is what to tell the user about err.
func uploadError(err error) string {
	switch {
	case errors.Is(err, errUploadName), errors.Is(err, errReplaceFolder):
		return err.Error()
	case errors.Is(err, fs.ErrNotExist):
		return "The folder is missing."
	case errors.Is(err, fs.ErrPermission):
		return "The folder can't be written to."
	case errors.Is(err, syscall.ENOSPC):
		return "The disk is full."
	}
	return "The file couldn't be saved."
}

// tunnelUpload answers an upload request: it replies {"id":...,
// "offset":...}, and the page sends the file's contents from offset in
// data messages, and the server acknowledges each with an empty data
// message once it's written, as the page does for downloads, so at most
// fileWindow chunks are on their way. Once it has req.Size bytes, it saves
// the file and sends {"name":...} with the name it got, or {"error":...}.
// With req.Replace, a file of that name is replaced. The page cancels it
// with a text message, which deletes what came; if it stops any other way
// part way, as when the connection is lost, what came is kept, and a
// request with req.Resume set to the id carries on from it (see
// keepPartial); offset is 0 if it's gone.
func (g *server) tunnelUpload(t *tunnel, req tunnelRequest, reply func(map[string]any) bool, fail func(string)) {
	if !validUploadName(req.Name) || req.Size < 0 {
		fail(errUploadName.Error())
		return
	}
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail(uploadError(fs.ErrNotExist))
		return
	}
	defer root.Close()
	dir := strings.Trim(req.Path, "/")
	if dir == "" {
		dir = "."
	}
	var u *upload
	offset := int64(0)
	if req.Resume != "" {
		u, offset = g.claimPartial(root, req.Resume, dir, req.Size)
	}
	// Refused at once if it can't fit, rather than failing part way.
	if free, ok := g.reclaimPartials(req.Size - offset); ok && req.Size-offset > free {
		if u != nil {
			g.keepPartial(u, req.Size)
		}
		fail(fmt.Sprintf("There isn't room for it: it's %s, and %s is free.", humanSize(req.Size-offset), humanSize(free)))
		return
	}
	if u == nil {
		var err error
		if u, err = startUpload(root, dir); err != nil {
			fail(uploadError(err))
			return
		}
	}
	saved, keep := false, false
	active := &activeUpload{t: t, over: make(chan struct{})}
	g.mu.Lock()
	if g.uploads == nil {
		g.uploads = map[string]*activeUpload{}
	}
	g.uploads[u.id()] = active
	g.mu.Unlock()
	defer func() {
		switch {
		case saved:
		case keep || active.resumed.Load():
			g.keepPartial(u, req.Size)
		default:
			u.abort()
		}
		g.mu.Lock()
		delete(g.uploads, u.id())
		g.mu.Unlock()
		close(active.over)
	}()
	t.c.SetReadLimit(fileChunk + tunnelOverhead)
	if !reply(map[string]any{"id": u.id(), "offset": offset}) {
		return
	}
	if offset > 0 {
		log.Printf("upload of %s resumed at %s of %s", path.Join(dir, req.Name), humanSize(offset), humanSize(req.Size))
	}
	for got := offset; got < req.Size; {
		ctx, cancel := context.WithTimeout(context.Background(), fileStall)
		typ, p, err := t.Read(ctx)
		cancel()
		if err != nil {
			keep = !errors.Is(err, errTunnelFrame)
			return
		}
		if typ == websocket.MessageText {
			return // cancelled
		}
		if len(p) == 0 || got+int64(len(p)) > req.Size {
			t.Close(websocket.StatusPolicyViolation, "bad upload")
			return
		}
		if _, err := u.Write(p); err != nil {
			fail(uploadError(err))
			return
		}
		got += int64(len(p))
		ctx, cancel = context.WithTimeout(context.Background(), tunnelTimeout)
		err = t.Write(ctx, websocket.MessageBinary, nil)
		cancel()
		if err != nil {
			keep = true
			return
		}
	}
	name, err := u.finish(req.Name, req.Replace)
	saved = true
	if err != nil {
		log.Printf("upload of %q: %v", path.Join(dir, req.Name), err)
		fail(uploadError(err))
		return
	}
	replaced := ""
	if req.Replace {
		replaced = ", replacing any file of that name"
	}
	log.Printf("upload through the tunnel saved %s (%s%s)", path.Join(dir, name), humanSize(req.Size), replaced)
	res := map[string]any{"name": name}
	if u.unsynced {
		res["warning"] = "saved, but the disk didn't confirm it; it could be lost if the power fails soon"
	}
	writeJSON(t, res)
	t.Close(websocket.StatusNormalClosure, "")
}

// diskSpace returns the bytes free for the gateway's files on the file
// system holding path, and its size, if it can tell.
func diskSpace(path string) (free, total int64, ok bool) {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0, 0, false
	}
	return int64(st.Bavail) * st.Bsize, int64(st.Blocks) * st.Bsize, true
}
