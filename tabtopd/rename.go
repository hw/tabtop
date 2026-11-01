package main

// Renaming files and folders in ~/Downloads from the files page, through
// the tunnel. A rename never replaces what has the new name already.

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path"
	"strings"
	"syscall"

	"github.com/coder/websocket"
	"golang.org/x/sys/unix"
)

var (
	errNameTaken = errors.New("That name is taken.")
	errNoRename  = errors.New("This file system can't rename without risking replacing something.")
)

// renameEntry renames name, a file or folder in root, to newName, in the
// same folder. It goes through the folder opened in root, and only ever
// names something directly in it, so it can't reach outside root; and
// RENAME_NOREPLACE fails rather than replace what has newName, even if it
// appears at the last moment.
func renameEntry(root *os.Root, name, newName string) error {
	dir, old := path.Split(name)
	if dir = strings.TrimSuffix(dir, "/"); dir == "" {
		dir = "."
	}
	if !validUploadName(old) {
		return fs.ErrNotExist
	}
	if !validUploadName(newName) {
		return errUploadName
	}
	if _, err := root.Stat(name); err != nil {
		return fs.ErrNotExist // a symlink leading outside isn't listed, so isn't there
	}
	d, err := root.Open(dir)
	if err != nil {
		return fs.ErrNotExist
	}
	defer d.Close()
	sc, err := d.SyscallConn()
	if err != nil {
		return err
	}
	var rerr error
	if err := sc.Control(func(fd uintptr) {
		rerr = unix.Renameat2(int(fd), old, int(fd), newName, unix.RENAME_NOREPLACE)
	}); err != nil {
		return err
	}
	switch {
	case errors.Is(rerr, syscall.EEXIST):
		return errNameTaken
	case errors.Is(rerr, syscall.EINVAL), errors.Is(rerr, syscall.ENOSYS):
		return errNoRename
	case errors.Is(rerr, syscall.ENOENT):
		return fs.ErrNotExist
	}
	return rerr
}

// renameError is what to tell the user about err.
func renameError(err error) string {
	switch {
	case errors.Is(err, errNameTaken), errors.Is(err, errNoRename), errors.Is(err, errUploadName):
		return err.Error()
	case errors.Is(err, fs.ErrNotExist):
		return "It's gone."
	case errors.Is(err, fs.ErrPermission):
		return "It can't be renamed: permission denied."
	}
	return "It couldn't be renamed."
}

// tunnelRename answers a rename request, of the file or folder at
// req.Path to req.Name.
func (g *server) tunnelRename(t *tunnel, req tunnelRequest, ip string, reply func(map[string]any) bool, fail func(string)) {
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail(renameError(err))
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if err := renameEntry(root, name, req.Name); err != nil {
		if !errors.Is(err, errNameTaken) {
			log.Printf("%s couldn't rename %s through the tunnel: %v", ip, name, err)
		}
		fail(renameError(err))
		return
	}
	log.Printf("%s renamed %s to %s through the tunnel", ip, name, req.Name)
	reply(nil)
	t.Close(websocket.StatusNormalClosure, "")
}
