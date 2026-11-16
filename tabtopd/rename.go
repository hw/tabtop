package main

// Renaming files and folders in ~/Downloads from the files page, and
// moving them into other folders there, through the tunnel. Neither ever
// replaces what has the name already.

import (
	"errors"
	"io/fs"
	"log"
	"path"
)

var (
	errNameTaken  = errors.New("That name is taken.")
	errNoRename   = errors.New("This file system can't rename without risking replacing something.")
	errMoveTaken  = errors.New("Something in that folder has the same name.")
	errMoveInside = errors.New("A folder can't go inside itself.")
	errMoveHere   = errors.New("It's in that folder already.")
	errNoFolder   = errors.New("That folder doesn't exist.")
)

// renameError is what to tell the user about err, from a rename or a move.
func renameError(err error) string {
	switch {
	case errors.Is(err, errNameTaken), errors.Is(err, errNoRename), errors.Is(err, errUploadName), errors.Is(err, errMoveTaken),
		errors.Is(err, errMoveInside), errors.Is(err, errMoveHere), errors.Is(err, errNoFolder):
		return err.Error()
	case errors.Is(err, fs.ErrNotExist):
		return "It's gone."
	case errors.Is(err, fs.ErrPermission):
		return "Permission denied."
	}
	return "It couldn't be renamed or moved."
}

// tunnelRename answers a rename request, of the file or folder at
// req.Path to req.Name.
func (g *fileService) tunnelRename(t *tunnel, req tunnelRequest, ip string, r *tunnelResponder) {
	root, err := g.openStore()
	if err != nil {
		r.fail(renameError(err))
		return
	}
	defer root.Close()
	name := g.realItem(req.Path) // as what's tracked of it has it
	release, ok := g.holdForMove(name, r)
	if !ok {
		return
	}
	err = root.renameEntry(name, req.Name)
	if err == nil {
		g.moveVersions(name, path.Join(path.Dir(name), req.Name))
	}
	if err != nil {
		release(false, "")
		if !errors.Is(err, errNameTaken) {
			log.Printf("%s couldn't rename %q through the tunnel: %v", ip, name, err)
		}
		r.fail(renameError(err))
		return
	}
	log.Printf("%s renamed %q to %q through the tunnel", ip, name, req.Name)
	release(true, path.Join(path.Dir(name), req.Name))
	r.finish(nil)
}

// tunnelMove answers a move request, of the file or folder at req.Path into
// the folder req.To.
func (g *fileService) tunnelMove(t *tunnel, req tunnelRequest, ip string, r *tunnelResponder) {
	root, err := g.openStore()
	if err != nil {
		r.fail(renameError(err))
		return
	}
	defer root.Close()
	name := g.realItem(req.Path) // as what's tracked of it has it
	to := g.resolved(req.To)
	release, ok := g.holdForMove(name, r)
	if !ok {
		return
	}
	err = root.moveEntry(name, to)
	if err == nil {
		g.moveVersions(name, path.Join(to, path.Base(name)))
	}
	if err != nil {
		release(false, "")
		if !errors.Is(err, errMoveTaken) && !errors.Is(err, errMoveHere) && !errors.Is(err, errMoveInside) {
			log.Printf("%s couldn't move %q to %q through the tunnel: %v", ip, name, to, err)
		}
		r.fail(renameError(err))
		return
	}
	log.Printf("%s moved %q to %q through the tunnel", ip, name, to)
	release(true, path.Join(to, path.Base(name)))
	g.placed(path.Join(to, path.Base(name)))
	r.finish(nil)
}

// holdForMove holds what's being written into name, a file or folder
// about to be renamed or moved, as a delete does (see holdWrites): what's
// being uploaded, fetched or extracted into it is tracked by its path, so
// it would carry on, unseen, under the new one. If something is, it fails
// r, saying so. Uploads kept to resume in it are given up once it's moved
// (release(true, to)), their files removed where they went.
func (g *fileService) holdForMove(name string, r *tunnelResponder) (release func(moved bool, to string), ok bool) {
	if path.Clean(name) == "." {
		return func(bool, string) {}, true // refused as it's renamed
	}
	hold, _, busy := g.holdWrites(name)
	if busy {
		r.fail("Something is still being uploaded or fetched into it. Stop it, or let it finish, then rename or move it.")
		return nil, false
	}
	return hold, true
}
