package main

// Renaming files and folders in ~/Downloads from the files page, and
// moving them into other folders there, through the tunnel. Neither ever
// replaces what has the name already.

import (
	"errors"
	"io/fs"
	"log"
	"path"
	"strings"
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
func (g *server) tunnelRename(t *tunnel, req tunnelRequest, ip string, r *tunnelResponder) {
	root, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail(renameError(err))
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if err := root.renameEntry(name, req.Name); err != nil {
		if !errors.Is(err, errNameTaken) {
			log.Printf("%s couldn't rename %q through the tunnel: %v", ip, name, err)
		}
		r.fail(renameError(err))
		return
	}
	log.Printf("%s renamed %q to %q through the tunnel", ip, name, req.Name)
	r.finish(nil)
}

// tunnelMove answers a move request, of the file or folder at req.Path into
// the folder req.To.
func (g *server) tunnelMove(t *tunnel, req tunnelRequest, ip string, r *tunnelResponder) {
	root, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail(renameError(err))
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	to := strings.Trim(req.To, "/")
	if err := root.moveEntry(name, to); err != nil {
		if !errors.Is(err, errMoveTaken) && !errors.Is(err, errMoveHere) && !errors.Is(err, errMoveInside) {
			log.Printf("%s couldn't move %q to %q through the tunnel: %v", ip, name, to, err)
		}
		r.fail(renameError(err))
		return
	}
	log.Printf("%s moved %q to %q through the tunnel", ip, name, to)
	g.placed(path.Join(to, path.Base(name)))
	r.finish(nil)
}
