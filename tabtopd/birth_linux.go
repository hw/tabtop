//go:build linux

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// birthTime is when f's file was made (Unix nanoseconds), or 0 where the
// filesystem doesn't say. An inode number alone doesn't tell a folder from
// one made after it was deleted: ext4 gives a new folder the inode the old
// one freed.
func birthTime(f *os.File) int64 {
	if f == nil {
		return 0
	}
	c, err := f.SyscallConn()
	if err != nil {
		return 0
	}
	var st unix.Statx_t
	var serr error
	if err := c.Control(func(fd uintptr) {
		serr = unix.Statx(int(fd), "", unix.AT_EMPTY_PATH|unix.AT_STATX_SYNC_AS_STAT, unix.STATX_BTIME, &st)
	}); err != nil || serr != nil || st.Mask&unix.STATX_BTIME == 0 {
		return 0
	}
	return st.Btime.Sec*1e9 + int64(st.Btime.Nsec)
}
