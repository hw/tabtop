package main

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Configuration is immutable after startup. Every root, the default
// Downloads one included, owns its mutable file state (uploads kept to
// resume, fetches, Trash's lock, the watch's own moves); authentication,
// share tokens and the activity log remain global.
type fileRoot struct {
	ShellPath string `json:"shell_path"`
	ID        string `json:"id"`
	Label     string `json:"label"`
	Path      string `json:"path"`
	ReadOnly  bool   `json:"read_only"`
	Binding   string `json:"version"`
	// identity is the directory a configured root named at startup. Each
	// operation reopens Path and checks it is still that directory, so one
	// deleted or replaced while running is reported missing rather than
	// used through a stale handle. The default Downloads root has none: it
	// follows whatever ~/Downloads is, as it always has.
	identity fs.FileInfo
	mounts   []rootMountView
	// Default is whether it's Downloads at its default place, where the
	// browser on the desktop saves: what requests naming no root reach.
	Default   bool `json:"default"`
	transfers uploadManager
	fetches   *fetchManager
	trashMu   sync.Mutex
	// trashPruning is set while a pruning of Trash is on its way (see
	// pruneTrashSoon).
	trashPruning atomic.Bool
	// trashFresh is what's been put in Trash lately (see trashRoom);
	// trashMu guards it.
	trashFresh []freshTrash
	trash      trashIndex
	// versions are its files' versions (see versions.go), as last read,
	// and what's kept, listed or pruned there, under versionsMu.
	versions   trashIndex
	versionsMu sync.Mutex
	// writes are the folders being written into by what isn't tracked
	// otherwise: uploads through links, and ZIPs extracted (see
	// writingInto and holdWrites).
	writes   folderWrites
	placedMu sync.Mutex
	placedAt map[string]time.Time
}

// fileService is the server serving one root: its state is the root's.
type fileService struct {
	*server
	root         *fileRoot
	downloadsDir string // where to open the root: its path, or for the default root the configured Downloads path
	activityPath string
	// req is what's kept for the request being served: nil for a service
	// that outlives one (a root's fetches', say), whose opens check all.
	req *requestScope
}

// requestScope is what's kept for one request, of the root it's served by.
type requestScope struct {
	// checked are the paths found not to lead into Trash (see
	// reachesTrash), which the request's opens needn't check again.
	checked []string
	// opened is the root as reachesTrash opened it, for the request's
	// first open to take rather than open it again (see openRoot).
	opened atomic.Pointer[os.Root]
	// real are the folders the request has resolved (see resolved), by
	// path: each found once, however many of its steps ask.
	realMu sync.Mutex
	real   map[string]string
}

// serving gives g a scope for the request it's to serve.
func (g *fileService) serving() *fileService {
	g.req = &requestScope{}
	return g
}

var errRootReplaced = errors.New("the folder was deleted or replaced after TabTop started")

var rootID = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// rootIDFor is the ID of a root labelled label: its letters and digits,
// lower case, anything else (a space, say) as "-", none at the start.
func rootIDFor(label string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(label) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	id := strings.TrimLeft(b.String(), "-_")
	if strings.Trim(id, "-_") == "" && strings.TrimSpace(label) != "" && label != "." && label != ".." {
		// A name with none of those (in another script): by its hash.
		sum := sha256.Sum256([]byte(label))
		return "root-" + hex.EncodeToString(sum[:4])
	}
	return id[:min(len(id), 64)]
}

// directoryBinding identifies the folder at p, for links to it to be
// bound to (see filesForShare): its path and inode, which a remount keeps,
// where a filesystem's device number or ID needn't (tmpfs, overlay, NFS
// and many FUSE filesystems derive them afresh), and which a folder
// deleted and made again at p doesn't. A different filesystem mounted at
// p in place of another, whose top can have the same inode, isn't told
// apart: that takes reconfiguring the machine, not just the folder.
func directoryBinding(p string, info fs.FileInfo) string {
	sys, ok := identitySys(info)
	if !ok {
		return ""
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00ino:%d", p, sys.Ino)))
	return hex.EncodeToString(sum[:])
}

// sameFolder reports whether a and b are one folder, as directoryBinding
// tells folders apart: by inode, not by device, which a remount (of a
// network or FUSE filesystem, a drive plugged in again) can change with
// the folder as it was.
func sameFolder(a, b fs.FileInfo) bool {
	x, ok := identitySys(a)
	y, ok2 := identitySys(b)
	return ok && ok2 && x.Ino == y.Ino && a.IsDir() == b.IsDir()
}

// rootProblem is a configured root that couldn't be used at startup: its
// folder missing (an unmounted drive, say) or unreadable. The rest start
// without it, and /doctor reports it.
type rootProblem struct {
	ID, Label string
	Err       error
}

// parseFileRootsAll reads WEB_FS_ROOTS. A mistake in it is an error; a root
// whose folder can't be used is left out and reported in problems.
func parseFileRootsAll(spec, home, downloads string) (_ []*fileRoot, problems []rootProblem, err error) {
	if spec == "" {
		p, err := filepath.Abs(downloads)
		if err != nil {
			return nil, nil, err
		}
		r := &fileRoot{ID: "downloads", Label: "Downloads", Path: p, ShellPath: "~/Downloads", Default: true}
		// Preserve the existing startup behavior for the default Downloads path.
		if real, e := filepath.EvalSymlinks(p); e == nil {
			r.Path = real
		}
		r.ShellPath = r.Path
		accountHome := home
		if accountHome == "" {
			accountHome, _ = os.UserHomeDir()
		}
		if rel, e := filepath.Rel(accountHome, r.Path); e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			r.ShellPath = "~/" + rel
		}
		// Bound by its path alone, so a missing or recreated ~/Downloads
		// keeps its links and lets new ones be made.
		sum := sha256.Sum256([]byte("default\x00" + r.Path))
		r.Binding = hex.EncodeToString(sum[:])
		return []*fileRoot{r}, nil, nil
	}
	entries, err := csv.NewReader(strings.NewReader(spec)).ReadAll()
	if err != nil || len(entries) != 1 || len(entries[0]) == 0 || len(entries[0]) > 32 {
		return nil, nil, errors.New("WEB_FS_ROOTS must be a comma-separated list of at most 32 folders")
	}
	if home == "" {
		home, err = os.UserHomeDir()
		if err != nil {
			return nil, nil, err
		}
	}
	mounts, err := rootMounts()
	if err != nil {
		return nil, nil, err
	}
	var roots []*fileRoot
	seen := map[string]bool{}
	for _, entry := range entries[0] {
		value := strings.TrimSpace(entry)
		ro := false
		if strings.HasSuffix(value, ":ro") {
			ro = true
			value = strings.TrimSuffix(value, ":ro")
		} else if strings.HasSuffix(value, ":rw") {
			value = strings.TrimSuffix(value, ":rw")
		}
		// Any other colon is part of the name or path.
		// name=path; but a path with "=" in it, named by nothing, is all
		// path: a name has no "/" in it, nor starts as a path does.
		label, p, aliased := strings.Cut(value, "=")
		if aliased && (strings.ContainsRune(label, '/') || strings.HasPrefix(label, "~") || strings.HasPrefix(label, ".")) {
			label, p, aliased = value, "", false
		}
		if !aliased {
			p = label
			label = filepath.Base(filepath.Clean(p))
			if label == "~" {
				label = "Home"
			}
		}
		label = strings.TrimSpace(label)
		p = strings.TrimSpace(p)
		id := rootIDFor(label)
		if !rootID.MatchString(id) || p == "" {
			return nil, nil, fmt.Errorf("invalid root %q: use a unique name containing letters, digits, _ or -", entry)
		}
		if seen[id] {
			return nil, nil, fmt.Errorf("duplicate root ID %q", id)
		}
		seen[id] = true
		skip := func(err error) { problems = append(problems, rootProblem{id, label, err}) }
		// ~ is the user's home, as in a shell; ~name isn't supported.
		if p == "~" || strings.HasPrefix(p, "~/") {
			p = filepath.Join(home, strings.TrimPrefix(p, "~"))
		} else if strings.HasPrefix(p, "~") {
			return nil, nil, fmt.Errorf("root %q: only ~ and ~/... are supported, for the user's home", entry)
		}
		if !filepath.IsAbs(p) {
			clean := filepath.Clean(p)
			if clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
				return nil, nil, fmt.Errorf("root %q escapes the user's home", entry)
			}
			p = filepath.Join(home, clean)
		}
		p, err = filepath.Abs(p)
		if err != nil {
			return nil, nil, err
		}
		real, e := filepath.EvalSymlinks(p)
		if e != nil {
			skip(e)
			continue
		}
		p = real
		info, e := os.Stat(p)
		if e != nil || !info.IsDir() {
			skip(errors.New("not an accessible directory"))
			continue
		}
		if p == string(os.PathSeparator) {
			return nil, nil, fmt.Errorf("root %q is the whole filesystem; expose a folder in it instead", label)
		}
		views := mountViews(p, mounts)
		for _, old := range roots {
			oldInfo, _ := os.Stat(old.Path)
			if overlappingMountViews(views, old.mounts) || os.SameFile(info, oldInfo) || p == old.Path || strings.HasPrefix(p, old.Path+string(os.PathSeparator)) || strings.HasPrefix(old.Path, p+string(os.PathSeparator)) {
				return nil, nil, fmt.Errorf("roots %q and %q overlap", label, old.Label)
			}
		}
		root, e := openDirectoryRoot(p)
		if e != nil {
			skip(e)
			continue
		}
		dir, e := openRootDirectory(root, ".")
		if e == nil {
			_, e = dir.ReadDir(1)
			dir.Close()
			if errors.Is(e, io.EOF) {
				e = nil
			}
		}
		if e == nil {
			if opened, serr := root.Stat("."); serr != nil || !os.SameFile(opened, info) {
				e = errors.New("it changed while starting")
			}
		}
		if e != nil {
			root.Close()
			skip(e)
			continue
		}
		configured := &fileRoot{mounts: views, ID: id, Label: label, Path: p, ReadOnly: ro, Binding: directoryBinding(p, info), identity: info}
		root.Close()
		// Reuse the default runtime fields for Downloads so existing callers and
		// terminal/desktop notifications retain their default destination.
		// Without a Downloads path there's no default to match: Abs("")
		// would be the working directory.
		if downloads != "" {
			defaultPath, _ := filepath.Abs(downloads)
			if real, e := filepath.EvalSymlinks(defaultPath); e == nil {
				defaultPath = real
			}
			// By its place, whatever it's named here ("Files=~/Downloads"):
			// it's where the desktop's browser saves.
			configured.Default = p == defaultPath
		}
		configured.ShellPath = p
		if rel, e := filepath.Rel(home, p); e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			configured.ShellPath = "~/" + rel
		}
		roots = append(roots, configured)
	}
	return roots, problems, nil
}

func (g *server) rootByID(id string) (*fileRoot, error) {
	if id == "" {
		// None named: Downloads, where the server has it at its default
		// place, by whatever name.
		for _, root := range g.roots {
			if root.Default {
				return root, nil
			}
		}
		return nil, errors.New("Downloads is not exposed at its default location. Choose a filesystem root.")
	}
	for _, root := range g.roots {
		if root.ID == id {
			return root, nil
		}
	}
	return nil, errors.New("That filesystem root is not available. Choose a folder from Files.")
}
func (g *server) scope(root *fileRoot) *fileService {
	s := &fileService{server: g, root: root, downloadsDir: root.Path}
	if root.Default {
		s.downloadsDir = g.downloadsDir
	}
	return s
}

// open opens the root's directory afresh, from dir (its path, or for the
// default root the configured Downloads path).
func (r *fileRoot) open(dir string) (*os.Root, error) {
	root, err := openDirectoryRoot(dir)
	if err != nil {
		return nil, err
	}
	if r.identity != nil {
		if st, err := root.Stat("."); err != nil || !sameFolder(st, r.identity) {
			root.Close()
			return nil, errRootReplaced
		}
	}
	return root, nil
}
func (g *fileService) openRoot() (*os.Root, error) {
	if g.req != nil {
		if root := g.req.opened.Swap(nil); root != nil {
			return root, nil
		}
	}
	return g.root.open(g.downloadsDir)
}

// closeOpened closes the root reachesTrash opened, if nothing took it.
func (g *fileService) closeOpened() {
	if g.req == nil {
		return
	}
	if root := g.req.opened.Swap(nil); root != nil {
		root.Close()
	}
}
func (g *fileService) openStore() (*downloadStore, error) {
	root, err := g.openRoot()
	if err != nil {
		return nil, err
	}
	store := &downloadStore{root: root, index: &g.root.trash}
	if g.req != nil {
		store.checked = g.req.checked
	}
	return store, nil
}
func (g *fileService) openItem(name string) (*downloadItem, error) {
	store, err := g.openStore()
	if err != nil {
		return nil, errDownloadsMissing
	}
	name = path.Clean(strings.Trim(name, "/"))
	f, st, err := store.open(name)
	if err != nil {
		store.Close()
		return nil, errDownloadMissing
	}
	return &downloadItem{store: store, file: f, info: st, name: name}, nil
}
func (g *fileService) openFile(name string) (*downloadItem, error) {
	item, err := g.openItem(name)
	if err != nil {
		return nil, err
	}
	if !item.info.Mode().IsRegular() {
		item.Close()
		return nil, errDownloadMissing
	}
	return item, nil
}
func (g *fileService) act(id, kind, ip, format string, args ...any) {
	g.activity.addFileAs(g.sessionName(id), g.root.ID, g.activityPath, kind, ip, format, args...)
}
func (g *fileService) folderText(dir string) string { return rootFolderText(g.root.Label, dir) }

// rootFolderText names the folder dir in the root called label, for the
// activity log: the root's name itself at the top.
func rootFolderText(label, dir string) string {
	if topFolder(dir) {
		return label
	}
	return label + "/" + strings.Trim(dir, "/") + "/"
}
func (g *server) rootReport() []*fileRoot { return g.roots }
func (g *server) filesForShare(l *shareLink) (*fileService, error) {
	root, err := g.rootByID(l.Root)
	if err != nil || l.Root == "" || l.RootBinding == "" || root.Binding != l.RootBinding {
		return nil, errors.New("This link's filesystem root is no longer available.")
	}
	if l.Upload && root.ReadOnly {
		return nil, errors.New("This folder is read-only.")
	}
	service := g.scope(root)
	service.activityPath = l.Path
	return service, nil
}

func (g *server) fileServices() []*fileService {
	out := make([]*fileService, 0, len(g.roots))
	for _, root := range g.roots {
		out = append(out, g.scope(root))
	}
	return out
}
func (g *server) cancelFetches(match func(*fetchJob) bool) {
	for _, service := range g.fileServices() {
		if service.root.fetches != nil {
			service.root.fetches.cancelMatching(match)
		}
	}
}

// folderWrites counts writes going on, by the folder each is into, and
// the folders being deleted, which none may start into meanwhile.
type folderWrites struct {
	mu       sync.Mutex
	n        map[string]int
	deleting map[string]int
	// stages are folders being filled before they're given their names
	// (see copyAcross), which cleanup leaves however old they get.
	stages map[string]bool
}

// staging records stage, a folder's path in the root, as in use until the
// function returned is called.
func (w *folderWrites) staging(stage string) func() {
	stage = path.Clean(strings.Trim(stage, "/"))
	w.mu.Lock()
	if w.stages == nil {
		w.stages = map[string]bool{}
	}
	w.stages[stage] = true
	w.mu.Unlock()
	return func() {
		w.mu.Lock()
		delete(w.stages, stage)
		w.mu.Unlock()
	}
}

// staged lists the stages in use, into busy.
func (w *folderWrites) staged(busy map[string]bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for stage := range w.stages {
		busy[stage] = true
	}
}

// errFolderDeleting is a write refused, its folder being deleted.
var errFolderDeleting = errors.New("That folder is being deleted or moved just now: try again once that's done.")

// begin records a write into dir, a folder in the root, going on until the
// function returned is called; or, if dir is being deleted, or is in a
// folder that is, refuses it.
func (w *folderWrites) begin(dir string) (func(), error) {
	dir = path.Clean(strings.Trim(dir, "/"))
	w.mu.Lock()
	defer w.mu.Unlock()
	for folder := range w.deleting {
		if inFolder(dir, folder) {
			return nil, errFolderDeleting
		}
	}
	if w.n == nil {
		w.n = map[string]int{}
	}
	w.n[dir]++
	return func() {
		w.mu.Lock()
		if w.n[dir]--; w.n[dir] <= 0 {
			delete(w.n, dir)
		}
		w.mu.Unlock()
	}, nil
}

// startDeleting marks folder as being deleted, so no write into it can
// begin, until the function returned is called; unless one is going on
// into it, or a folder in it, when it's busy.
func (w *folderWrites) startDeleting(folder string) (end func(), busy bool) {
	folder = path.Clean(strings.Trim(folder, "/"))
	w.mu.Lock()
	defer w.mu.Unlock()
	for dir := range w.n {
		if inFolder(dir, folder) {
			return nil, true
		}
	}
	if w.deleting == nil {
		w.deleting = map[string]int{}
	}
	w.deleting[folder]++
	return func() {
		w.mu.Lock()
		if w.deleting[folder]--; w.deleting[folder] <= 0 {
			delete(w.deleting, folder)
		}
		w.mu.Unlock()
	}, false
}

// stateFileIn is the first of files (the gateway's own: "" for none) that
// is in the folder dir, or in a folder in it, links followed; or "".
func stateFileIn(dir string, files []string) string {
	real := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return filepath.Clean(p)
	}
	dir = real(dir)
	for _, f := range files {
		if f == "" {
			continue
		}
		// Its folder as it is, though the file may not be made yet.
		if at := filepath.Join(real(filepath.Dir(f)), filepath.Base(f)); pathWithin(at, dir) {
			return f
		}
	}
	return ""
}
