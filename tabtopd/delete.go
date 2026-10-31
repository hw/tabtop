package main

// Deleting files in ~/Downloads from the files page, through the tunnel.
// Only files: folders, and uploads in progress, are left alone.

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path"
	"strings"

	"github.com/coder/websocket"
)

var errNotFile = errors.New("Only files can be deleted.")

// deleteFile deletes the file at name in root. A symlink is deleted
// itself, not what it leads to.
func deleteFile(root *os.Root, name string) error {
	if !validUploadName(path.Base(name)) {
		return fs.ErrNotExist
	}
	// Lstat for the entry itself, Stat for what the listing shows: a
	// symlink to a folder lists as a folder, and one leading outside isn't
	// listed at all.
	lst, err := root.Lstat(name)
	if err != nil {
		return fs.ErrNotExist
	}
	st, err := root.Stat(name)
	if err != nil {
		return fs.ErrNotExist
	}
	if lst.IsDir() || st.IsDir() {
		return errNotFile
	}
	return root.Remove(name)
}

// deleteError is what to tell the user about err.
func deleteError(err error) string {
	switch {
	case errors.Is(err, errNotFile):
		return err.Error()
	case errors.Is(err, fs.ErrNotExist):
		return "The file is already gone."
	case errors.Is(err, fs.ErrPermission):
		return "The file can't be deleted."
	}
	return "The file couldn't be deleted."
}

// tunnelDelete answers a delete request for the file at req.Path.
func (g *server) tunnelDelete(t *tunnel, req tunnelRequest, ip string, reply func(map[string]any) bool, fail func(string)) {
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail(deleteError(fs.ErrNotExist))
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		err = errNotFile
	} else {
		err = deleteFile(root, name)
	}
	if err != nil {
		fail(deleteError(err))
		return
	}
	log.Printf("%s deleted %s through the tunnel", ip, name)
	reply(nil)
	t.Close(websocket.StatusNormalClosure, "")
}
