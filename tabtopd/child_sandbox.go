//go:build linux && (amd64 || arm64)

package main

// The preview children's sandbox (see children.go): once a child has
// opened what it needs (libheif its plugins, SQLite its database), a
// seccomp filter, on every thread of the child, refuses what reading a
// file given on stdin and answering on stdout has no need of: opening
// files, sockets, running programs, making processes (threads, yes),
// reaching other processes (signals, their limits, their memory),
// changing files. A child a crafted file took over can then read and
// write only what it was given (its stdin, stdout, and descriptors
// passed it), and touch no process but its own.
import (
	"errors"
	"os"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// childDenied are the system calls refused, as well as childLegacyDenied
// (the architecture's older forms of them): opening files (and io_uring,
// which can without openat), sockets, running programs, reaching other
// processes (ptrace, their memory, their file descriptors, signals),
// changing files or their metadata, namespaces and mounts, and the
// kernel's own (modules, BPF, keys). (A list of those refused, not of
// those allowed: what the Go runtime, glibc, libheif's plugins and SQLite call
// varies, and a call missed from an allowlist would stop decoding.)
var childDenied = []uintptr{
	unix.SYS_OPENAT, unix.SYS_OPENAT2, unix.SYS_OPEN_BY_HANDLE_AT, unix.SYS_NAME_TO_HANDLE_AT,
	unix.SYS_IO_URING_SETUP, unix.SYS_IO_URING_ENTER, unix.SYS_IO_URING_REGISTER,
	unix.SYS_SOCKET, unix.SYS_SOCKETPAIR, unix.SYS_CONNECT, unix.SYS_BIND, unix.SYS_LISTEN, unix.SYS_ACCEPT4,
	unix.SYS_EXECVE, unix.SYS_EXECVEAT, unix.SYS_PTRACE, unix.SYS_PROCESS_VM_READV, unix.SYS_PROCESS_VM_WRITEV,
	unix.SYS_PIDFD_OPEN, unix.SYS_PIDFD_GETFD, unix.SYS_PIDFD_SEND_SIGNAL, unix.SYS_KILL,
	unix.SYS_UNLINKAT, unix.SYS_RENAMEAT, unix.SYS_RENAMEAT2, unix.SYS_MKDIRAT, unix.SYS_MKNODAT, unix.SYS_SYMLINKAT,
	unix.SYS_LINKAT, unix.SYS_FCHMODAT, unix.SYS_FCHOWNAT, unix.SYS_FCHMOD, unix.SYS_FCHOWN, unix.SYS_TRUNCATE, unix.SYS_FTRUNCATE,
	unix.SYS_UTIMENSAT, unix.SYS_SETXATTR, unix.SYS_LSETXATTR, unix.SYS_FSETXATTR, unix.SYS_REMOVEXATTR, unix.SYS_LREMOVEXATTR, unix.SYS_FREMOVEXATTR,
	unix.SYS_UNSHARE, unix.SYS_SETNS, unix.SYS_MOUNT, unix.SYS_UMOUNT2, unix.SYS_PIVOT_ROOT, unix.SYS_CHROOT,
	unix.SYS_OPEN_TREE, unix.SYS_MOVE_MOUNT, unix.SYS_FSOPEN, unix.SYS_FSCONFIG, unix.SYS_FSMOUNT, unix.SYS_FSPICK,
	unix.SYS_KEXEC_LOAD, unix.SYS_INIT_MODULE, unix.SYS_FINIT_MODULE, unix.SYS_DELETE_MODULE, unix.SYS_BPF, unix.SYS_PERF_EVENT_OPEN,
	unix.SYS_USERFAULTFD, unix.SYS_KEYCTL, unix.SYS_ADD_KEY, unix.SYS_REQUEST_KEY, unix.SYS_MEMFD_CREATE,
	unix.SYS_FCHMODAT2, unix.SYS_TKILL, unix.SYS_RT_SIGQUEUEINFO, unix.SYS_RT_TGSIGQUEUEINFO,
	unix.SYS_SETPRIORITY, unix.SYS_SCHED_SETAFFINITY, unix.SYS_SCHED_SETSCHEDULER, unix.SYS_SCHED_SETATTR, unix.SYS_SCHED_SETPARAM,
	unix.SYS_IOPRIO_SET, unix.SYS_MIGRATE_PAGES, unix.SYS_MOVE_PAGES, unix.SYS_KCMP, unix.SYS_PROCESS_MADVISE,
	// What's shared with other processes (SysV's and POSIX's), its own
	// group or session left (outliving the server), locks, and ioctl (a
	// signal owner set, for one).
	unix.SYS_SHMGET, unix.SYS_SHMAT, unix.SYS_SHMDT, unix.SYS_SHMCTL, unix.SYS_MSGGET, unix.SYS_MSGSND, unix.SYS_MSGRCV, unix.SYS_MSGCTL,
	unix.SYS_SEMGET, unix.SYS_SEMOP, unix.SYS_SEMTIMEDOP, unix.SYS_SEMCTL,
	unix.SYS_MQ_OPEN, unix.SYS_MQ_UNLINK, unix.SYS_MQ_TIMEDSEND, unix.SYS_MQ_TIMEDRECEIVE, unix.SYS_MQ_NOTIFY, unix.SYS_MQ_GETSETATTR,
	unix.SYS_SETPGID, unix.SYS_SETSID, unix.SYS_FLOCK, unix.SYS_IOCTL,
}

// childNewest is the first call number past those childDenied was written
// for (kernel 6.12's): newer calls are "not implemented", as on an older
// kernel, since what they do isn't known here.
const childNewest = 463

// childFcntlDenied are fcntl's commands refused: those that have the kernel
// signal another process (the server) as a descriptor's ready, or changed.
var childFcntlDenied = []uint32{unix.F_SETOWN, unix.F_SETSIG, unix.F_SETOWN_EX, unix.F_SETLEASE, unix.F_NOTIFY}

// childSandbox puts the child in its sandbox, or says why it couldn't (a
// kernel, or container, that doesn't allow it; see startPreviewChild).
func childSandbox() error {
	// (Both steps on the one thread: no_new_privs is a thread's own.)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	f, err := childFilter(uint32(os.Getpid()))
	if err != nil {
		return err
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

// childFilter is the sandbox's program, for the process pid (the child).
// Besides the calls refused outright (childDenied), some are looked into:
//   - tgkill (which Go's runtime signals its own threads with), and
//     prlimit64, only of the child itself (or, prlimit64, 0: itself);
//   - clone, only to make a thread (CLONE_THREAD): no new processes;
//   - clone3, "not implemented" (glibc then makes its threads with clone);
//   - fcntl, but not its commands that signal (childFcntlDenied);
//   - prctl, but not to clear (or set) its parent-death signal;
//   - those newer than childDenied knows of, "not implemented".
func childFilter(pid uint32) ([]unix.SockFilter, error) {
	const (
		load = 0x20 // BPF_LD | BPF_W | BPF_ABS
		jeq  = 0x15 // BPF_JMP | BPF_JEQ | BPF_K
		jge  = 0x35 // BPF_JMP | BPF_JGE | BPF_K
		jset = 0x45 // BPF_JMP | BPF_JSET | BPF_K
		ret  = 0x06 // BPF_RET | BPF_K
		x32  = 0x40000000
		// Where a call's number, its architecture, and its first argument's
		// low and high halves are, in what the filter's given (seccomp_data;
		// both architectures little-endian).
		nr, arch, arg0, arg0High, arg1 = 0, 4, 16, 20, 24
	)
	// A program with jumps to labels, resolved once it's all written (jumps
	// go forward, at most 255 instructions).
	type step struct {
		code   uint16
		k      uint32
		jt, jf string
	}
	var prog []step
	labels := map[string]int{}
	add := func(code uint16, k uint32, jt, jf string) { prog = append(prog, step{code, k, jt, jf}) }
	label := func(name string) { labels[name] = len(prog) }

	add(load, arch, "", "")
	add(jeq, childAuditArch, "", "kill") // another architecture's calls (as x86-64's 32-bit ones): the child ends
	add(load, nr, "", "")
	add(jge, x32, "refuse", "")
	add(jge, childNewest, "unimplemented", "")
	add(jeq, uint32(unix.SYS_FCNTL), "fcntl", "")
	add(jeq, uint32(unix.SYS_PRCTL), "prctl", "")
	add(jeq, uint32(unix.SYS_TGKILL), "self", "")
	add(jeq, uint32(unix.SYS_PRLIMIT64), "self-or-0", "")
	add(jeq, uint32(unix.SYS_CLONE), "thread", "")
	add(jeq, uint32(unix.SYS_CLONE3), "unimplemented", "")
	for _, call := range append(append([]uintptr{}, childDenied...), childLegacyDenied...) {
		add(jeq, uint32(call), "refuse", "")
	}
	add(ret, unix.SECCOMP_RET_ALLOW, "", "") // any other call
	label("self")                            // its first argument the child's pid
	add(load, arg0High, "", "")
	add(jeq, 0, "", "refuse")
	add(load, arg0, "", "")
	add(jeq, pid, "allow", "refuse")
	label("self-or-0")
	add(load, arg0High, "", "")
	add(jeq, 0, "", "refuse")
	add(load, arg0, "", "")
	add(jeq, 0, "allow", "")
	add(jeq, pid, "allow", "refuse")
	label("thread") // clone's flags (its first argument, on both) with CLONE_THREAD
	add(load, arg0, "", "")
	add(jset, unix.CLONE_THREAD, "allow", "refuse")
	label("fcntl") // its command (the second argument; an int: its low half)
	add(load, arg1, "", "")
	for _, c := range childFcntlDenied {
		add(jeq, c, "refuse", "")
	}
	add(ret, unix.SECCOMP_RET_ALLOW, "", "")
	label("prctl") // its option (the first argument)
	add(load, arg0, "", "")
	add(jeq, unix.PR_SET_PDEATHSIG, "refuse", "allow")
	// What they come to, last (jumps only go forward).
	label("allow")
	add(ret, unix.SECCOMP_RET_ALLOW, "", "")
	label("refuse")
	add(ret, unix.SECCOMP_RET_ERRNO|uint32(syscall.EPERM), "", "")
	label("unimplemented")
	add(ret, unix.SECCOMP_RET_ERRNO|uint32(syscall.ENOSYS), "", "")
	label("kill")
	add(ret, unix.SECCOMP_RET_KILL_PROCESS, "", "")

	f := make([]unix.SockFilter, len(prog))
	for i, s := range prog {
		f[i] = unix.SockFilter{Code: s.code, K: s.k}
		for _, j := range []struct {
			name string
			to   *uint8
		}{{s.jt, &f[i].Jt}, {s.jf, &f[i].Jf}} {
			if j.name == "" {
				continue // the next instruction
			}
			at, ok := labels[j.name]
			if !ok || at <= i || at-i-1 > 255 {
				return nil, errors.New("the sandbox's filter doesn't hold together")
			}
			*j.to = uint8(at - i - 1)
		}
	}
	return f, nil
}
