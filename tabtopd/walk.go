package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
)

// errTreeChanged is walkTree's when a folder it opens isn't the one it
// listed: replaced, or swapped for a link, as it was read.
var errTreeChanged = errors.New("a folder changed as it was read")

// walkTree visits what's in the folder name in root, info its Lstat,
// never following links: each folder is opened, and checked to be the
// one listed (os.SameFile), before it's read, 256 names at a time. visit
// is called for each entry, with its path and Lstat; what it returns for
// a folder decides whether it's read: fs.SkipDir leaves it, and any other
// error ends the walk with it. Entries gone as they're listed are passed
// over. Bounds on how much is walked are visit's to keep.
//
// A folder in it that's gone since it was listed is passed over. One that
// can't be read, whole, ends the walk: one that can't be opened
// (permission denied), or that's changed (errTreeChanged) since it was
// listed, before anything in it was visited. Unless passed
// is given: then it's called with the folder's path and why, and what it
// returns, nil to go on without that folder, decides.
func walkTree(ctx context.Context, root *os.Root, name string, info fs.FileInfo, visit func(p string, info fs.FileInfo) error, passed func(p string, why error) error) error {
	type dir struct {
		p    string
		want fs.FileInfo
	}
	dirs := []dir{{name, info}}
	for len(dirs) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		d := dirs[len(dirs)-1]
		dirs = dirs[:len(dirs)-1]
		pass := func(err error) error {
			if d.p != name && passed != nil && (errors.Is(err, fs.ErrPermission) || errors.Is(err, fs.ErrNotExist) || errors.Is(err, errTreeChanged)) {
				return passed(d.p, err)
			}
			return err
		}
		f, err := openRootDirectory(root, d.p)
		if err != nil {
			// Gone since it was listed, as an entry gone as it's listed:
			// passed over, whoever's walking.
			if d.p != name && passed == nil && errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err := pass(err); err != nil {
				return err
			}
			continue
		}
		if st, err := f.Stat(); err != nil || !os.SameFile(st, d.want) {
			f.Close()
			if err := pass(errTreeChanged); err != nil {
				return err
			}
			continue
		}
		err = func() error {
			defer f.Close()
			for {
				des, rerr := f.ReadDir(256)
				for _, de := range des {
					info, err := de.Info()
					if errors.Is(err, fs.ErrNotExist) {
						continue
					}
					if err != nil {
						return err
					}
					p := path.Join(d.p, de.Name())
					switch err := visit(p, info); {
					case errors.Is(err, fs.SkipDir):
					case err != nil:
						return err
					case info.IsDir():
						dirs = append(dirs, dir{p, info})
					}
				}
				if rerr == io.EOF {
					return nil
				}
				if rerr != nil {
					return rerr
				}
			}
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

// errHoldsMount is what can't be moved to Trash or deleted, holding (or
// being) where a filesystem is mounted: emptied, a drive or share mounted
// there would be emptied with it.
var errHoldsMount = errors.New("Something is mounted in it (a drive or a share), so it can't be moved to Trash, deleted, or moved by copying it: unmount it first. Nothing was changed.")

// holdsMount reports, as errHoldsMount, whether the folder name in root
// is, or holds, where a filesystem is mounted (a drive, a share, a bind
// mount), as the gateway's mount table has it; or what kept that from
// being known. It reads the table, not the tree: as quick for a folder of
// millions of files as for an empty one.
func holdsMount(root *os.Root, name string) error {
	f, err := openRootDirectory(root, name)
	if err != nil {
		return err
	}
	defer f.Close()
	at, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd()))
	if err != nil {
		return err
	}
	mounts, err := rootMounts()
	if err != nil {
		return err
	}
	for _, m := range mounts {
		if pathWithin(m.target, at) {
			return errHoldsMount
		}
	}
	return nil
}
