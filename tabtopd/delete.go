package main

// Deleting files and folders in ~/Downloads from the files page, through
// the tunnel. Uploads in progress, and ~/Downloads itself, are left alone.

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path"
	"strings"

	"github.com/coder/websocket"
)

var errTopFolder = errors.New("The Downloads folder itself can't be deleted.")

// deleteFile deletes the file or folder at name in root, a folder with
// everything in it, and reports whether it was a folder. A symlink is
// deleted itself, not what it leads to, and nothing is followed out of
// root.
func deleteFile(root *os.Root, name string) (bool, error) {
	if name == "." {
		return false, errTopFolder
	}
	if !validUploadName(path.Base(name)) {
		return false, fs.ErrNotExist
	}
	// Lstat for the entry itself, Stat for what the listing shows: a
	// symlink to a folder lists as a folder, and one leading outside isn't
	// listed at all.
	lst, err := root.Lstat(name)
	if err != nil {
		return false, fs.ErrNotExist
	}
	if _, err := root.Stat(name); err != nil {
		return false, fs.ErrNotExist
	}
	if lst.IsDir() {
		// RemoveAll works through open folders, not paths, and doesn't
		// follow symlinks, so nothing swapped in can lead it out.
		return true, root.RemoveAll(name)
	}
	return false, root.Remove(name)
}

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
func (g *server) tunnelDelete(t *tunnel, req tunnelRequest, ip string, reply func(map[string]any) bool, fail func(string)) {
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail(deleteError(err))
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		name = "."
	}
	dir, err := deleteFile(root, name)
	if err != nil {
		log.Printf("%s couldn't delete %s through the tunnel: %v", ip, name, err)
		fail(deleteError(err))
		return
	}
	if dir {
		name += "/ and everything in it"
	}
	log.Printf("%s deleted %s through the tunnel", ip, name)
	reply(nil)
	t.Close(websocket.StatusNormalClosure, "")
}
