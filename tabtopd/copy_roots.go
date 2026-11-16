package main

// Copying and moving between roots, and Trash seen across them.
//
// A transfer is one file or folder, from the request's root into a folder
// of another (ToRoot). A move is a rename where both roots are on one
// filesystem; elsewhere, as a copy is, it's copied: into a hidden folder
// staged in the destination (see uploadStageName), given its name only
// once it's whole, so nothing half copied is ever seen, and what a crash
// leaves is cleaned up as an upload's is. A move then deletes the
// original, and only if every bit of it was copied: links and special
// files, which a copy leaves out, keep a move from starting. A move holds
// its source as a delete does (see holdWrites), and both hold the folder
// they copy into (see folderWrites), so neither is deleted meanwhile.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// maxTransferEntries is the most files and folders one transfer takes.
const maxTransferEntries = 100000

var (
	errTransferOdd        = errors.New("It contains links or special files, which can't be moved to another folder, so nothing was moved. Copy it instead, which leaves those out.")
	errTransferBig        = fmt.Errorf("It has more than %d files and folders: copy or move it in parts.", maxTransferEntries)
	errTransferDeep       = fmt.Errorf("It has folders nested more than %d deep, which can't be copied, so nothing was copied or moved.", maxZipDepth)
	errTransferUnreadable = errors.New("Something in it can't be opened (permission denied), so nothing was copied or moved.")
	errTransferGap        = errors.New("Some of it changed or couldn't be read as it was copied, so nothing was moved.")
)

// renameAcrossRoots is renameBetween, for a move's rename: a variable so
// tests, whose roots share a filesystem, can make it say EXDEV.
var renameAcrossRoots = renameBetween

// transferScan is what a transfer would copy.
type transferScan struct {
	files, dirs int
	bytes       int64
	odd         int // links and special files: never copied
}

// scanTransfer measures what's at name in s, info its Lstat, without
// following links.
func (s *downloadStore) scanTransfer(ctx context.Context, name string, info fs.FileInfo) (transferScan, error) {
	var sc transferScan
	if !info.IsDir() {
		sc.files, sc.bytes = 1, info.Size()
		return sc, nil
	}
	sc.dirs = 1
	err := walkTree(ctx, s.root, name, info, func(p string, info fs.FileInfo) error {
		switch {
		case hiddenDownloadName(path.Base(p)):
			return fs.SkipDir // an unfinished upload's: never copied
		case info.IsDir():
			sc.dirs++
		case info.Mode().IsRegular():
			sc.files++
			sc.bytes += info.Size()
		default:
			sc.odd++
		}
		if sc.files+sc.dirs > maxTransferEntries {
			return errTransferBig
		}
		return nil
	}, nil)
	switch {
	case errors.Is(err, errTreeChanged):
		err = errTransferGap
	case errors.Is(err, fs.ErrPermission):
		err = errTransferUnreadable
	}
	if err != nil {
		return sc, err
	}
	return sc, nil
}

// copier copies from one store into another, never following links:
// what's opened is checked to be what was listed, so one swapped in can't
// lead it elsewhere (into Trash, say).
type copier struct {
	ctx      context.Context
	src, dst *downloadStore
	done     atomic.Int64 // bytes copied so far
	skipped  int          // links, special files, and what changed meanwhile
	buf      []byte
	// seen, for a move, is what was copied, by path in src: its Lstat as
	// listed (see unchanged).
	seen map[string]fs.FileInfo
	// folders are those copied, each after those in it, whose modes and
	// times are set once the copy is in place (see settle): a folder made
	// read-only in the stage couldn't be moved out of it, nor removed.
	folders []copiedFolder
}

type copiedFolder struct {
	to   string // its path in dst, in the stage
	info fs.FileInfo
}

// settle gives the folders copied their modes and times, now the copy's
// moved from stage to at in dst.
func (c *copier) settle(stage, at string) {
	for _, f := range c.folders {
		to := path.Join(at, strings.TrimPrefix(strings.TrimPrefix(f.to, stage), "/"))
		c.dst.root.Chmod(to, f.info.Mode().Perm())
		c.dst.root.Chtimes(to, f.info.ModTime(), f.info.ModTime())
	}
}

// copied records what's at from, as want, copied whole.
func (c *copier) copied(from string, want fs.FileInfo) {
	if c.seen != nil {
		c.seen[from] = want
	}
}

// unchanged reports whether what's at at in src, copied from name (and
// moved aside since: see tunnelTransfer), is still just what was copied:
// nothing in it added, replaced or written to since it was listed. (What's
// gone since was copied, so is no loss.) A move checks it before it
// deletes the original, and finding otherwise, keeps it.
func (c *copier) unchanged(name, at string) bool {
	same := func(p string, now fs.FileInfo) bool {
		was, ok := c.seen[path.Join(name, strings.TrimPrefix(strings.TrimPrefix(p, at), "/"))]
		return ok && os.SameFile(was, now) && was.Mode() == now.Mode() &&
			(now.IsDir() || was.Size() == now.Size() && was.ModTime().Equal(now.ModTime()))
	}
	info, err := c.src.root.Lstat(at)
	if err != nil || !same(at, info) {
		return false
	}
	if !info.IsDir() {
		return true
	}
	return walkTree(context.Background(), c.src.root, at, info, func(p string, info fs.FileInfo) error {
		if hiddenDownloadName(path.Base(p)) {
			return fs.SkipDir // an upload's, unfinished, held (see holdWrites)
		}
		if !same(p, info) {
			return errTransferGap
		}
		return nil
	}, nil) == nil
}

// copyItem copies what's at from in src, want its Lstat, to to in dst.
func (c *copier) copyItem(from string, want fs.FileInfo, to string, depth int) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	switch {
	case want.IsDir():
		if depth > maxZipDepth {
			return errTransferDeep // not left out, unsaid
		}
		return c.copyDir(from, want, to, depth)
	case want.Mode().IsRegular():
		return c.copyFile(from, want, to)
	}
	c.skipped++
	return nil
}

func (c *copier) copyDir(from string, want fs.FileInfo, to string, depth int) error {
	d, err := openRootDirectory(c.src.root, from)
	if errors.Is(err, fs.ErrPermission) {
		return errTransferUnreadable // not left out, unsaid
	}
	if err != nil {
		c.skipped++
		return nil
	}
	defer d.Close()
	if st, err := d.Stat(); err != nil || !os.SameFile(st, want) {
		c.skipped++
		return nil
	}
	if err := c.dst.root.Mkdir(to, 0o700); err != nil {
		return err
	}
	for {
		des, rerr := d.ReadDir(256)
		for _, de := range des {
			if hiddenDownloadName(de.Name()) {
				continue // an upload's, unfinished
			}
			info, err := de.Info()
			if err != nil {
				c.skipped++
				continue
			}
			if err := c.copyItem(path.Join(from, de.Name()), info, path.Join(to, de.Name()), depth+1); err != nil {
				return err
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	c.folders = append(c.folders, copiedFolder{to, want})
	c.copied(from, want)
	return nil
}

func (c *copier) copyFile(from string, want fs.FileInfo, to string) error {
	in, err := c.src.root.OpenFile(from, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, fs.ErrPermission) {
		// Not left out, unsaid, as a link is: the copy would be short of
		// a file, with nothing to show it.
		return errTransferUnreadable
	}
	if err != nil {
		c.skipped++
		return nil
	}
	defer in.Close()
	if st, err := in.Stat(); err != nil || !st.Mode().IsRegular() || !os.SameFile(st, want) {
		c.skipped++
		return nil
	}
	out, err := c.dst.root.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if c.buf == nil {
		c.buf = make([]byte, 1<<20)
	}
	for {
		if err := c.ctx.Err(); err != nil {
			out.Close()
			return err
		}
		n, rerr := in.Read(c.buf)
		if n > 0 {
			if _, err := out.Write(c.buf[:n]); err != nil {
				out.Close()
				return err
			}
			c.done.Add(int64(n))
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			return rerr
		}
	}
	out.Chmod(want.Mode().Perm())
	if err := out.Sync(); err != nil && !syncUnsupported(err) {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := c.dst.root.Chtimes(to, want.ModTime(), want.ModTime()); err != nil {
		return err
	}
	c.copied(from, want)
	return nil
}

// tunnelTransfer answers a transfer request: what's at req.Path copied, or
// with req.Copy unset moved, into the folder req.To of the root req.ToRoot
// (see the top of this file). Accepted, it says {"total", "files"}, then
// {"done"} as it goes, and ends with {"path", "root", "skipped", and any
// "warning"}: where it went, and how many links and special files a copy
// left out. A text message cancels it, as the page going does.
func (g *fileService) tunnelTransfer(t *tunnel, req tunnelRequest, session, ip string, r *tunnelResponder) {
	verb, did := "move", "moved"
	if req.Copy {
		verb, did = "copy", "copied"
	}
	name := g.realItem(req.Path) // as what's tracked of it has it
	if name == "." {
		r.fail("The exposed folder itself can't be copied or moved: open it, and pick what's in it.")
		return
	}
	// Named, always: an empty one would be the default root to
	// rootByID, but not "another root" to the router's checks on To.
	if req.ToRoot == "" {
		r.fail("Choose the folder to copy or move it into.")
		return
	}
	dest, err := g.rootByID(req.ToRoot)
	if err != nil {
		r.fail(err.Error())
		return
	}
	switch {
	case dest == g.root:
		r.fail("That's the folder it's in: use Move to… there.")
		return
	case req.ToRootVersion != "" && req.ToRootVersion != dest.Binding:
		r.failCode("That filesystem root changed. Reload Files before continuing.", "root-changed")
		return
	case dest.ReadOnly:
		r.failCode(dest.Label+" is read-only.", "read-only")
		return
	}
	to := path.Clean(strings.Trim(req.To, "/"))
	there := g.scope(dest)
	there.activityPath = to
	src, err := g.openStore()
	if err != nil {
		r.fail(errDownloadsMissing.Error())
		return
	}
	defer src.Close()
	dst, err := there.openStore()
	if err != nil {
		r.fail(dest.Label + " is unavailable.")
		return
	}
	defer dst.Close()
	if dst.inTrash(to) {
		r.fail("Trash is only available through its restore and delete controls.")
		return
	}
	if st, err := dst.root.Stat(to); err != nil || !st.IsDir() {
		r.fail(errNoFolder.Error())
		return
	}
	// Where to leads, links followed: what's made there is made by this
	// path, as cleanup sees it, and the Trash name checked by it.
	real, err := dst.canonical(to)
	if err != nil {
		r.fail(errNoFolder.Error())
		return
	}
	info, err := src.root.Lstat(name)
	switch {
	case err != nil:
		r.fail("It's gone.")
		return
	case info.Mode()&fs.ModeSymlink != 0:
		r.fail("That's a link: open what it leads to, and copy or move that.")
		return
	case !info.IsDir() && !info.Mode().IsRegular():
		r.fail("That kind of file can't be copied or moved.")
		return
	}
	base := path.Base(name)
	// Not what's hidden: an upload's or a fetch's file, or a copy's stage,
	// which whatever's making it still has.
	if !validUploadName(base) {
		r.fail("It's gone.")
		return
	}
	if real == "." && trashName(base) {
		r.fail("That name is kept for Trash at the top of " + dest.Label + ".")
		return
	}

	// Held until it's done, and let go before replying.
	writing, err := there.root.writes.begin(real)
	if err != nil {
		r.fail(err.Error())
		return
	}
	release := func(bool, string) {}
	paused := 0 // unfinished uploads in it, held
	if !req.Copy {
		hold, held, busy := g.holdWrites(name)
		paused = held
		if busy {
			writing()
			r.fail("Something is still being uploaded or fetched into it. Stop it, or let it finish, then move it.")
			return
		}
		release = hold
	}
	held := true
	let := func(moved bool) {
		if held {
			held = false
			release(moved, "")
			writing()
		}
	}
	defer let(false)

	// A move on one filesystem is a rename, tried first: it moves what's
	// there as it is, links and all, however much, without reading it.
	// (Not of a folder with an unfinished upload in it, whose file a copy
	// leaves behind, removed with the upload's end; and a rename would
	// take to another root, out of its reach.)
	var got string
	if !req.Copy && paused == 0 {
		var carried []carriedVersion
		got, err = freeName(base, info.IsDir(), func(got string) error {
			return renameAcrossRoots(src, path.Dir(name), base, dst, real, got)
		})
		if err == nil {
			carried = g.takeVersions(name)
			there.giveVersions(carried, name, path.Join(real, got))
			g.dropTaken(carried)
			syncDir(dst.root, real)
			syncDir(src.root, path.Dir(name))
			let(true)
			g.transferred(there, session, ip, did, name, to, real, got)
			r.finish(map[string]any{"path": path.Join(to, got), "root": dest.ID, "skipped": 0})
			return
		}
		if !errors.Is(err, syscall.EXDEV) && !errors.Is(err, errNoRename) {
			let(false)
			r.fail(transferError(err))
			return
		}
	}

	// Moved by copying, the original's removed after: not if a drive or
	// share is mounted in it, which would be emptied.
	if !req.Copy && info.IsDir() {
		if err := holdsMount(src.root, name); err != nil {
			let(false)
			r.fail(transferError(err))
			return
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sc, err := src.scanTransfer(ctx, name, info)
	if err == nil && !req.Copy && sc.odd > 0 {
		err = errTransferOdd
	}
	if err != nil {
		let(false)
		r.fail(transferError(err))
		return
	}

	if d, err := openRootDirectory(dst.root, real); err == nil {
		free, _, _, ok := fileDiskSpace(d)
		d.Close()
		if ok && free < sc.bytes {
			let(false)
			r.fail(fmt.Sprintf("There isn't room for it in %s: it's %s, and %s is free.", dest.Label, humanSize(sc.bytes), humanSize(free)))
			return
		}
	}
	token := make([]byte, 16)
	rand.Read(token)
	stage := path.Join(real, uploadTempPrefix+hex.EncodeToString(token)+".stage")
	if err := dst.root.Mkdir(stage, 0o700); err != nil {
		let(false)
		r.fail(transferError(err))
		return
	}
	// Removed, empty or not, before replying: the page may look at once.
	unstage := there.root.writes.staging(stage)
	staged := true
	dropStage := func() {
		if staged {
			staged = false
			dst.root.RemoveAll(stage)
			unstage()
		}
	}
	defer dropStage()
	if !r.accept(map[string]any{"total": sc.bytes, "files": sc.files}) {
		return
	}

	c := &copier{ctx: ctx, src: src, dst: dst}
	if !req.Copy {
		c.seen = map[string]fs.FileInfo{}
	}
	result := make(chan error, 1)
	go func() { result <- c.copyItem(name, info, path.Join(stage, "item"), 0) }()
	// A text message cancels; the page going stops it too.
	var cancelled atomic.Bool
	gone := cancelOnText(t, func() { cancelled.Store(true); cancel() })
	go func() {
		select {
		case <-gone:
			cancel()
		case <-ctx.Done():
		}
	}()
	tick := time.NewTicker(fetchTick)
	defer tick.Stop()
	for finished := false; !finished; {
		select {
		case err = <-result:
			finished = true
		case <-tick.C:
			if writeJSON(t, map[string]any{"done": c.done.Load()}) != nil {
				cancel()
			}
		}
	}
	if cancelled.Load() {
		let(false)
		dropStage()
		r.fail("cancelled")
		return
	}
	if err == nil && !req.Copy && c.skipped > 0 {
		err = errTransferGap
	}
	if err != nil {
		let(false)
		dropStage()
		if ctx.Err() == nil {
			log.Printf("%s couldn't %s %q to %s/%s: %v", ip, verb, name, dest.ID, to, err)
		}
		r.fail(transferError(err))
		return
	}
	got, err = freeName(base, info.IsDir(), func(got string) error { return dst.placeAt(stage, "item", real, got, info.IsDir()) })
	if err != nil {
		let(false)
		dropStage()
		r.fail(transferError(err))
		return
	}
	if err := syncDir(dst.root, real); err != nil && !syncUnsupported(err) {
		log.Printf("%s %s %q to %s/%s, but syncing the folder failed: %v", ip, did, name, dest.ID, to, err)
	}
	c.settle(path.Join(stage, "item"), path.Join(real, got))
	reply := map[string]any{"path": path.Join(to, got), "root": dest.ID, "skipped": c.skipped}
	removed := false
	if !req.Copy {
		var carried []carriedVersion
		if warning := g.removeOriginal(src, name, c); warning != "" {
			reply["warning"] = warning
		} else {
			removed = true
			carried = g.takeVersions(name)
		}
		there.giveVersions(carried, name, path.Join(real, got))
		g.dropTaken(carried)
	}
	let(removed)
	dropStage()
	g.transferred(there, session, ip, did, name, to, real, got)
	r.finish(reply)
}

// removeOriginal removes name from src, now c's copied it, and says why
// not if it doesn't. It's first moved aside, into a hidden folder staged
// beside it (as a copy's is), and checked there: what's written to it by
// its name from then on (a download finishing into it, say) goes nowhere
// that's deleted. Changed, it's put back, by its name if that's free.
func (g *fileService) removeOriginal(src *downloadStore, name string, c *copier) string {
	dir, base := path.Dir(name), path.Base(name)
	token := make([]byte, 16)
	rand.Read(token)
	aside := path.Join(dir, uploadTempPrefix+hex.EncodeToString(token)+".stage")
	if err := src.root.Mkdir(aside, 0o700); err != nil {
		return "Copied, but the original couldn't be removed: " + deleteError(err)
	}
	defer g.root.writes.staging(aside)()
	err := src.renameAt(dir, base, aside, "item")
	if errors.Is(err, errNoRename) {
		// A filesystem without that: plainly, into a folder just made
		// here, where there's nothing to replace.
		err = src.renameOver(name, path.Join(aside, "item"))
	}
	if err != nil {
		src.root.Remove(aside)
		return "Copied, but the original couldn't be removed: " + deleteError(err)
	}
	item := path.Join(aside, "item")
	isDir := c.seen[name].IsDir()
	// putBack puts the original (or what's left of it) back: by its
	// name, or one like it; failing that, the folder it's aside in is
	// given a name to be seen by, not left hidden, where cleanup would
	// take it for a copy's leftovers. It says where it is, for a warning.
	putBack := func() string {
		got, err := freeName(base, isDir, func(got string) error { return src.placeAt(aside, "item", dir, got, isDir) })
		if err == nil {
			src.root.Remove(aside)
			syncDir(src.root, dir)
			if got == base {
				return "it's where it was"
			}
			return "it's there as " + got + ", its name being taken"
		}
		if errors.Is(err, fs.ErrNotExist) {
			src.root.Remove(aside) // nothing left of it
			return "nothing's left of it"
		}
		log.Printf("couldn't put %q back from %s: %v", name, aside, err)
		keep := func(got string) error { return src.placeAt(dir, path.Base(aside), dir, got, true) }
		got, err = freeName(base+" (kept)", true, keep)
		if err != nil {
			// That name too long, say: a short one of its own.
			got, err = freeName("kept after a move", true, keep)
		}
		if err != nil {
			log.Printf("couldn't keep %s: %v", aside, err)
			return "it's hidden, as " + item + ": move it out from a terminal before cleanup removes it"
		}
		syncDir(src.root, dir)
		return "it's kept as item in " + path.Join(dir, got)
	}
	if !c.unchanged(name, item) {
		return "Copied, but the original changed as it was copied, so it was kept (" + putBack() + "): both are there now."
	}
	// Not if something's been mounted in it since it was copied (see
	// holdsMount): it's put back.
	if err := holdsMount(src.root, aside); err != nil {
		return "Copied, but the original couldn't be removed: " + deleteError(err) + " (" + putBack() + ".)"
	}
	if err := src.root.RemoveAll(aside); err != nil {
		// What's left of it, put back: not left hidden.
		return "Copied, but not all of the original could be removed: " + deleteError(err) + " (Of what's left, " + putBack() + ".)"
	}
	syncDir(src.root, dir)
	return ""
}

// transferred logs, and records in the activity log, name copied or moved
// (did) from g's root as got in the folder to of there's, real once links
// are followed.
func (g *fileService) transferred(there *fileService, session, ip, did, name, to, real, got string) {
	log.Printf("%s %s %q to %s/%s through the tunnel", ip, did, name, there.root.ID, path.Join(to, got))
	g.act(session, "files", ip, "%s %s to %s", did, g.root.Label+"/"+name, there.root.Label+"/"+path.Join(to, got))
	there.placed(path.Join(real, got)) // not a new download, wherever it's watched from
}

// transferError is what to tell the page of err from a transfer.
func transferError(err error) string {
	switch {
	case errors.Is(err, errTransferOdd), errors.Is(err, errTransferBig), errors.Is(err, errTransferGap), errors.Is(err, errTransferUnreadable), errors.Is(err, errTransferDeep), errors.Is(err, errHoldsMount),
		errors.Is(err, errNamesTaken), errors.Is(err, errNoFolder), errors.Is(err, errFolderDeleting):
		return err.Error()
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, syscall.ENOSPC):
		return "The disk is full."
	case errors.Is(err, fs.ErrNotExist):
		return "It's gone."
	case errors.Is(err, fs.ErrPermission):
		return "Permission denied."
	}
	return "It couldn't be copied."
}

// rootTrashEntry is a Trash entry, and the root whose Trash it's in.
type rootTrashEntry struct {
	trashEntry
	Root string `json:"root"`
}

// routeTrashAll lists every root's Trash at once: {"roots": each with its
// id, label, shell_path, read_only and version, and any "error" listing its
// Trash; "entries", each with its "root", the latest deleted first; and the
// limits each root's Trash keeps to}.
func (g *server) routeTrashAll(c *tunnelCall) {
	roots := []map[string]any{}
	entries := []rootTrashEntry{}
	for _, service := range g.fileServices() {
		root := service.root
		info := map[string]any{"id": root.ID, "label": root.Label, "shell_path": root.ShellPath, "read_only": root.ReadOnly, "version": root.Binding}
		reply, err := service.trashRequest(tunnelRequest{Type: "trash-list"})
		if err != nil {
			info["error"] = err.Error()
		} else {
			for _, e := range reply["entries"].([]trashEntry) {
				entries = append(entries, rootTrashEntry{e, root.ID})
			}
		}
		roots = append(roots, info)
	}
	slices.SortStableFunc(entries, func(a, b rootTrashEntry) int { return b.Deleted.Compare(a.Deleted) })
	reply := trashReply(nil)
	delete(reply, "entries")
	reply["entries"], reply["roots"] = entries, roots
	c.r.finish(reply)
}
