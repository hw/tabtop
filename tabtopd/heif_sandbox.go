//go:build heif && linux && (amd64 || arm64)

package main

// The HEIC child's sandbox (see heif.go): once libheif has loaded its
// plugins, a seccomp filter, on every thread of the child, refuses what
// decoding a picture from stdin to stdout has no need of: opening files,
// sockets, running programs, tracing others, changing files. A decoder a
// crafted picture took over can then read and write only what it was
// given (its stdin, stdout).
import (
	"errors"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// heifDenied are the system calls refused, as well as heifLegacyDenied
// (the architecture's older forms of them).
var heifDenied = []uintptr{
	unix.SYS_OPENAT, unix.SYS_OPENAT2, unix.SYS_OPEN_BY_HANDLE_AT, unix.SYS_NAME_TO_HANDLE_AT,
	unix.SYS_SOCKET, unix.SYS_SOCKETPAIR, unix.SYS_CONNECT, unix.SYS_BIND, unix.SYS_LISTEN, unix.SYS_ACCEPT4,
	unix.SYS_EXECVE, unix.SYS_EXECVEAT, unix.SYS_PTRACE, unix.SYS_PROCESS_VM_READV, unix.SYS_PROCESS_VM_WRITEV,
	unix.SYS_UNLINKAT, unix.SYS_RENAMEAT, unix.SYS_RENAMEAT2, unix.SYS_MKDIRAT, unix.SYS_MKNODAT, unix.SYS_SYMLINKAT,
	unix.SYS_LINKAT, unix.SYS_FCHMODAT, unix.SYS_FCHOWNAT, unix.SYS_TRUNCATE, unix.SYS_MOUNT, unix.SYS_KEXEC_LOAD,
}

// heifSandbox puts the child in its sandbox, or says why it couldn't (a
// kernel, or container, that doesn't allow it: decoding goes on, as it did).
func heifSandbox() error {
	deny := append(append([]uintptr{}, heifDenied...), heifLegacyDenied...)
	const (
		load  = 0x20 // BPF_LD | BPF_W | BPF_ABS
		jeq   = 0x15 // BPF_JMP | BPF_JEQ | BPF_K
		jge   = 0x35 // BPF_JMP | BPF_JGE | BPF_K
		ret   = 0x06 // BPF_RET | BPF_K
		x32   = 0x40000000
		epERM = uint32(syscall.EPERM)
	)
	// Another architecture's calls (as x86-64's 32-bit ones): the child ends.
	f := []unix.SockFilter{{Code: load, K: 4}, {Code: jeq, Jt: 1, K: heifAuditArch}, {Code: ret, K: unix.SECCOMP_RET_KILL_PROCESS}, {Code: load, K: 0}}
	refuse := len(f) + 1 + len(deny) + 1 // where "refused" is, below
	f = append(f, unix.SockFilter{Code: jge, Jt: uint8(refuse - len(f) - 1), K: x32})
	for _, nr := range deny {
		f = append(f, unix.SockFilter{Code: jeq, Jt: uint8(refuse - len(f) - 1), K: uint32(nr)})
	}
	f = append(f, unix.SockFilter{Code: ret, K: unix.SECCOMP_RET_ALLOW}, unix.SockFilter{Code: ret, K: unix.SECCOMP_RET_ERRNO | epERM})
	if len(f) != refuse+1 {
		return errors.New("the filter is miscounted")
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	prog := unix.SockFprog{Len: uint16(len(f)), Filter: &f[0]}
	// TSYNC: every thread the child has, not only this one.
	r, _, errno := unix.Syscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, uintptr(unsafe.Pointer(&prog)))
	if errno != 0 {
		return errno
	}
	if r != 0 {
		return errors.New("a thread couldn't be put in the sandbox")
	}
	return nil
}
