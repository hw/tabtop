package main

// Renaming files and folders in ~/Downloads from the files page, and
// moving them into other folders there, through the tunnel. Neither ever
// replaces what has the name already.

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
	errNameTaken  = errors.New("That name is taken.")
	errNoRename   = errors.New("This file system can't rename without risking replacing something.")
	errMoveTaken  = errors.New("Something in that folder has the same name.")
	errMoveInside = errors.New("A folder can't go inside itself.")
	errMoveHere   = errors.New("It's in that folder already.")
	errNoFolder   = errors.New("That folder doesn't exist.")
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
	err := renameAt(root, dir, old, dir, newName)
	if errors.Is(err, syscall.EEXIST) {
		return errNameTaken
	}
	return err
}

// moveEntry moves name, a file or folder in root, into the folder to, under
// the same name, as renameEntry renames: never over something there.
func moveEntry(root *os.Root, name, to string) error {
	dir, old := path.Split(name)
	if dir = strings.TrimSuffix(dir, "/"); dir == "" {
		dir = "."
	}
	if to == "" {
		to = "."
	}
	if !validUploadName(old) {
		return fs.ErrNotExist
	}
	if _, err := root.Stat(name); err != nil {
		return fs.ErrNotExist
	}
	if st, err := root.Stat(to); err != nil || !st.IsDir() {
		return errNoFolder
	}
	if path.Clean(to) == path.Clean(dir) {
		return errMoveHere
	}
	if to == name || strings.HasPrefix(to, name+"/") {
		return errMoveInside
	}
	err := renameAt(root, dir, old, to, old)
	switch {
	case errors.Is(err, syscall.EEXIST), errors.Is(err, syscall.ENOTEMPTY):
		return errMoveTaken
	case errors.Is(err, errNoRename):
		// Also what the kernel says of a folder moved inside itself
		// through a symlink, which the check above can't see.
		if st, serr := root.Stat(name); serr == nil && st.IsDir() {
			return errMoveInside
		}
	}
	return err
}

// renameAt renames the entry name in the folder dir in root to newName in
// the folder to. It goes through the folders opened in root, and only ever
// names something directly in them, so it can't reach outside root; and
// RENAME_NOREPLACE fails (with EEXIST) rather than replace what has
// newName, even if it appears at the last moment.
func renameAt(root *os.Root, dir, name, to, newName string) error {
	d, err := root.Open(dir)
	if err != nil {
		return fs.ErrNotExist
	}
	defer d.Close()
	t, err := root.Open(to)
	if err != nil {
		return errNoFolder
	}
	defer t.Close()
	dc, err := d.SyscallConn()
	if err != nil {
		return err
	}
	tc, err := t.SyscallConn()
	if err != nil {
		return err
	}
	var rerr error
	if err := dc.Control(func(dfd uintptr) {
		if err := tc.Control(func(tfd uintptr) {
			rerr = unix.Renameat2(int(dfd), name, int(tfd), newName, unix.RENAME_NOREPLACE)
		}); err != nil {
			rerr = err
		}
	}); err != nil {
		return err
	}
	switch {
	case errors.Is(rerr, syscall.EINVAL), errors.Is(rerr, syscall.ENOSYS):
		return errNoRename
	case errors.Is(rerr, syscall.ENOENT):
		return fs.ErrNotExist
	case errors.Is(rerr, syscall.ENOTDIR):
		return errNoFolder
	}
	return rerr
}

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

// tunnelMove answers a move request, of the file or folder at req.Path into
// the folder req.To.
func (g *server) tunnelMove(t *tunnel, req tunnelRequest, ip string, reply func(map[string]any) bool, fail func(string)) {
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail(renameError(err))
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	to := strings.Trim(req.To, "/")
	if err := moveEntry(root, name, to); err != nil {
		if !errors.Is(err, errMoveTaken) && !errors.Is(err, errMoveHere) && !errors.Is(err, errMoveInside) {
			log.Printf("%s couldn't move %s to %s/ through the tunnel: %v", ip, name, to, err)
		}
		fail(renameError(err))
		return
	}
	log.Printf("%s moved %s to %s/ through the tunnel", ip, name, to)
	g.placed(path.Join(to, path.Base(name)))
	reply(nil)
	t.Close(websocket.StatusNormalClosure, "")
}
