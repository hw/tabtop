//go:build linux && (amd64 || arm64)

package main

// The seccomp filter the remote browser's engine runs under in its sandbox
// (goSandboxArgs, bwrap's --seccomp): a list of system calls refused, as
// Flatpak's, for what an engine has no use for and kernel exploits do. The
// sandbox's namespaces and dropped capabilities confine what the engine
// reaches; this narrows the kernel it can talk to. It's built here, as
// classic BPF, for the architecture tabtopd is built for
// (goseccomp_<arch>.go); elsewhere there's none, and the sandbox runs
// without one.
//
// Refused, with EPERM: kernel keyrings, BPF, userfaultfd, io_uring, perf,
// tracing other processes, new namespaces and mounts (and clone with a
// namespace's flag), modules, kexec, the clocks, swap, accounting, and
// the terminal ioctls that type into or read another console (TIOCSTI,
// TIOCLINUX). clone3 is refused with ENOSYS, as its flags can't be read
// from a filter, so that the C library falls back to clone. Sockets are
// only Unix, IPv4, IPv6 and routing netlink ones (EAFNOSUPPORT otherwise).
// A system call of another architecture (x86's 32-bit ones on x86-64)
// kills the process.

import (
	"bytes"
	"encoding/binary"
	"os"

	"golang.org/x/sys/unix"
)

// Classic BPF, as seccomp takes it (linux/filter.h, linux/seccomp.h).
const (
	bpfLdAbsW = 0x20 // BPF_LD | BPF_W | BPF_ABS
	bpfJeqK   = 0x15 // BPF_JMP | BPF_JEQ | BPF_K
	bpfJsetK  = 0x45 // BPF_JMP | BPF_JSET | BPF_K
	bpfRetK   = 0x06 // BPF_RET | BPF_K

	seccompKillProcess = 0x80000000
	seccompErrno       = 0x00050000
	seccompAllow       = 0x7fff0000

	// struct seccomp_data: the call's number, its architecture, then its
	// arguments, 64 bits each; the low half of each is first here (these
	// architectures are little-endian).
	seccompNr   = 0
	seccompArch = 4
)

func seccompArg(i int) uint32 { return 16 + uint32(i)*8 }

type bpfInsn struct {
	Code   uint16
	Jt, Jf uint8
	K      uint32
}

// goNamespaceFlags are clone's flags that make namespaces.
const goNamespaceFlags = unix.CLONE_NEWNS | unix.CLONE_NEWCGROUP | unix.CLONE_NEWUTS | unix.CLONE_NEWIPC |
	unix.CLONE_NEWUSER | unix.CLONE_NEWPID | unix.CLONE_NEWNET

// goSeccompDenied are the calls refused on every architecture that has
// them; goSeccompArchDenied (goseccomp_<arch>.go) adds its own.
var goSeccompDenied = []uintptr{
	unix.SYS_ADD_KEY, unix.SYS_KEYCTL, unix.SYS_REQUEST_KEY,
	unix.SYS_BPF, unix.SYS_USERFAULTFD, unix.SYS_PERF_EVENT_OPEN,
	unix.SYS_IO_URING_SETUP, unix.SYS_IO_URING_ENTER, unix.SYS_IO_URING_REGISTER,
	unix.SYS_PTRACE, unix.SYS_PROCESS_VM_READV, unix.SYS_PROCESS_VM_WRITEV, unix.SYS_KCMP,
	unix.SYS_UNSHARE, unix.SYS_SETNS, unix.SYS_MOUNT, unix.SYS_UMOUNT2, unix.SYS_PIVOT_ROOT, unix.SYS_CHROOT,
	unix.SYS_FSOPEN, unix.SYS_FSCONFIG, unix.SYS_FSMOUNT, unix.SYS_FSPICK, unix.SYS_OPEN_TREE,
	unix.SYS_MOVE_MOUNT, unix.SYS_MOUNT_SETATTR,
	unix.SYS_OPEN_BY_HANDLE_AT, unix.SYS_NAME_TO_HANDLE_AT,
	unix.SYS_INIT_MODULE, unix.SYS_FINIT_MODULE, unix.SYS_DELETE_MODULE,
	unix.SYS_KEXEC_LOAD, unix.SYS_KEXEC_FILE_LOAD, unix.SYS_REBOOT,
	unix.SYS_SWAPON, unix.SYS_SWAPOFF, unix.SYS_ACCT, unix.SYS_QUOTACTL,
	unix.SYS_SETTIMEOFDAY, unix.SYS_CLOCK_SETTIME, unix.SYS_ADJTIMEX, unix.SYS_CLOCK_ADJTIME,
	unix.SYS_SYSLOG, unix.SYS_VHANGUP, unix.SYS_MOVE_PAGES, unix.SYS_MIGRATE_PAGES,
	unix.SYS_LOOKUP_DCOOKIE,
}

// goSeccompProgram is the filter, as bwrap's --seccomp reads it: an array
// of struct sock_filter. nil where there's none for this architecture.
func goSeccompProgram() []byte {
	if goSeccompAuditArch == 0 {
		return nil
	}
	errno := func(e unix.Errno) bpfInsn { return bpfInsn{Code: bpfRetK, K: seccompErrno | uint32(e)} }
	allow := bpfInsn{Code: bpfRetK, K: seccompAllow}
	ld := func(off uint32) bpfInsn { return bpfInsn{Code: bpfLdAbsW, K: off} }
	// is goes on to the next instruction if the loaded value is k, and
	// jumps over skip instructions if it isn't.
	is := func(k uint32, skip uint8) bpfInsn { return bpfInsn{Code: bpfJeqK, Jf: skip, K: k} }

	p := []bpfInsn{
		ld(seccompArch),
		{Code: bpfJeqK, Jt: 1, K: goSeccompAuditArch}, // this architecture's: on
		{Code: bpfRetK, K: seccompKillProcess},
		ld(seccompNr),
	}
	if goSeccompX32 != 0 {
		p = append(p, bpfInsn{Code: bpfJsetK, Jf: 1, K: goSeccompX32}, bpfInsn{Code: bpfRetK, K: seccompKillProcess})
	}
	for _, nr := range append(goSeccompDenied, goSeccompArchDenied...) {
		p = append(p, is(uint32(nr), 1), errno(unix.EPERM))
	}
	p = append(p, is(unix.SYS_CLONE3, 1), errno(unix.ENOSYS))
	// clone with a namespace's flag (its flags are its first argument on
	// these architectures).
	p = append(p,
		is(unix.SYS_CLONE, 4),
		ld(seccompArg(0)),
		bpfInsn{Code: bpfJsetK, Jf: 1, K: goNamespaceFlags},
		errno(unix.EPERM),
		allow,
	)
	// ioctl(fd, TIOCSTI or TIOCLINUX).
	p = append(p,
		is(unix.SYS_IOCTL, 5),
		ld(seccompArg(1)),
		bpfInsn{Code: bpfJeqK, Jt: 1, K: unix.TIOCSTI},
		is(unix.TIOCLINUX, 1),
		errno(unix.EPERM),
		allow,
	)
	// socket(family, type, protocol): Unix, IPv4, IPv6, routing netlink.
	p = append(p,
		is(unix.SYS_SOCKET, 9),
		ld(seccompArg(0)),
		bpfInsn{Code: bpfJeqK, Jt: 5, K: unix.AF_UNIX},
		bpfInsn{Code: bpfJeqK, Jt: 4, K: unix.AF_INET},
		bpfInsn{Code: bpfJeqK, Jt: 3, K: unix.AF_INET6},
		is(unix.AF_NETLINK, 3),
		ld(seccompArg(2)),
		is(unix.NETLINK_ROUTE, 1),
		allow,
		errno(unix.EAFNOSUPPORT),
	)
	// Everything else.
	p = append(p, allow)
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, p)
	return b.Bytes()
}

// goSeccompFile is the filter on a pipe, to hand bwrap as a file
// descriptor; nil where there's none.
func goSeccompFile() (*os.File, error) {
	prog := goSeccompProgram()
	if prog == nil {
		return nil, nil
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	// It's well under a pipe's buffer, so this doesn't wait for a reader.
	_, err = w.Write(prog)
	w.Close()
	if err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}
