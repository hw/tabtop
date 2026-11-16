package main

// Versions: what a file was before a save replaced it, or wrote into it,
// kept for a while to compare with and put back.
//
// They're kept in Trash's folder, as versionsDir, a name Trash's own
// entries (IDs) never have, so Trash leaves it alone, and it's out of
// reach as everything in Trash is (see reachesTrash): one entry each, as a
// Trash entry is (see trashEntry; its Deleted is when it was kept), with
// the file's path in its root, by which they're found again. A file
// replaced by a save (an upload, an editor's) is kept by a hard link to
// it, which costs nothing, as the new file takes its name; one written
// into (the hex editor's), by a copy. Retention is their own: a few for
// each file, for a while, within a size and a count for the root.

import (
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
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	versionsDir     = "versions"
	versionsPerFile = 10
	versionsCount   = 500
	versionsBytes   = 512 << 20
	versionAge      = 30 * 24 * time.Hour
	// versionMax is the largest file kept: bigger ones aren't; and
	// versionMaxCopy, the largest copied (see keepVersion), which takes
	// room a link doesn't.
	versionMax     = 128 << 20
	versionMaxCopy = 16 << 20
)

// openVersions opens the versions folder in Trash, t, making it if make.
func (t *downloadStore) openVersions(make bool, index *trashIndex) (*downloadStore, error) {
	if make {
		if err := t.root.Mkdir(versionsDir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
	}
	st, err := t.root.Lstat(versionsDir)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, errTrashBlocked
	}
	root, err := t.root.OpenRoot(versionsDir)
	if err != nil {
		return nil, err
	}
	return &downloadStore{root: root, index: index}, nil
}

// versionStore opens g's versions folder, making it (and Trash) if make;
// close closes all it opened.
func (g *fileService) versionStore(make bool) (v *downloadStore, close func(), err error) {
	store, err := g.openStore()
	if err != nil {
		return nil, nil, errDownloadsMissing
	}
	trash, err := store.openTrash(make)
	if err != nil {
		store.Close()
		return nil, nil, err
	}
	v, err = trash.openVersions(make, &g.root.versions)
	if err != nil {
		trash.Close()
		store.Close()
		return nil, nil, err
	}
	return v, func() { v.Close(); trash.Close(); store.Close() }, nil
}

// keepVersion keeps old, open, as the file at name (a path in g's root)
// is now, before a save: by a link to it if it's to be replaced, by a copy
// if written into (copy). It's best kept, not needed: what fails is
// logged, and the save goes ahead. It returns what undoes it, for a save
// that then fails.
func (g *fileService) keepVersion(name string, old *os.File, copy bool) (drop func()) {
	drop = func() {}
	name = g.realItem(name) // by where it really is, however it was reached
	st, err := old.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > versionMax || copy && st.Size() > versionMaxCopy || g.root.ReadOnly {
		return drop
	}
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	id, err := g.addVersionLocked(name, old, st, copy, time.Now(), versionMaxCopy, true)
	if err != nil {
		log.Printf("couldn't keep the version of %q before saving: %v", name, err)
		return drop
	}
	return func() {
		g.root.versionsMu.Lock()
		defer g.root.versionsMu.Unlock()
		if v, closeAll, err := g.versionStore(false); err == nil {
			v.root.RemoveAll(id)
			closeAll()
		}
	}
}

// addVersionLocked keeps old, open, of st, as a version of the file at
// name, made at, linked or (if copy, or it can't be) copied, if it's at
// most maxCopy; then, with prune, keeps the versions to their limits.
// It's linked only if it has no name but its own: one with another,
// which a program could write into, would change as a version
// shouldn't. g.root.versionsMu is held.
func (g *fileService) addVersionLocked(name string, old *os.File, st fs.FileInfo, copy bool, at time.Time, maxCopy int64, prune bool) (string, error) {
	v, closeAll, err := g.versionStore(true)
	if err != nil {
		return "", err
	}
	defer closeAll()
	b := make([]byte, 16)
	rand.Read(b)
	id := hex.EncodeToString(b)
	if err := v.root.Mkdir(id, 0o700); err != nil {
		return "", err
	}
	err = errors.New("copy")
	if sys, ok := st.Sys().(*syscall.Stat_t); !copy && ok && sys.Nlink <= 1 {
		err = linkOpen(v.root, id, old)
	}
	if err != nil && st.Size() <= maxCopy {
		err = copyOpen(v.root, path.Join(id, "data"), old, st)
	}
	if err == nil {
		e := trashEntry{ID: id, Path: name, Bytes: st.Size(), Deleted: at, Modified: st.ModTime()}
		data, _ := json.Marshal(e)
		var f *os.File
		if f, err = v.root.OpenFile(id+"/info.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
			_, err = f.Write(data)
			err = errors.Join(err, f.Close())
		}
	}
	if err != nil {
		v.root.RemoveAll(id)
		return "", err
	}
	if prune {
		if err := v.pruneVersions(time.Now()); err != nil {
			log.Printf("version retention: %v", err)
		}
	}
	return id, nil
}

// carriedVersion is a version taken from one root to be put in
// another's (see takeVersions): what's known of it, and its data, open.
type carriedVersion struct {
	e trashEntry
	f *os.File
}

// takeVersions opens, in g's root, the versions of what was at from, as
// it's moved to another root: quick, holding up nothing while they're
// put there, linked or copied (see giveVersions); then dropped here
// (see dropTaken). Open, they're kept for that whatever happens here.
func (g *fileService) takeVersions(from string) []carriedVersion {
	from = path.Clean(from)
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	v, closeAll, err := g.versionStore(false)
	if err != nil {
		return nil // none
	}
	defer closeAll()
	entries, err := v.trashEntries()
	if err != nil {
		log.Printf("versions: %v", err)
		return nil
	}
	var them []carriedVersion
	for _, e := range entries {
		if e.Trashed != "" || !pathWithin(e.Path, from) {
			continue
		}
		if f, err := v.root.OpenFile(e.ID+"/data", os.O_RDONLY|syscall.O_NOFOLLOW, 0); err == nil {
			them = append(them, carriedVersion{e, f})
		}
	}
	return them
}

// dropTaken removes, from g's root, the versions taken, put in another's
// (see takeVersions).
func (g *fileService) dropTaken(them []carriedVersion) {
	if len(them) == 0 {
		return
	}
	ids := map[string]bool{}
	for _, c := range them {
		ids[c.e.ID] = true
	}
	g.dropVersions(func(e trashEntry) bool { return ids[e.ID] })
}

// giveVersions puts them, taken from what was at from in another root,
// in g's, for what's now at to: each linked, or copied, as made when it
// was. Those that can't be are lost, logged.
func (g *fileService) giveVersions(them []carriedVersion, from, to string) {
	from, to = path.Clean(from), path.Clean(to)
	defer func() {
		for _, c := range them {
			c.f.Close()
		}
	}()
	if len(them) == 0 || g.root.ReadOnly {
		return
	}
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	for _, c := range them {
		st, err := c.f.Stat()
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		p := path.Join(to, strings.TrimPrefix(strings.TrimPrefix(c.e.Path, from), "/"))
		// Kept already: linked where it can be (its one name the version
		// it was, which goes), else copied, whatever its size.
		if _, err := g.addVersionLocked(p, c.f, st, false, c.e.Deleted, versionMax, false); err != nil {
			log.Printf("versions: carrying %s's to %s/%q: %v", c.e.ID, g.root.ID, p, err)
		}
	}
	// Kept to their limits once, for them all.
	if v, closeAll, err := g.versionStore(false); err == nil {
		if err := v.pruneVersions(time.Now()); err != nil {
			log.Printf("version retention: %v", err)
		}
		closeAll()
	}
}

// linkOpen links f, open, as data in the folder dir of root: by
// /proc/self/fd, which needs no privilege, as AT_EMPTY_PATH would.
func linkOpen(root *os.Root, dir string, f *os.File) error {
	d, err := openRootDirectory(root, dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return unix.Linkat(unix.AT_FDCWD, fmt.Sprintf("/proc/self/fd/%d", f.Fd()), int(d.Fd()), "data", unix.AT_SYMLINK_FOLLOW)
}

// copyOpen copies f, open, of st, to name in root.
func copyOpen(root *os.Root, name string, f *os.File, st fs.FileInfo) error {
	out, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.NewSectionReader(f, 0, st.Size()))
	if err = errors.Join(err, out.Close()); err != nil {
		return err
	}
	return root.Chtimes(name, st.ModTime(), st.ModTime())
}

// pruneVersions removes, from v, versions past their time, beyond the
// latest versionsPerFile of each file, and then the oldest while there are
// more than versionsCount or versionsBytes.
func (v *downloadStore) pruneVersions(now time.Time) error {
	entries, err := v.trashEntries() // oldest first
	if err != nil {
		return err
	}
	var errs []error
	perFile := map[string]int{}
	gone := make([]bool, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		perFile[e.Trashed+"/"+e.Path]++
		gone[i] = perFile[e.Trashed+"/"+e.Path] > versionsPerFile || now.Sub(e.Deleted) >= versionAge
	}
	var total int64
	count := 0
	for i, e := range entries {
		if !gone[i] {
			total += e.Bytes
			count++
		}
	}
	for i, e := range entries {
		if !gone[i] && total <= versionsBytes && count <= versionsCount {
			continue
		}
		if !gone[i] {
			total -= e.Bytes
			count--
		}
		// One that can't be removed doesn't stop the rest.
		if err := v.root.RemoveAll(e.ID); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// versionsOf lists the versions of the file at p, newest first.
func (g *fileService) versionsOf(p string) ([]trashEntry, error) {
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	v, closeAll, err := g.versionStore(false)
	if errors.Is(err, fs.ErrNotExist) {
		return []trashEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer closeAll()
	entries, err := v.trashEntries()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	out := []trashEntry{}
	for i := len(entries) - 1; i >= 0; i-- {
		if e := entries[i]; e.Trashed == "" && e.Path == p && now.Sub(e.Deleted) < versionAge {
			out = append(out, e)
		}
	}
	return out, nil
}

// dropVersions removes the versions gone says are to go (those of files
// deleted for good, say), and says how many it removed.
func (g *fileService) dropVersions(gone func(e trashEntry) bool) int {
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	v, closeAll, err := g.versionStore(false)
	if err != nil {
		return 0 // none
	}
	defer closeAll()
	entries, err := v.trashEntries()
	if err != nil {
		log.Printf("versions: %v", err)
		return 0
	}
	n := 0
	for _, e := range entries {
		if !gone(e) {
			continue
		}
		if err := v.root.RemoveAll(e.ID); err != nil {
			log.Printf("versions: %v", err)
			continue
		}
		n++
	}
	return n
}

// moveVersions has the versions of what was at from (a file, or what's in
// a folder) follow it to to, as it's renamed or moved in g's root.
func (g *fileService) moveVersions(from, to string) {
	g.relocateVersions("", from, "", to)
}

// relocateVersions moves the versions of what was at from, in the Trash
// entry fromTrash ("" for none: in the root), to to, in toTrash: as it's
// renamed or moved, put in Trash (its path kept, in its entry) or restored
// from it. Any left at to, of a file gone from there, go first.
func (g *fileService) relocateVersions(fromTrash, from, toTrash, to string) {
	from, to = path.Clean(from), path.Clean(to)
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	v, closeAll, err := g.versionStore(false)
	if err != nil {
		return // none
	}
	defer closeAll()
	entries, err := v.trashEntries()
	if err != nil {
		log.Printf("versions: %v", err)
		return
	}
	changed := false
	defer func() {
		if changed {
			v.index.store(nil) // what's cached has the old places
		}
	}()
	moving := func(e trashEntry) bool { return e.Trashed == fromTrash && pathWithin(e.Path, from) }
	for _, e := range entries {
		if e.Trashed == toTrash && pathWithin(e.Path, to) && !moving(e) {
			v.root.RemoveAll(e.ID)
			changed = true
		}
	}
	for _, e := range entries {
		if !moving(e) {
			continue
		}
		changed = true
		e.Trashed = toTrash
		e.Path = path.Join(to, strings.TrimPrefix(strings.TrimPrefix(e.Path, from), "/"))
		data, _ := json.Marshal(e)
		tmp := e.ID + "/info.json.new"
		v.root.Remove(tmp)
		err := v.root.WriteFile(tmp, data, 0o600)
		if err == nil {
			err = v.root.Rename(tmp, e.ID+"/info.json")
		}
		if err != nil {
			v.root.Remove(tmp)
			log.Printf("versions: moving %s's to %q: %v", e.ID, e.Path, err)
		}
	}
}

// tidyVersions keeps g's versions to their limits (see pruneVersions),
// whether or not anything in the root is saved again, and removes those
// that went to Trash with a file whose Trash entry, in store, is gone
// (see relocateVersions). g.root.trashMu is held.
func (g *fileService) tidyVersions(store *downloadStore, now time.Time) {
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	v, closeAll, err := g.versionStore(false)
	if err != nil {
		return // none
	}
	defer closeAll()
	// Those a crash left part made, too, which nothing lists or counts.
	if err := errors.Join(v.pruneOrphans(now, orphanGrace), v.pruneVersions(now)); err != nil {
		log.Printf("versions: %v", err)
	}
	entries, err := v.trashEntries()
	if err != nil {
		log.Printf("versions: %v", err)
		return
	}
	// Those of files in Trash whose entry's gone, with them, for good.
	// (Those of a file not at its path otherwise are kept their time: it
	// may be back, as a drive unmounted for now, or a branch checked out.)
	for _, e := range entries {
		if e.Trashed == "" {
			continue
		}
		if _, err := store.root.Lstat(path.Join(trashDir, e.Trashed, "data")); !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err := v.root.RemoveAll(e.ID); err != nil {
			log.Printf("versions: %v", err)
		}
	}
}

// dropVersionsUnder removes the versions of what was at name, a file or
// a folder, now gone from it for good.
func (g *fileService) dropVersionsUnder(name string) {
	name = path.Clean(name)
	g.dropVersions(func(e trashEntry) bool { return e.Trashed == "" && pathWithin(e.Path, name) })
}

// tunnelVersionDelete answers a version-delete request: the version
// req.Name of the file at req.Path removed, or with no Name, all of them;
// {"deleted": how many}.
func (g *fileService) tunnelVersionDelete(req tunnelRequest, session, ip string, r *tunnelResponder) {
	p := g.realItem(req.Path) // versions are kept by where it really is
	if req.Name != "" && !validTrashID(req.Name) {
		r.fail(errNoVersion.Error())
		return
	}
	n := g.dropVersions(func(e trashEntry) bool { return e.Trashed == "" && e.Path == p && (req.Name == "" || e.ID == req.Name) })
	if req.Name != "" && n == 0 {
		r.fail(errNoVersion.Error())
		return
	}
	if n > 0 {
		g.act(session, "files", ip, "deleted %d earlier version%s of %s", n, plural(n), p)
	}
	r.finish(map[string]any{"deleted": n})
}

var errNoVersion = errors.New("That version is gone: versions are kept for a while, and only a few of each file.")

// openVersion opens the version id of the file at p: its data, and what's
// known of it.
func (g *fileService) openVersion(p, id string) (*os.File, trashEntry, error) {
	g.root.versionsMu.Lock()
	defer g.root.versionsMu.Unlock()
	v, closeAll, err := g.versionStore(false)
	if err != nil {
		return nil, trashEntry{}, errNoVersion
	}
	defer closeAll()
	e, err := v.readTrash(id)
	if err != nil || e.Path != p || e.Trashed != "" {
		return nil, trashEntry{}, errNoVersion
	}
	f, err := v.root.OpenFile(id+"/data", os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, trashEntry{}, errNoVersion
	}
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, trashEntry{}, errNoVersion
	}
	return f, e, nil
}

// tunnelVersions answers a versions request: {"versions"} of the file at
// req.Path, newest first, each {id, deleted (when it was kept), bytes,
// modified (when it was last changed then)}.
func (g *fileService) tunnelVersions(req tunnelRequest, r *tunnelResponder) {
	p := g.realItem(req.Path) // versions are kept by where it really is
	versions, err := g.versionsOf(p)
	if err != nil {
		r.fail("Versions: " + err.Error())
		return
	}
	reply := map[string]any{"versions": versions, "max": versionsPerFile, "days": int(versionAge / (24 * time.Hour))}
	// The file as it is, for a restore to be sure it still is.
	if store, err := g.openStore(); err == nil {
		if st, err := store.stat(p); err == nil && st.Mode().IsRegular() {
			reply["mtime"], reply["size"] = fileVersion(st), st.Size()
		}
		store.Close()
	}
	r.finish(reply)
}

// tunnelVersionFile answers a version-file request: the version req.Name of
// the file at req.Path, as a file request is answered.
func (g *fileService) tunnelVersionFile(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	p := g.realItem(req.Path) // versions are kept by where it really is
	f, _, err := g.openVersion(p, req.Name)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		r.fail(errNoVersion.Error())
		return
	}
	if !r.accept(map[string]any{"name": path.Base(p), "size": st.Size(), "mtime": fileVersion(st), "offset": 0, "length": st.Size()}) {
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	if _, err := io.CopyN(w, f, st.Size()); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		r.finish(nil)
	}
}

// tunnelVersionRestore answers a version-restore request: the file at
// req.Path made the version req.Name again, as a save would make it, so
// what it is now is kept as a version in turn, if it's still as it was
// when the versions were listed (req.IfMtime, req.IfSize: see
// tunnelVersions); {"mtime", "size"} after.
func (g *fileService) tunnelVersionRestore(req tunnelRequest, session, ip string, r *tunnelResponder) {
	p := g.realItem(req.Path) // versions are kept by where it really is
	if p == "." || !validTrashPath(p) {
		r.fail(errNoVersion.Error())
		return
	}
	if req.IfMtime == "" {
		r.fail("Restoring a version needs the file as it was seen (if_mtime, if_size), so a save since isn't lost.")
		return
	}
	f, e, err := g.openVersion(p, req.Name)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer f.Close()
	store, err := g.openStore()
	if err != nil {
		r.fail(errDownloadsMissing.Error())
		return
	}
	defer store.Close()
	dir, name := path.Dir(p), path.Base(p)
	if store.inTrash(dir) {
		r.fail(errRestoreIntoTrash.Error())
		return
	}
	writing, err := g.beginWrites(dir)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer writing()
	u, err := store.startUpload(dir)
	if err != nil {
		r.fail("The folder it was in is gone.")
		return
	}
	if _, err := io.Copy(u.f, f); err != nil {
		u.abort()
		r.fail(uploadError(err))
		return
	}
	u.f.Chmod(0o644)
	target, unlock, err := store.beginReplacement(p)
	if err != nil {
		u.abort()
		r.fail(uploadError(err))
		return
	}
	// Not over a save made since the versions were listed: checked as
	// it's replaced, under its lock.
	if err := unchangedSince(target, name, req.IfMtime, req.IfSize); err != nil {
		unlock()
		u.abort()
		r.fail(err.Error())
		return
	}
	u.keep = func(old *os.File) func() { return g.keepVersion(p, old, false) }
	_, err = u.finishAt(name, true, target)
	var st fs.FileInfo
	if err == nil {
		st, err = target.root.Stat(name)
	}
	unlock()
	if err != nil {
		r.fail(uploadError(err))
		return
	}
	log.Printf("%s restored %q as it was at %s through the tunnel", ip, p, e.Deleted.Format(time.RFC3339))
	g.act(session, "files", ip, "restored %s as it was at %s", p, e.Deleted.Format(time.RFC3339))
	g.placed(p)
	writing() // over, before the page's told (see beginWrites)
	r.finish(map[string]any{"mtime": fileVersion(st), "size": st.Size()})
}
