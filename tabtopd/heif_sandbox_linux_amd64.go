//go:build heif && linux

package main

import "golang.org/x/sys/unix"

const heifAuditArch = unix.AUDIT_ARCH_X86_64

// x86-64's older forms of the calls heifDenied has.
var heifLegacyDenied = []uintptr{unix.SYS_OPEN, unix.SYS_CREAT, unix.SYS_UNLINK, unix.SYS_RENAME, unix.SYS_MKDIR,
	unix.SYS_RMDIR, unix.SYS_LINK, unix.SYS_SYMLINK, unix.SYS_CHMOD, unix.SYS_CHOWN, unix.SYS_LCHOWN, unix.SYS_MKNOD,
	unix.SYS_FORK, unix.SYS_VFORK, unix.SYS_UTIME, unix.SYS_UTIMES, unix.SYS_FUTIMESAT}
