package main

// downloadStore owns filesystem operations for Downloads. Protocol handlers
// keep transport and session policy; opened-file validation and publication
// live here so new callers use the same filesystem protections.
import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"syscall"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

type downloadStore struct {
	root *os.Root
	// ending, if set, is told of a Trash entry about to be removed for
	// good, with the Trash root it's in, and returns what to call once its
	// removal's been tried (see fileService.trashLinks).
	ending func(trash *os.Root, e trashEntry) (tried func())
	// checked are paths already found not to lead into Trash, by the
	// request this store was opened for (see requestScope).
	checked []string
	// index is the root's Trash entries as last read (see trashIndex).
	index *trashIndex

	// What inTrash has found, for it to use again (see inTrash).
	mu        sync.Mutex
	trashSeen bool               // Trash was there
	realDirs  map[string]realDir // folders, by path, resolved
}

type realDir struct {
	real string
	err  error
}

func (s *downloadStore) Close() error { return s.root.Close() }

// downloadItem owns both the confined store and its opened descriptor.
// Callers choose whether directories are allowed; protocol errors stay uniform.
type downloadItem struct {
	store *downloadStore
	file  *os.File
	info  fs.FileInfo
	name  string
}

var errDownloadsMissing = errors.New("The exposed folder is unavailable.")
var errDownloadMissing = errors.New("Not found.")

func (item *downloadItem) Close() error { return errors.Join(item.file.Close(), item.store.Close()) }

// A trailing separator makes the kernel require a directory before opening
// the final component. os.OpenRoot alone can block on a FIFO before checking
// its type. Keep an empty path invalid and avoid growing paths on resume.
func openDirectoryRoot(dir string) (*os.Root, error) {
	if dir != "" && !strings.HasSuffix(dir, string(os.PathSeparator)) {
		dir += string(os.PathSeparator)
	}
	return os.OpenRoot(dir)
}

// Reject non-directories during open, before a swapped-in FIFO can block.
// Root still confines symlink resolution to Downloads.
const directoryOpenFlags = os.O_RDONLY | syscall.O_NONBLOCK | unix.O_DIRECTORY

func openRootDirectory(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, directoryOpenFlags, 0)
}

func (s *downloadStore) open(name string) (*os.File, fs.FileInfo, error) {
	if !slices.Contains(s.checked, path.Clean(strings.Trim(name, "/"))) && s.inTrash(name) {
		return nil, nil, fs.ErrNotExist
	}
	f, err := s.root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	if !st.Mode().IsRegular() && !st.IsDir() {
		f.Close()
		return nil, nil, fmt.Errorf("unsupported file type: %w", fs.ErrInvalid)
	}
	return f, st, nil
}

func (s *downloadStore) openRegular(name string, want fs.FileInfo) (*os.File, error) {
	f, st, err := s.open(name)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || !os.SameFile(st, want) {
		f.Close()
		return nil, fs.ErrInvalid
	}
	return f, nil
}

func (s *downloadStore) resume(p *partialUpload, size int64) (*upload, int64) {
	root := s.root
	f, err := root.OpenFile(p.tmp, os.O_WRONLY|os.O_APPEND|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, 0
	}
	u := &upload{root: root, dir: p.dir, tmp: p.tmp, f: f}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || p.identity == nil || !os.SameFile(st, p.identity) {
		f.Close() // not the gateway's file any more: left alone
		return nil, 0
	}
	if st.Size() != p.held || st.Size() > size {
		// Still the gateway's, but not as it was kept. It's no longer kept
		// either, so nothing else would delete it: the page starts again.
		u.abort()
		return nil, 0
	}
	return u, st.Size()
}

// upload is a file being uploaded into dir in root.
type upload struct {
	root     *os.Root
	dir, tmp string
	f        *os.File
	unsynced bool // saved, but its folder may not be on disk yet
	// keep, if set, keeps the file a save replaces, open, as a version (see
	// keepVersion), and returns what undoes that if the save then fails.
	keep func(old *os.File) (drop func())
}

// id names the upload to resume it (see keepPartial): its temporary
// file's random part.
func (u *upload) id() string {
	return strings.TrimSuffix(strings.TrimPrefix(path.Base(u.tmp), uploadTempPrefix), ".part")
}

// startUpload creates the temporary file for an upload into dir.
func (s *downloadStore) startUpload(dir string) (*upload, error) {
	root := s.root
	st, err := root.Stat(dir)
	if err != nil || !st.IsDir() {
		return nil, fs.ErrNotExist
	}
	b := make([]byte, 8)
	rand.Read(b)
	tmp := path.Join(dir, uploadTempPrefix+hex.EncodeToString(b)+".part")
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	return &upload{root: root, dir: dir, tmp: tmp, f: f}, nil
}

func (u *upload) Write(p []byte) (int, error) { return u.f.Write(p) }

// abort removes the temporary file.
func (u *upload) abort() {
	u.f.Close()
	u.root.Remove(u.tmp)
}

// finish saves the upload as name, or as the first free name like it, and
// returns the name it got. With replace, it's saved as name even if a file
// has that name, replacing it in one step, but never a folder.
func (u *upload) finish(name string, replace bool) (string, error) {
	return u.finishAt(name, replace, nil)
}

// target pins the destination used by the replacement's lock and version
// check. Temporary-file cleanup still uses the upload's original store.
func (u *upload) finishAt(name string, replace bool, target *downloadStore) (string, error) {
	return u.finishWith(name, replace, target, nil)
}

// guard can authorize publication of a new name after the file is synced.
func (u *upload) finishWith(name string, replace bool, target *downloadStore, guard func(func() (string, error)) (string, error)) (string, error) {
	root, dir := u.root, u.dir
	if target != nil {
		root, dir = target.root, "."
	}
	defer u.f.Close()
	temporary, _ := u.f.Stat()
	defer func() {
		// If the alias was retargeted after pinning, clean up through the
		// pinned destination rather than another directory now at u.dir.
		if target != nil && temporary != nil {
			name := path.Base(u.tmp)
			if st, err := target.root.Lstat(name); err == nil && os.SameFile(st, temporary) {
				target.root.Remove(name)
				return
			}
		}
		u.root.Remove(u.tmp)
	}()
	// On disk before the page is told it's saved, so a power cut can't
	// lose it after.
	if err := u.f.Sync(); err != nil {
		u.f.Close()
		return "", err
	}
	if replace {
		target := path.Join(dir, name)
		if st, err := root.Lstat(target); err == nil && st.IsDir() {
			return "", errReplaceFolder
		} else if err == nil && st.Mode()&fs.ModeSymlink != 0 {
			// Replaced, the link would go, and the file it leads to stay as
			// it was, though what's checked first (see unchangedSince) is
			// that file.
			return "", errReplaceLink
		} else if err == nil && st.Mode().IsRegular() {
			// The new file keeps the old one's permissions: a script edited
			// stays one that runs.
			u.f.Chmod(st.Mode().Perm())
		}
		drop := func() {}
		if u.keep != nil {
			if old, err := root.OpenFile(target, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0); err == nil {
				if ost, err := old.Stat(); err == nil && ost.Mode().IsRegular() {
					drop = u.keep(old)
				}
				old.Close()
			}
		}
		if err := u.publishAt(name, true, root, dir); err != nil {
			drop()
			return "", err
		}
		if err := syncDir(root, dir); err != nil && !syncUnsupported(err) {
			log.Printf("upload saved as %q, but syncing its folder failed: %v", target, err)
			u.unsynced = true
		}
		return name, nil
	}
	// Unlike a rename, a link fails rather than replace a file.
	publish := func() (string, error) {
		return freeName(name, false, func(got string) error { return u.publish(got, false) })
	}
	if guard == nil {
		guard = func(publish func() (string, error)) (string, error) { return publish() }
	}
	got, err := guard(publish)
	if err != nil {
		return "", err
	}
	// And the folder, so the name is. If that fails, the file is still
	// saved, so the upload is too, with a warning; unless the file system
	// can't sync a folder at all, where the file being synced is as far as
	// it goes (and saying so on every upload would only be noise).
	if err := syncDir(u.root, u.dir); err != nil && !syncUnsupported(err) {
		log.Printf("upload saved as %q, but syncing its folder failed: %v", path.Join(u.dir, got), err)
		u.unsynced = true
	}
	return got, nil
}

// publish links the open, synced inode rather than trusting its temporary
// pathname. Replacement uses an isolated staging directory on the same
// filesystem and descriptor-relative rename into the opened destination.
func (u *upload) publish(name string, replace bool) error {
	return u.publishAt(name, replace, u.root, u.dir)
}

func (u *upload) publishAt(name string, replace bool, root *os.Root, dir string) error {
	d, err := openRootDirectory(root, dir)
	if err != nil {
		return err
	}
	defer d.Close()
	link := func(to *os.File, name string) error {
		return unix.Linkat(unix.AT_FDCWD, fmt.Sprintf("/proc/self/fd/%d", u.f.Fd()), int(to.Fd()), name, unix.AT_SYMLINK_FOLLOW)
	}
	if !replace {
		return link(d, name)
	}
	b := make([]byte, 16)
	rand.Read(b)
	stage := path.Join(dir, uploadTempPrefix+hex.EncodeToString(b)+".stage")
	if err := root.Mkdir(stage, 0700); err != nil {
		return err
	}
	defer root.Remove(stage)
	s, err := openRootDirectory(root, stage)
	if err != nil {
		return err
	}
	defer s.Close()
	defer unix.Unlinkat(int(s.Fd()), "saved", 0)
	if err := link(s, "saved"); err != nil {
		return err
	}
	return unix.Renameat(int(s.Fd()), "saved", int(d.Fd()), name)
}

// errNamesTaken is every name like one wanted taken (see freeName).
var errNamesTaken = errors.New("There are too many items with that name.")

// freeName gives name, or the first numbered name like it (see
// numberedName) that's free, to what put puts there: it tries each in
// turn, while put says the name is taken (fs.ErrExist, or ENOTEMPTY, as a
// rename onto a folder says), and returns the one it got. A folder's name
// is all name: "photos.2024 (1)"; as is a dotfile's: ".bashrc (1)".
func freeName(name string, folder bool, put func(name string) error) (string, error) {
	ext := path.Ext(name)
	if folder || ext == name {
		ext = ""
	}
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		got := name
		if i > 0 {
			got = numberedName(base, ext, i)
		}
		err := put(got)
		if err == nil {
			return got, nil
		}
		if !errors.Is(err, fs.ErrExist) && !errors.Is(err, syscall.ENOTEMPTY) {
			return "", err
		}
	}
	return "", errNamesTaken
}

// numberedName is "base (i)ext", with base cut short (at a character's
// end) if that would be longer than a name can be. If the extension leaves
// no room, it's cut short as part of the name instead.
func numberedName(base, ext string, i int) string {
	suffix := fmt.Sprintf(" (%d)", i)
	room := maxNameBytes - len(suffix) - len(ext)
	if room < 1 {
		base, ext = base+ext, ""
		room = maxNameBytes - len(suffix)
	}
	for len(base) > room {
		_, size := utf8.DecodeLastRuneInString(base)
		base = base[:len(base)-size]
	}
	return base + suffix + ext
}

// syncUnsupported reports whether err, from a sync, is the filesystem
// saying it can't, rather than that it failed.
func syncUnsupported(err error) bool {
	return errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP)
}

func syncDir(root *os.Root, dir string) error {
	d, err := openRootDirectory(root, dir)
	if err != nil {
		return err
	}
	err = d.Sync()
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	return err
}

// makeFolder creates the folder name in dir, or the first free name like
// it, as an upload does for a file, and returns the name it got: an
// uploaded folder never merges into one already there.
func (s *downloadStore) makeFolder(dir, name string) (string, error) {
	root := s.root
	if !validNewName(name) {
		return "", errUploadName
	}
	if st, err := root.Stat(dir); err != nil || !st.IsDir() {
		return "", fs.ErrNotExist
	}
	got, err := freeName(name, true, func(got string) error { return root.Mkdir(path.Join(dir, got), 0o755) })
	if err == nil {
		syncDir(root, dir) // only files are promised to be on disk
	}
	return got, err
}

// createFile creates an empty file name in dir, or the first free name
// like it (as an upload does), and returns the name it got.
func (s *downloadStore) createFile(dir, name string) (string, error) {
	root := s.root
	if !validNewName(name) {
		return "", errUploadName
	}
	if st, err := root.Stat(dir); err != nil || !st.IsDir() {
		return "", fs.ErrNotExist
	}
	got, err := freeName(name, false, func(got string) error {
		f, err := root.OpenFile(path.Join(dir, got), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			f.Close()
		}
		return err
	})
	if err != nil {
		return "", err
	}
	if err := syncDir(root, dir); err != nil && !syncUnsupported(err) {
		log.Printf("empty file saved as %q, but syncing its folder failed: %v", path.Join(dir, got), err)
	}
	return got, nil
}

// deleteFile deletes the file or folder at name in root, a folder with
// everything in it, and reports whether it was a folder. A symlink is
// deleted itself, not what it leads to, and nothing is followed out of
// root.
func (s *downloadStore) deleteFile(name string) (bool, error) {
	root := s.root
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
		// Not what holds a mount, whose filesystem RemoveAll would empty.
		if err := holdsMount(root, name); err != nil {
			return true, err
		}
		// RemoveAll works through open folders, not paths, and doesn't
		// follow symlinks, so nothing swapped in can lead it out.
		return true, root.RemoveAll(name)
	}
	return false, root.Remove(name)
}

// renameEntry renames name, a file or folder in root, to newName, in the
// same folder. It goes through the folder opened in root, and only ever
// names something directly in it, so it can't reach outside root; and
// RENAME_NOREPLACE fails rather than replace what has newName, even if it
// appears at the last moment.
func (s *downloadStore) renameEntry(name, newName string) error {
	root := s.root
	dir, old := path.Split(name)
	if dir = strings.TrimSuffix(dir, "/"); dir == "" {
		dir = "."
	}
	if !validUploadName(old) {
		return fs.ErrNotExist
	}
	if !validNewName(newName) {
		return errUploadName
	}
	if _, err := root.Stat(name); err != nil {
		return fs.ErrNotExist // a symlink leading outside isn't listed, so isn't there
	}
	err := s.renameAt(dir, old, dir, newName)
	if errors.Is(err, syscall.EEXIST) {
		return errNameTaken
	}
	return err
}

// moveEntry moves name, a file or folder in root, into the folder to, under
// the same name, as renameEntry renames: never over something there.
func (s *downloadStore) moveEntry(name, to string) error {
	root := s.root
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
	if trashName(old) && s.isTop(to) {
		return errMoveTaken // Trash's own place
	}
	if to == name || strings.HasPrefix(to, name+"/") {
		return errMoveInside
	}
	err := s.renameAt(dir, old, to, old)
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
func (s *downloadStore) renameAt(dir, name, to, newName string) error {
	return renameBetween(s, dir, name, s, to, newName)
}

// placeAt moves name, in the folder dir, to got in the folder to, taking
// no other's name: as renameAt does it; or, on a filesystem that can't
// rename without risking replacing something, as an upload is published
// there: a folder renamed over an empty one just made by that name, a
// file linked by it (neither of which takes a name in use).
func (s *downloadStore) placeAt(dir, name, to, got string, isDir bool) error {
	err := s.renameAt(dir, name, to, got)
	if !errors.Is(err, errNoRename) {
		return err
	}
	return s.placePlainly(path.Join(dir, name), path.Join(to, got), isDir)
}

// renameOver renames from to at, paths in the root, plainly: as rename(2)
// does it, replacing a file, or an empty folder, that's there. For where
// that's wanted, or nothing can be there.
func (s *downloadStore) renameOver(from, at string) error {
	d, err := openRootDirectory(s.root, path.Dir(from))
	if err != nil {
		return err
	}
	defer d.Close()
	t, err := openRootDirectory(s.root, path.Dir(at))
	if err != nil {
		return err
	}
	defer t.Close()
	return unix.Renameat(int(d.Fd()), path.Base(from), int(t.Fd()), path.Base(at))
}

// placePlainly is placeAt's way where renaming can't be told not to
// replace: from made at, a name not in use.
func (s *downloadStore) placePlainly(from, at string, isDir bool) error {
	if isDir {
		if err := s.root.Mkdir(at, 0o700); err != nil {
			return err
		}
		if err := s.renameOver(from, at); err != nil {
			s.root.Remove(at)
			return err
		}
		return nil
	}
	if err := s.root.Link(from, at); err != nil {
		return err
	}
	s.root.Remove(from)
	return nil
}

// renameBetween is renameAt from the folder dir in src to the folder to in
// dst, which may be another root: on another filesystem, the kernel says
// EXDEV, and nothing's moved.
func renameBetween(src *downloadStore, dir, name string, dst *downloadStore, to, newName string) error {
	d, err := openRootDirectory(src.root, dir)
	if err != nil {
		return fs.ErrNotExist
	}
	defer d.Close()
	t, err := openRootDirectory(dst.root, to)
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

func (s *downloadStore) stat(name string) (fs.FileInfo, error) { return s.root.Stat(name) }
func (s *downloadStore) removeTemporary(name string) error     { return s.root.Remove(name) }
