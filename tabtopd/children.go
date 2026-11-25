package main

// The server's children: the server run again with an argument naming
// what it's to do, apart from it. The preview children (Markdown, books,
// SQLite, HEIC pictures) read a file they're given, which may have been
// made to take over what reads it: each runs with limits on its memory and
// processor time, and, once it's opened what it needs, in the sandbox
// (child_sandbox.go), where it can't open files (the users file among
// them), reach the network, run programs or touch other processes.
import (
	"fmt"
	"net"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// sandboxCheckArg runs a child that's put in the sandbox as the preview
// children are and says what it can do there (see sandboxReport; for its
// test).
const sandboxCheckArg = "--sandbox-check"

// children are the children, by the argument that names each.
var children = map[string]func(args []string) int{
	markdownChildArg: renderMarkdownChild,
	epubChildArg:     renderEpubChild,
	sqliteChildArg:   readSQLiteChild,
	heifChildArg:     readHEIFChild,
	goBridgeArg:      runGoBridge,
	sandboxCheckArg: func([]string) int {
		fmt.Print(sandboxReport(startPreviewChild(previewChildMemory, previewChildCPU)))
		return 0
	},
}

// runChild runs the child os.Args names, if it names one, and exits with
// what it returns.
func runChild() {
	if len(os.Args) < 2 {
		return
	}
	if run, ok := children[os.Args[1]]; ok {
		os.Exit(run(os.Args[2:]))
	}
}

// The limits on a preview child (but HEIC's, whose decoder needs more):
// its memory, C's too (RLIMIT_DATA), and processor seconds. Each child is
// also killed after its own time (see runIsolatedChild), and its Go heap
// kept to 512 MiB, as far as Go can (GOMEMLIMIT).
const (
	previewChildMemory = 2 << 30
	previewChildCPU    = 300
)

// childLimits limits the child to memory bytes and cpu seconds.
func childLimits(memory, cpu uint64) {
	syscall.Setrlimit(syscall.RLIMIT_DATA, &syscall.Rlimit{Cur: memory, Max: memory})
	syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: cpu, Max: cpu})
}

// startPreviewChild limits the child, then puts it in the sandbox, or
// says why it couldn't be (on a system, or in a container, that doesn't
// allow it). Markdown, books and SQLite are read even then, as they were
// before there was a sandbox; HEIC pictures aren't (see readHEIFChild).
// SQLite's opens its database first (see readSQLiteChild).
func startPreviewChild(memory, cpu uint64) error {
	childLimits(memory, cpu)
	return childSandbox()
}

// sandboxReport says what the child can do now: sandboxed, the error
// from putting it in the sandbox (nil: it's in it). Opening a file, the
// network, the parent's limits, signalling it, making a process, having
// a descriptor signal the parent, shared memory, a group of its own, and
// clearing its parent-death signal should be refused; a call newer than
// the sandbox knows (childNewest's), "not implemented"; its own limits,
// its output's flags and threads, as before.
func sandboxReport(sandboxed error) string {
	_, open := os.Open("/etc/hostname")
	_, dial := net.Dial("tcp", "127.0.0.1:9")
	parent := os.Getppid()
	var limit syscall.Rlimit
	_, _, prlimit := syscall.RawSyscall6(syscall.SYS_PRLIMIT64, uintptr(parent), syscall.RLIMIT_NOFILE, 0, uintptr(unsafe.Pointer(&limit)), 0, 0)
	_, _, signal := syscall.RawSyscall(syscall.SYS_TGKILL, uintptr(parent), uintptr(parent), 0)
	_, _, fork := syscall.RawSyscall6(syscall.SYS_CLONE, uintptr(syscall.SIGCHLD), 0, 0, 0, 0, 0)
	if fork == 0 {
		os.Exit(0) // (a process made after all: it goes)
	}
	_, _, own := syscall.RawSyscall6(syscall.SYS_PRLIMIT64, 0, syscall.RLIMIT_NOFILE, 0, uintptr(unsafe.Pointer(&limit)), 0, 0)
	_, _, owner := syscall.RawSyscall(syscall.SYS_FCNTL, 1, syscall.F_SETOWN, uintptr(parent))
	_, _, shared := syscall.RawSyscall(unix.SYS_SHMGET, 0 /* IPC_PRIVATE */, 4096, 0o1600 /* IPC_CREAT | 0600 */)
	_, _, group := syscall.RawSyscall(syscall.SYS_SETPGID, 0, 0, 0)
	_, _, orphan := syscall.RawSyscall(syscall.SYS_PRCTL, unix.PR_SET_PDEATHSIG, 0, 0)
	_, _, newer := syscall.RawSyscall(463, 0, 0, 0)
	_, _, flags := syscall.RawSyscall(syscall.SYS_FCNTL, 1, syscall.F_GETFL, 0)
	threads := make(chan int)
	go func() { threads <- 1 }()
	<-threads
	return fmt.Sprintf("sandbox: %v; open: %v; dial: %v; parent's limits: %v; signal parent: %v; fork: %v; signal owner: %v; shared memory: %v; "+
		"own group: %v; parent-death signal: %v; newer call: %v; own limits: %v; its flags: %v", sandboxed, open, dial,
		prlimit, signal, fork, owner, shared, group, orphan, newer, own, flags)
}
