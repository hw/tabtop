package main

// Trash lives at the top of each root, so renames into it are atomic on its
// filesystem and a persistent volume keeps it. It's reached only through
// its own requests, which name entries by ID. The rule is kept by:
//   - reachesTrash: a request's paths, links in them followed;
//   - downloadStore.open: any read by path, for share links too;
//   - entryFilter: listings and zips;
//   - validNewName and moveEntry: nothing new takes its name or place.
// The temporary-file scans skip it too, walking without following links.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

const trashDir = ".tabtop-trash"
const trashAge = 7 * 24 * time.Hour
const trashBytes int64 = 1 << 30
const trashCount = 1000

var errTrashLimit = errors.New("This item is too large or contains too many entries for Trash. Nothing was deleted.")

// trashMeasureTime is how long an item's size may take to measure, before
// it goes to Trash; errTrashSlow, when it takes longer.
const trashMeasureTime = 10 * time.Second

var errTrashSlow = errors.New("It took too long to measure for Trash (a slow or network disk, say), so it wasn't moved there. Nothing was deleted.")

// errTrashSetup is Trash not made ready for an item (no room on the disk
// for its record, or the root's top folder not to be written in): the
// item's still where it was, and can be deleted for good instead.
var errTrashSetup = errors.New("Trash couldn't be made ready here")

// trashSetup is err, as errTrashSetup too, unless it's one with its own
// meaning (Trash's place taken).
func trashSetup(err error) error {
	if errors.Is(err, errTrashBlocked) {
		return err
	}
	return fmt.Errorf("%w: %w", errTrashSetup, err)
}

// errTrashUnreadable is an item with a folder in it that can't be opened.
var errTrashUnreadable = errors.New("There's a folder in it that can't be opened (permission denied), so it couldn't be removed from Trash later: it wasn't moved there. Nothing was deleted.")

// errTrashBlocked is Trash's place taken by something that isn't a folder,
// so nothing can go to Trash in this root.
var errTrashBlocked = errors.New("Trash can't be used here: something that isn't a folder has its name (" + trashDir + ") at the top of this folder. Nothing was deleted.")

type trashEntry struct {
	ID      string    `json:"id"`
	Path    string    `json:"path"`
	Dir     bool      `json:"dir"`
	Bytes   int64     `json:"bytes"`
	Deleted time.Time `json:"deleted"`
	// Modified is, for a version (see versions.go), when the file was last
	// changed then.
	Modified time.Time `json:"modified,omitzero"`
	// Trashed is, for a version, the ID of the Trash entry its file's in,
	// if it's in Trash; Path is still where it was.
	Trashed string `json:"trashed,omitempty"`
}

// hiddenDownloadName reports whether name, in any folder, is a temporary
// upload's, which listings leave out.
func hiddenDownloadName(name string) bool {
	return strings.HasPrefix(name, uploadTempPrefix)
}

// entryFilter says which entries of one folder listings and zips leave
// out: temporary uploads, Trash at the top of the root, and links leading
// into Trash. A folder named as Trash deeper down is the user's own. The
// folder is resolved once, and only while there's a Trash to hide, so a
// folder of links costs no more than any other then.
type entryFilter struct {
	store   *downloadStore
	trash   bool   // Trash exists
	top     bool   // the folder is the top of the root
	realDir string // the folder, resolved (see canonical)
}

func (s *downloadStore) entryFilter(dir string) entryFilter {
	f := entryFilter{store: s, trash: s.hasTrash()}
	if f.trash {
		real, err := s.canonical(dir)
		f.realDir, f.top = real, err == nil && real == "."
		if err != nil {
			f.realDir = path.Clean(strings.Trim(dir, "/"))
		}
	}
	return f
}
func (f entryFilter) hidden(de fs.DirEntry) bool {
	name := de.Name()
	if hiddenDownloadName(name) {
		return true
	}
	if !f.trash {
		return false
	}
	if f.top && f.store.isTrashTop(name) {
		return true
	}
	if de.Type()&fs.ModeSymlink == 0 {
		return false
	}
	return f.store.leadsToTrash(f.store.canonicalIn(f.realDir, name))
}

// leadsToTrash is whether real, a path canonical resolved, is Trash or in
// it. One that leads out of the root, absolutely, or round in circles,
// leads nowhere, as the root refuses it: the operation fails on its own,
// saying so. One that couldn't be resolved otherwise counts, as nothing
// should be done with it.
func (s *downloadStore) leadsToTrash(real string, err error) bool {
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ELOOP) {
		return false
	}
	return err != nil || s.trashPathHere(real)
}

// hasTrash reports whether anything has Trash's name at the top: if not,
// nothing can lead into it.
func (s *downloadStore) hasTrash() bool {
	_, err := s.root.Lstat(trashDir)
	return err == nil
}
func topFolder(dir string) bool {
	return dir == "" || path.Clean(strings.Trim(dir, "/")) == "."
}

// topName is the first part of name, a path in the root.
func topName(name string) string {
	first, _, _ := strings.Cut(path.Clean(strings.Trim(name, "/")), "/")
	return first
}

// trashPath reports whether name, a path in the root, is Trash or inside
// it, by Trash's name as it's made. (On a filesystem that ignores case,
// another spelling reaches it too: see trashPathHere.)
func trashPath(name string) bool { return topName(name) == trashDir }

// trashPathHere is trashPath, counting any spelling of Trash's name that
// names the same folder, as every one does on a filesystem that ignores
// case (FAT, exFAT, and others a root may be on). Elsewhere, another
// spelling is a folder of its own, the user's.
func (s *downloadStore) trashPathHere(name string) bool { return s.isTrashTop(topName(name)) }

// isTrashTop reports whether name, at the top of the root, is Trash.
func (s *downloadStore) isTrashTop(name string) bool {
	if name == trashDir {
		return true
	}
	if !trashName(name) {
		return false
	}
	a, err := s.root.Lstat(name)
	if err != nil {
		return false
	}
	b, err := s.root.Lstat(trashDir)
	return err == nil && os.SameFile(a, b)
}

// trashName reports whether name is Trash's in any case. Such names are
// refused for new items, which on a filesystem that ignores case would be
// Trash, or would take its place.
func trashName(name string) bool { return strings.EqualFold(name, trashDir) }

// canonical is name, a path in the root, with the symlinks in it followed
// as the root follows them, so it names where it really leads: what to
// check against Trash, which a link such as self -> . would otherwise
// reach by another name. From the first part that doesn't exist, the rest
// is taken as it is.
func (s *downloadStore) canonical(name string) (string, error) {
	return s.canonicalIn(".", name)
}

// canonicalIn is canonical for name in the folder base, already resolved.
func (s *downloadStore) canonicalIn(base, name string) (string, error) {
	pending := strings.Split(strings.Trim(name, "/"), "/")
	var out []string
	if base = path.Clean(base); base != "." {
		out = strings.Split(base, "/")
	}
	links := 0
	for len(pending) > 0 {
		part := pending[0]
		pending = pending[1:]
		switch part {
		case "", ".":
			continue
		case "..":
			if len(out) == 0 {
				return "", fs.ErrNotExist // out of the root, which it refuses
			}
			out = out[:len(out)-1]
			continue
		}
		current := path.Join(append(out, part)...)
		st, err := s.root.Lstat(current)
		if err != nil {
			out = append(append(out, part), pending...)
			break
		}
		if st.Mode()&fs.ModeSymlink == 0 {
			out = append(out, part)
			continue
		}
		if links++; links > 40 {
			return "", syscall.ELOOP
		}
		target, err := s.root.Readlink(current)
		if err != nil {
			return "", err
		}
		if path.IsAbs(target) {
			return "", fs.ErrNotExist // the root refuses these too
		}
		pending = append(strings.Split(target, "/"), pending...)
	}
	return path.Clean(path.Join(append([]string{"."}, out...)...)), nil
}

// inTrash reports whether name is Trash or in it, however it's reached
// (see leadsToTrash).
//
// What it finds is remembered for the store's life, which is a request's:
// that Trash is there, and where folders lead, so that a walk opening
// every file in a tree (a zip, say) resolves each folder once, not once
// for each file in it. That's no less certain than resolving each time,
// as a link can change between any check and the open that follows it.
func (s *downloadStore) inTrash(name string) bool {
	if trashPath(name) {
		return true
	}
	s.mu.Lock()
	seen := s.trashSeen
	s.mu.Unlock()
	if !seen {
		if !s.hasTrash() {
			return false // not remembered: Trash may come
		}
		s.mu.Lock()
		s.trashSeen = true
		s.mu.Unlock()
	}
	dir, base := path.Split(path.Clean(strings.Trim(name, "/")))
	d := s.realDir(path.Clean(dir))
	if d.err != nil || s.trashPathHere(d.real) {
		return s.leadsToTrash(d.real, d.err)
	}
	return s.leadsToTrash(s.canonicalIn(d.real, base))
}

// realDir is where dir leads, resolved as canonical resolves it.
func (s *downloadStore) realDir(dir string) realDir {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.realDirs[dir]; ok {
		return d
	}
	real, err := s.canonical(dir)
	if s.realDirs == nil {
		s.realDirs = map[string]realDir{}
	}
	d := realDir{real, err}
	s.realDirs[dir] = d
	return d
}

// isTop reports whether dir is the top of the root, however it's reached.
func (s *downloadStore) isTop(dir string) bool {
	if topFolder(dir) {
		return true
	}
	real, err := s.canonical(dir)
	return err == nil && real == "."
}

func validTrashID(id string) bool {
	b, err := hex.DecodeString(id)
	return err == nil && len(b) == 16 && hex.EncodeToString(b) == id
}
func validTrashPath(name string) bool {
	return fs.ValidPath(name) && name != "." && !trashPath(name) && validUploadName(path.Base(name))
}

// Refuse a symlink at the storage boundary. os.Root confines all operations.
func (s *downloadStore) openTrash(create bool) (*downloadStore, error) {
	if create {
		if err := s.root.Mkdir(trashDir, 0700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
	}
	st, err := s.root.Lstat(trashDir)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, errTrashBlocked
	}
	root, err := s.root.OpenRoot(trashDir)
	if err != nil {
		return nil, err
	}
	return &downloadStore{root: root, index: s.index}, nil
}

// trashIndex is a root's Trash entries as last read: what's in an entry's
// info.json never changes, so listing Trash reads only those added since,
// not every one each time something's deleted (see pruneTrash): of the
// rest, it checks only that they still hold what was deleted.
type trashIndex struct {
	mu      sync.Mutex
	entries map[string]trashEntry
}

func (x *trashIndex) load() map[string]trashEntry {
	if x == nil {
		return nil
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.entries
}

func (x *trashIndex) store(entries map[string]trashEntry) {
	if x != nil {
		x.mu.Lock()
		x.entries = entries
		x.mu.Unlock()
	}
}

// Size accounting never follows symlinks, and bounds work before moving data.
func (s *downloadStore) trashSize(name string) (int64, error) {
	st, err := s.root.Lstat(name)
	if err != nil {
		return 0, err
	}
	if !st.IsDir() {
		if st.Size() > trashBytes {
			return 0, errTrashLimit
		}
		return st.Size(), nil
	}
	var size int64
	count := 1
	until := time.Now().Add(trashMeasureTime)
	// Pruned from Trash, what's mounted would be emptied.
	if err := holdsMount(s.root, name); err != nil {
		return 0, err
	}
	err = walkTree(context.Background(), s.root, name, st, func(_ string, info fs.FileInfo) error {
		count++
		switch {
		case count > 100000:
			return errTrashLimit
		case time.Now().After(until):
			return errTrashSlow
		}
		if !info.IsDir() {
			size += info.Size()
		}
		if size > trashBytes {
			return errTrashLimit
		}
		return nil
	}, nil)
	switch {
	case errors.Is(err, errTreeChanged):
		return 0, fs.ErrInvalid
	case errors.Is(err, fs.ErrPermission):
		// What can't be opened couldn't be removed from Trash either.
		return 0, errTrashUnreadable
	}
	if err != nil {
		return 0, err
	}
	return size, nil
}

func (s *downloadStore) readTrash(id string) (trashEntry, error) {
	var e trashEntry
	if !validTrashID(id) {
		return e, fs.ErrNotExist
	}
	f, err := s.root.OpenFile(id+"/info.json", os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return e, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return e, fs.ErrInvalid
	}
	// Room for the longest path there can be, however it's written out
	// (JSON spells some characters with six bytes).
	err = json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&e)
	if err != nil {
		return e, err
	}
	if e.ID != id || !validTrashPath(e.Path) || e.Bytes < 0 || e.Deleted.IsZero() {
		return e, fs.ErrInvalid
	}
	if _, err := s.root.Lstat(id + "/data"); err != nil {
		return e, err
	}
	return e, nil
}
func (s *downloadStore) trashEntries() ([]trashEntry, error) {
	f, err := openRootDirectory(s.root, ".")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries := []trashEntry{}
	known := s.index.load()
	fresh := map[string]trashEntry{}
	for {
		des, err := f.ReadDir(256)
		for _, de := range des {
			if !de.IsDir() || !validTrashID(de.Name()) {
				continue
			}
			// Known, it's still what was read, if it still holds what
			// was deleted (a restore takes it).
			e, ok := known[de.Name()]
			if ok {
				if _, err := s.root.Lstat(de.Name() + "/data"); err != nil {
					continue
				}
			} else {
				got, rerr := s.readTrash(de.Name())
				if rerr != nil {
					continue
				}
				e = got
			}
			fresh[de.Name()] = e
			entries = append(entries, e)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	s.index.store(fresh)
	slices.SortFunc(entries, func(a, b trashEntry) int { return a.Deleted.Compare(b.Deleted) })
	return entries, nil
}

// orphanGrace is how long a Trash entry that can't be read is left before
// pruning removes it: long enough that another TabTop sharing the folder
// is done writing it.
const orphanGrace = time.Hour

// pruneOrphans removes, from Trash, entries that can't be read (a crash
// part way through moving an item in or restoring it can leave them) and
// were last changed over grace ago. Nothing lists them or counts them
// towards the limits, so nothing else would.
func (s *downloadStore) pruneOrphans(now time.Time, grace time.Duration) error {
	f, err := openRootDirectory(s.root, ".")
	if err != nil {
		return err
	}
	defer f.Close()
	var orphans []string
	for {
		des, err := f.ReadDir(256)
		for _, de := range des {
			if !de.IsDir() || !validTrashID(de.Name()) {
				continue
			}
			// One that isn't there to read, or isn't an entry: not one
			// that couldn't be read just now (a network disk's hiccup,
			// no descriptors left), which is kept, and tried again.
			if _, rerr := s.readTrash(de.Name()); !brokenEntry(rerr) {
				continue
			}
			if info, ierr := de.Info(); ierr == nil && now.Sub(info.ModTime()) >= grace {
				orphans = append(orphans, de.Name())
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	for _, id := range orphans {
		if err := s.root.RemoveAll(id); err != nil {
			return err
		}
	}
	return nil
}

// pruneTrash removes the oldest entries while Trash is over its age, size
// or count limits, saying how many it removed. One that can't be removed
// is passed over (its error returned), not left to stop the rest. Orphans
// are pruneOrphans', run less often: not on every delete.
func (s *downloadStore) pruneTrash(now time.Time) (int, error) {
	entries, err := s.trashEntries()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, e := range entries {
		total += e.Bytes
	}
	count, removed := len(entries), 0
	var errs []error
	for _, e := range entries {
		if now.Sub(e.Deleted) < trashAge && total <= trashBytes && count <= trashCount {
			break
		}
		// One that can't be removed isn't counted on: counted, it would
		// have every newer one go, down to what's just been put in,
		// for room it will never give.
		total -= e.Bytes
		count--
		if err := s.root.RemoveAll(e.ID); err != nil {
			errs = append(errs, err)
			continue
		}
		removed++
	}
	return removed, errors.Join(errs...)
}

func (s *downloadStore) putTrash(name string, now time.Time) (trashEntry, error) {
	e, _, err := s.putTrashPruning(name, now, -1)
	return e, err
}

// putTrashPruning moves name to Trash (size as putTrashOnly has it), then
// prunes Trash, saying how many entries that removed.
func (s *downloadStore) putTrashPruning(name string, now time.Time, size int64) (e trashEntry, pruned int, err error) {
	e, err = s.putTrashOnly(name, now, size)
	if err != nil {
		return e, 0, err
	}
	trash, err := s.openTrash(false)
	if err != nil {
		return e, 0, nil
	}
	defer trash.Close()
	// Pruned once, now it's in: a newly added item fits individually, and
	// older items yield room first.
	pruned, err = trash.pruneTrash(now)
	if err != nil {
		log.Printf("trash retention: %v", err)
	}
	return e, pruned, nil
}

// putTrashOnly moves name to Trash: size is what trashSize says of it,
// measured already, or -1 to measure it now.
func (s *downloadStore) putTrashOnly(name string, now time.Time, size int64) (trashEntry, error) {
	var e trashEntry
	name = path.Clean(strings.Trim(name, "/"))
	if name == "." {
		return e, errTopFolder
	}
	if !validTrashPath(name) || s.trashPathHere(name) {
		return e, fs.ErrNotExist
	}
	// Match deletion policy: out-of-root and broken symlinks aren't accessible.
	if _, err := s.root.Stat(name); err != nil {
		return e, fs.ErrNotExist
	}
	st, err := s.root.Lstat(name)
	if err != nil {
		return e, err
	}
	if size < 0 {
		if size, err = s.trashSize(name); err != nil {
			return e, err
		}
	} else if st.IsDir() {
		// Measured before, so not knowing what's mounted now: checked
		// again (a quick look at the mount table) as it goes.
		if err := holdsMount(s.root, name); err != nil {
			return e, err
		}
	}
	trash, err := s.openTrash(true)
	if err != nil {
		return e, trashSetup(err)
	}
	defer trash.Close()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return e, err
	}
	id := hex.EncodeToString(b)
	if err := trash.root.Mkdir(id, 0700); err != nil {
		return e, trashSetup(err)
	}
	e = trashEntry{ID: id, Path: name, Dir: st.IsDir(), Bytes: size, Deleted: now}
	data, _ := json.Marshal(e)
	f, err := trash.root.OpenFile(id+"/info.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		_, err = f.Write(data)
		if err == nil {
			if serr := f.Sync(); !syncUnsupported(serr) {
				err = serr
			}
		}
		err = errors.Join(err, f.Close())
	}
	if err != nil {
		trash.root.RemoveAll(id)
		return trashEntry{}, trashSetup(err)
	}
	// Persist the recovery metadata before taking the item from its original name.
	for _, location := range []struct {
		root *os.Root
		dir  string
	}{{trash.root, id}, {trash.root, "."}, {s.root, "."}} {
		// A filesystem that can't sync (some FUSE, CIFS or 9p mounts)
		// gets Trash as far as it goes, as uploads to it do.
		if err := syncDir(location.root, location.dir); err != nil && !syncUnsupported(err) {
			trash.root.RemoveAll(id)
			return trashEntry{}, trashSetup(err)
		}
	}
	err = s.renameAt(path.Dir(name), path.Base(name), path.Join(trashDir, id), "data")
	if errors.Is(err, errNoRename) {
		// A filesystem without that: plainly, into the folder just made
		// for it, where there's nothing to replace.
		err = s.renameOver(name, path.Join(trashDir, id, "data"))
	}
	if err != nil {
		trash.root.RemoveAll(id)
		return trashEntry{}, fmt.Errorf("Couldn't move this item to Trash; nothing was deleted: %w", err)
	}
	syncDir(trash.root, id)
	syncDir(s.root, path.Dir(name))
	syncDir(trash.root, ".")
	return e, nil
}

func (s *downloadStore) restoreTrash(id string) (string, error) {
	trash, err := s.openTrash(false)
	if err != nil {
		return "", err
	}
	defer trash.Close()
	e, err := trash.readTrash(id)
	if err != nil {
		return "", err
	}
	dir, name := path.Dir(e.Path), path.Base(e.Path)
	// Missing parent directories are recreated inside the confined root;
	// but not where the way to them now leads into Trash, by a link made
	// since, where what's restored would be hidden.
	if s.inTrash(dir) {
		return "", errRestoreIntoTrash
	}
	// The folders made for it, to unmake if it's not restored after all.
	var made []string
	for d := dir; d != "."; d = path.Dir(d) {
		if _, err := s.root.Lstat(d); err == nil {
			break
		}
		made = append(made, d) // deepest first
	}
	unmake := func() {
		for _, d := range made {
			if s.root.Remove(d) != nil { // not empty: someone's using it
				break
			}
		}
	}
	if err := s.root.MkdirAll(dir, 0755); err != nil {
		unmake()
		return "", err
	}
	// Again, now it's there, resolved afresh (not as inTrash remembers).
	if s.leadsToTrash(s.canonical(dir)) {
		unmake()
		return "", errRestoreIntoTrash
	}
	got, err := freeName(name, e.Dir, func(got string) error { return s.placeAt(path.Join(trashDir, id), "data", dir, got, e.Dir) })
	if err != nil {
		unmake()
		return "", err
	}
	syncDir(s.root, dir)
	trash.root.RemoveAll(id)
	return path.Join(dir, got), nil
}

var errRestoreIntoTrash = errors.New("The folder this was in now leads into Trash, by a link. Files hides such links, so remove it another way (in a terminal, say), then restore it.")

// reachesTrash reports whether req's paths (Path, To, and Names in Path)
// name Trash or something in it, directly or by way of a link. Name is
// never a path: it's a new name (see validNewName) or an ID. Trash's own
// requests name entries by ID, so this doesn't stop them.
//
// Serving a request (see requestScope), it records the paths it checked,
// so the request's own opens of them (see downloadStore.open) don't
// resolve them again: a file read in chunks is a request per chunk.
func (g *fileService) reachesTrash(req tunnelRequest) bool {
	store, err := g.openStore()
	if err != nil {
		return false // the request fails on its own
	}
	paths := []string{req.Path}
	if req.To != "" {
		paths = append(paths, req.To)
	}
	for _, n := range req.Names {
		paths = append(paths, path.Join(req.Path, n))
	}
	for _, p := range paths {
		if store.inTrash(p) {
			store.Close()
			return true
		}
	}
	if g.req == nil {
		store.Close()
		return false
	}
	for _, p := range paths {
		g.req.checked = append(g.req.checked, path.Clean(strings.Trim(p, "/")))
	}
	// Opened just now, and checked: the request's first open takes it.
	if old := g.req.opened.Swap(store.root); old != nil {
		old.Close() // checked twice: the first's no longer needed
	}
	return false
}

func (g *fileService) tunnelTrash(call *tunnelCall) {
	req, r := call.req, call.r
	reply, err := g.trashRequest(req)
	if err != nil {
		r.fail("Trash: " + err.Error())
		return
	}
	r.finish(reply)
}

// trashReply lists entries, with the limits Trash keeps to.
func trashReply(entries []trashEntry) map[string]any {
	return map[string]any{"entries": entries, "max_bytes": trashBytes, "max_items": trashCount, "days": int(trashAge / (24 * time.Hour))}
}

// Release the lock before replying: closing a tunnel can wait on the peer.
func (g *fileService) trashRequest(req tunnelRequest) (map[string]any, error) {
	g.root.trashMu.Lock()
	defer g.root.trashMu.Unlock()
	store, err := g.openStore()
	if err != nil {
		return nil, errDownloadsMissing
	}
	defer store.Close()
	trash, err := store.openTrash(false)
	if errors.Is(err, fs.ErrNotExist) && (req.Type == "trash-list" || req.Type == "trash-empty") {
		return trashReply([]trashEntry{}), nil
	}
	if err != nil {
		return nil, err
	}
	defer trash.Close()
	// Pruned as items are added, and hourly (see maintainTrash), not here:
	// that reads every entry, which a list does once anyway.
	switch req.Type {
	case "trash-restore":
		was, err := trash.readTrash(req.Name)
		if err != nil {
			return nil, err
		}
		// A write into the folder it goes back to, as any other: not
		// while that's being deleted or moved, which would take what's
		// restored with it.
		writing, err := g.beginWrites(nearestFolder(store, path.Dir(was.Path)))
		if err != nil {
			return nil, err
		}
		defer writing()
		got, err := store.restoreTrash(req.Name)
		if err == nil {
			// Its versions, back with it, under whatever name it got.
			g.relocateVersions(req.Name, was.Path, "", got)
			g.placed(got) // not a new download
		}
		return map[string]any{"path": got}, err
	case "trash-list":
		entries, err := trash.trashEntries()
		if err != nil {
			return nil, err
		}
		// Those past their time, till the next pruning removes them,
		// aren't shown: they're as good as gone.
		now := time.Now()
		entries = slices.DeleteFunc(entries, func(e trashEntry) bool { return now.Sub(e.Deleted) >= trashAge })
		slices.Reverse(entries)
		return trashReply(entries), nil
	case "trash-delete":
		_, err := trash.readTrash(req.Name)
		if err != nil {
			return nil, err
		}
		if err := trash.root.RemoveAll(req.Name); err != nil {
			return nil, err
		}
		g.tidyVersions(store, time.Now())
		return nil, nil
	case "trash-empty":
		entries, err := trash.trashEntries()
		if err != nil {
			return nil, err
		}
		var errs []error
		for _, e := range entries {
			if err := trash.root.RemoveAll(e.ID); err != nil {
				errs = append(errs, err)
			}
		}
		// Emptying means everything, entries left broken included.
		err = errors.Join(errors.Join(errs...), trash.pruneOrphans(time.Now(), 0))
		g.tidyVersions(store, time.Now())
		return nil, err
	}
	return nil, errors.New("Unknown Trash request.")
}

// Prune at startup and hourly even when nobody opens the files page.
func (g *fileService) maintainTrash(ctx context.Context) {
	if g.root.ReadOnly {
		return
	}
	prune := func() {
		g.root.trashMu.Lock()
		defer g.root.trashMu.Unlock()
		store, err := g.openStore()
		if err != nil {
			return
		}
		defer store.Close()
		trash, err := store.openTrash(false)
		if err != nil {
			return
		}
		defer trash.Close()
		now := time.Now()
		_, perr := trash.pruneTrash(now)
		if err := errors.Join(trash.pruneOrphans(now, orphanGrace), perr); err != nil {
			log.Printf("trash retention: %v", err)
		}
		g.tidyVersions(store, now)
	}
	prune()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prune()
		}
	}
}

// nearestFolder is dir, in store, or the nearest folder above it that's
// there: where a restore that makes dir again starts writing.
func nearestFolder(store *downloadStore, dir string) string {
	for dir = path.Clean(dir); dir != "."; dir = path.Dir(dir) {
		if st, err := store.root.Stat(dir); err == nil && st.IsDir() {
			break
		}
	}
	return dir
}

// brokenEntry reports whether err, readTrash's, means the entry is broken
// for good (part made, by a crash; or not as an entry is written), rather
// than that it couldn't be read this time.
func brokenEntry(err error) bool {
	var syntax *json.SyntaxError
	var kind *json.UnmarshalTypeError
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrInvalid) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.As(err, &syntax) || errors.As(err, &kind)
}
