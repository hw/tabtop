package main

// Deleting files and folders in ~/Downloads from the files page, through
// the tunnel. Uploads in progress, and ~/Downloads itself, are left alone.

import (
	"errors"
	"io/fs"
	"log"
	"strings"
)

var errTopFolder = errors.New("The Downloads folder itself can't be deleted.")

// deleteError is what to tell the user about err.
func deleteError(err error) string {
	switch {
	case errors.Is(err, errTopFolder):
		return err.Error()
	case errors.Is(err, fs.ErrNotExist):
		return "It's already gone."
	case errors.Is(err, fs.ErrPermission):
		return "It can't be deleted: permission denied."
	}
	return "It couldn't be deleted."
}

// tunnelDelete answers a delete request for the file or folder at
// req.Path.
func (g *server) tunnelDelete(t *tunnel, req tunnelRequest, ip string, r *tunnelResponder) {
	root, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail(deleteError(err))
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		name = "."
	}
	dir, err := root.deleteFile(name)
	if err != nil {
		log.Printf("%s couldn't delete %q through the tunnel: %v", ip, name, err)
		r.fail(deleteError(err))
		return
	}
	if dir {
		name += "/ and everything in it"
	}
	log.Printf("%s deleted %q through the tunnel", ip, name)
	r.finish(nil)
}
