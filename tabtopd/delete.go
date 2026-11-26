package main

// Moving files and folders to Trash through the tunnel, or deleting them
// outright when Trash can't take them. Uploads in progress, and the root
// itself, are left alone.

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"
)

var errTopFolder = errors.New("The exposed folder itself can't be deleted.")

// errTrashUnavailable is the code of a delete Trash can't take, so the page
// can offer to delete it permanently instead.
const errTrashUnavailable = "trash-unavailable"

// deleteError is what to tell the user about err.
func deleteError(err error) string {
	switch {
	case errors.Is(err, errTopFolder), errors.Is(err, errTrashLimit), errors.Is(err, errTrashBlocked), errors.Is(err, errTrashUnreadable),
		errors.Is(err, errTrashSlow), errors.Is(err, errTrashFull), errors.Is(err, errHoldsMount):
		return err.Error()
	case errors.Is(err, errTrashSetup):
		why := "it can't be written there"
		if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
			why = "the disk is full"
		}
		return "Trash can't be used for this just now: " + why + ". Nothing was deleted."
	case errors.Is(err, syscall.EBUSY):
		// Deleting it outright would empty what's mounted there.
		return "It's in use, or something is mounted there, so it can't be deleted."
	case errors.Is(err, syscall.EXDEV):
		return "It's on another filesystem from Trash, so it can't be moved there. Nothing was deleted."
	case errors.Is(err, errNoRename):
		return "This filesystem can't move things to Trash safely, so nothing was deleted."
	case errors.Is(err, fs.ErrNotExist):
		return "It's already gone."
	case errors.Is(err, fs.ErrPermission):
		return "It can't be deleted: permission denied."
	}
	return "It couldn't be deleted."
}

// trashRefused reports whether err means Trash can't take the item at all,
// rather than that deleting failed.
func trashRefused(err error) bool {
	return errors.Is(err, errTrashLimit) || errors.Is(err, errTrashFull) || errors.Is(err, errTrashBlocked) || errors.Is(err, errTrashUnreadable) || errors.Is(err, errTrashSlow) || errors.Is(err, errTrashSetup) || errors.Is(err, syscall.EXDEV) || errors.Is(err, errNoRename)
}

// tunnelDelete answers a delete request for the file or folder at
// req.Path: it moves it to Trash, or with req.Permanent removes it.
func (g *fileService) tunnelDelete(call *tunnelCall) {
	req, ip, r := call.req, call.ip, call.r
	root, err := g.openStore()
	if err != nil {
		r.fail(deleteError(err))
		return
	}
	defer root.Close()
	// Where it really is: what's tracked of it (writes, uploads, versions)
	// is, whatever path it's reached by.
	name := g.realItem(req.Path)
	release := func(bool, string) {}
	if name != "." {
		hold, _, busy := g.holdWrites(name)
		if busy {
			r.fail("Something is still being uploaded or fetched into this folder. Stop it, or let it finish, then delete the folder.")
			return
		}
		release = hold
	}
	// Released before replying, as the page may at once upload again, or
	// ask to delete permanently.
	done := func(gone bool, movedTo string) {
		release(gone, movedTo)
		release = func(bool, string) {}
	}
	defer done(false, "")
	if req.Permanent {
		ending := g.linksInto(root.root, name, name)
		dir, err := root.deleteFile(name)
		if err != nil {
			log.Printf("%s couldn't delete %q through the tunnel: %v", ip, name, err)
			done(false, "")
			r.fail(deleteError(err))
			return
		}
		// Gone for good, and what it was before saves too, and the links to
		// it.
		g.endLinks(ending, name)
		g.dropVersionsUnder(name)
		if dir {
			name += "/ and everything in it"
		}
		log.Printf("%s permanently deleted %q through the tunnel", ip, name)
		done(true, "")
		r.finish(nil)
		return
	}
	// Measured first, not holding up Trash meanwhile (a big folder on a
	// slow disk can take seconds), then moved there.
	// (Not what putTrash refuses anyway: the root, or what's in Trash.)
	size, err := int64(-1), error(nil)
	if clean := path.Clean(name); clean != "." && validTrashPath(clean) && !root.trashPathHere(clean) {
		size, err = root.trashSize(clean)
	}
	var item trashEntry
	g.root.trashMu.Lock()
	if err == nil {
		// Not if it would only fit by dropping what was deleted just
		// before it (others of the same selection, say), unasked.
		err = g.trashRoom(root, size, time.Now())
	}
	if err == nil {
		if item, err = root.putTrashOnly(name, time.Now(), size); err == nil {
			g.root.trashFresh = append(g.root.trashFresh, freshTrash{time.Now(), item.Bytes})
		}
	}
	if err == nil {
		// Its versions go with it, kept by its entry's path, to come back
		// with it: not left to be shown as a new file's at its old path.
		g.relocateVersions("", item.Path, item.ID, item.Path)
	}
	g.root.trashMu.Unlock()
	if err == nil {
		g.pruneTrashSoon()
	}
	if err != nil {
		log.Printf("%s couldn't move %q to Trash through the tunnel: %v", ip, name, err)
		code := ""
		if trashRefused(err) {
			code = errTrashUnavailable
		}
		done(false, "")
		r.failCode(deleteError(err), code)
		return
	}
	done(true, path.Join(trashDir, item.ID, "data"))
	if item.Dir {
		name += "/ and everything in it"
	}
	log.Printf("%s moved %q to Trash through the tunnel", ip, name)
	r.finish(map[string]any{"id": item.ID})
}

// holdWrites reports whether an upload, fetch or ZIP extraction into
// name, a folder, or a folder in it, is going on: deleting it then would
// leave the file being written in Trash, growing. If none is, none can
// start until release (see folderWrites), and the uploads kept there to
// resume are held, not resumed. release says whether the folder went, and
// if to Trash, where to (its path in the root): if it went, they're given
// up, as there'd be nowhere to resume them, their files removed from
// where they went; if not, they can carry on. Writes and uploads are
// known by where they really go (see beginWrites): so is name, here,
// whatever path it's given by (the item itself, not what it may link to,
// as it's what goes).
func (g *fileService) holdWrites(name string) (release func(gone bool, movedTo string), held int, busy bool) {
	name = g.realItem(name)
	end, busy := g.root.writes.startDeleting(name)
	if busy {
		return nil, 0, true
	}
	uploads, busy := g.root.transfers.holdUnder(name, g.resolved)
	if busy {
		end()
		return nil, 0, true
	}
	links, busy := g.holdLinkUploadsUnder(g.root.ID, name, g.resolved)
	if busy {
		g.root.transfers.release(uploads, false, nil)
		end()
		return nil, 0, true
	}
	return func(gone bool, movedTo string) {
		defer end()
		var moved func(string) string
		if movedTo != "" {
			// A file in name is now under movedTo.
			moved = func(p string) string {
				p = path.Clean(p)
				if p == name {
					return movedTo
				}
				return path.Join(movedTo, strings.TrimPrefix(p, name+"/"))
			}
		}
		g.root.transfers.release(uploads, gone, moved)
		if len(links) > 0 {
			g.releaseLinkUploads(links, gone, moved)
		}
	}, len(uploads) + len(links), false
}

// inFolder reports whether p, a path in a root, is folder or in it.
func inFolder(p, folder string) bool {
	p, folder = path.Clean(strings.Trim(p, "/")), path.Clean(strings.Trim(folder, "/"))
	return folder == "." || pathWithin(p, folder)
}

// realItem is the item at p, in g's root, by where it really is: the
// folder it's in resolved (see resolved), it itself not followed, being
// what's acted on. "." for the root.
func (g *fileService) realItem(p string) string {
	p = path.Clean(strings.Trim(p, "/"))
	if p == "." {
		return p
	}
	return path.Join(g.resolved(path.Dir(p)), path.Base(p))
}

// resolved is the folder p, in g's root, as it really is, links in it
// followed (see canonical); or p, if that can't be told.
func (g *fileService) resolved(p string) string {
	p = path.Clean(strings.Trim(p, "/"))
	if p == "." {
		return p
	}
	if g.req != nil {
		g.req.realMu.Lock()
		real, ok := g.req.real[p]
		g.req.realMu.Unlock()
		if ok {
			return real
		}
	}
	store, err := g.openStore()
	if err != nil {
		return p
	}
	defer store.Close()
	real, err := store.canonical(p)
	if err != nil {
		return p
	}
	if g.req != nil {
		g.req.realMu.Lock()
		if g.req.real == nil {
			g.req.real = map[string]string{}
		}
		g.req.real[p] = real
		g.req.realMu.Unlock()
	}
	return real
}

// beginWrites records a write into the folder dir going on (see
// folderWrites), by where it really is, so a delete or move of it by
// another path, through a link, sees it.
// What it returns ends it, and can be called more than once: before
// replying, so a delete or move that follows the reply at once isn't
// told it's still going, and again by a defer.
func (g *fileService) beginWrites(dir string) (func(), error) {
	end, err := g.root.writes.begin(g.resolved(dir))
	if err != nil {
		return nil, err
	}
	var once sync.Once
	return func() { once.Do(end) }, nil
}

// trashPruneDelay is how long after an item's put in Trash it's pruned.
const trashPruneDelay = 2 * time.Second

// pruneTrashSoon keeps Trash to its limits a moment from now, once for
// all that's deleted meanwhile: many items selected come as a delete
// each, and pruning reads all of Trash.
func (g *fileService) pruneTrashSoon() {
	if !g.root.trashPruning.CompareAndSwap(false, true) {
		return // one's on its way
	}
	files := g.server.scope(g.root) // not this request's, which ends
	time.AfterFunc(trashPruneDelay, func() {
		files.root.trashPruning.Store(false)
		files.root.trashMu.Lock()
		defer files.root.trashMu.Unlock()
		store, err := files.openStore()
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
		pruned, err := trash.pruneTrash(now)
		if err != nil {
			log.Printf("trash retention: %v", err)
		}
		if pruned > 0 {
			// Older entries, gone for good: their versions go too.
			files.tidyVersions(store, now)
		}
	})
}

// trashFreshFor is how long what's put in Trash counts as just deleted:
// not to be dropped, unasked, to make room for more.
const trashFreshFor = 5 * time.Minute

// errTrashFull is an item Trash could only take by dropping what was
// deleted just before it.
var errTrashFull = fmt.Errorf("Trash is full of what was just deleted (it keeps %s and %d items), and would have to drop some of that for this. Nothing was deleted.", humanSize(trashBytes), trashCount)

// freshTrash is an item put in Trash, and when.
type freshTrash struct {
	at    time.Time
	bytes int64
}

// trashRoom is errTrashFull if an item of size bytes (-1: not known)
// would fit in Trash only by pruning what was put there within
// trashFreshFor: several deleted together can be more than Trash keeps,
// and the first of them would go for good to make room for the last,
// with nothing said. It goes by what's been put there since the gateway
// started, kept in memory; and before refusing, by Trash as it is, which
// what's been restored or deleted from it since has left. g.root.trashMu
// is held.
func (g *fileService) trashRoom(store *downloadStore, size int64, now time.Time) error {
	size = max(size, 0)
	over := func() bool {
		var bytes int64
		kept := g.root.trashFresh[:0]
		for _, f := range g.root.trashFresh {
			if now.Sub(f.at) < trashFreshFor {
				kept = append(kept, f)
				bytes += f.bytes
			}
		}
		g.root.trashFresh = kept
		return bytes+size > trashBytes || len(kept)+1 > trashCount
	}
	if !over() {
		return nil
	}
	trash, err := store.openTrash(false)
	if err != nil {
		return nil
	}
	defer trash.Close()
	entries, err := trash.trashEntries()
	if err != nil {
		return nil
	}
	g.root.trashFresh = g.root.trashFresh[:0]
	for _, e := range entries {
		g.root.trashFresh = append(g.root.trashFresh, freshTrash{e.Deleted, e.Bytes})
	}
	if over() {
		return errTrashFull
	}
	return nil
}
