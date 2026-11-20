package main

// The remote browser engine's bridges (see goengine.go). In its sandbox the
// engine has a network of its own, with only loopback: tabtopd, run inside
// as -go-bridge, joins that to the two sockets bound in from outside. The
// engine's CDP port is reached from tabtopd's socket, and the engine's
// proxy port reaches the egress proxy's (goproxy.go). Then it runs the
// engine, and ends with it.
import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

const goBridgeArg = "-go-bridge"

// goBridgeNetwork is "unix" for an address that's a path, else "tcp".
func goBridgeNetwork(addr string) string {
	if strings.HasPrefix(addr, "/") {
		return "unix"
	}
	return "tcp"
}

// goBridgeForward forwards each connection to from on to to, until l is
// closed.
func goBridgeForward(l net.Listener, to string) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			u, err := net.Dial(goBridgeNetwork(to), to)
			if err != nil {
				return
			}
			defer u.Close()
			done := make(chan struct{})
			go func() { io.Copy(u, c); closeWrite(u); close(done) }()
			io.Copy(c, u)
			closeWrite(c)
			<-done
		}()
	}
}

// runGoBridge is tabtopd as -go-bridge [-data=BYTES] FROM=TO... -- ENGINE
// ARGS...: it listens on each FROM (or accepts on fd:N, a socket it was
// handed), forwarding to its TO, and runs the engine, exiting as it does.
// With -data, the engine's data segment (RLIMIT_DATA, which V8 tolerates
// where it doesn't RLIMIT_AS) is limited to BYTES: a page that takes all
// the memory it can is stopped there, not when the watchdog next looks.
func runGoBridge(args []string) int {
	var data uint64
	i := 0
	for ; i < len(args) && args[i] != "--"; i++ {
		if v, ok := strings.CutPrefix(args[i], "-data="); ok {
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil || n == 0 {
				fmt.Fprintf(os.Stderr, "go-bridge: bad %q\n", args[i])
				return 2
			}
			data = n
			continue
		}
		from, to, ok := strings.Cut(args[i], "=")
		if !ok || from == "" || to == "" {
			fmt.Fprintf(os.Stderr, "go-bridge: %q isn't FROM=TO\n", args[i])
			return 2
		}
		var l net.Listener
		var err error
		if fd, ok := strings.CutPrefix(from, "fd:"); ok {
			n, convErr := strconv.Atoi(fd)
			if convErr != nil || n < 3 {
				fmt.Fprintf(os.Stderr, "go-bridge: %q isn't a socket handed over\n", from)
				return 2
			}
			f := os.NewFile(uintptr(n), from)
			l, err = net.FileListener(f)
			f.Close()
		} else {
			if goBridgeNetwork(from) == "unix" {
				os.Remove(from)
			}
			l, err = net.Listen(goBridgeNetwork(from), from)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "go-bridge: %v\n", err)
			return 1
		}
		go goBridgeForward(l, to)
	}
	if i+1 >= len(args) {
		fmt.Fprintln(os.Stderr, "go-bridge: no engine to run")
		return 2
	}
	if data != 0 {
		// Inherited by the engine; the bridge itself needs far less.
		if err := syscall.Setrlimit(syscall.RLIMIT_DATA, &syscall.Rlimit{Cur: data, Max: data}); err != nil {
			fmt.Fprintf(os.Stderr, "go-bridge: %v\n", err)
			return 1
		}
	}
	cmd := exec.Command(args[i+1], args[i+2:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			// Said if it was a signal (an engine that ends so may say
			// nothing itself: V8's fatal errors are a trap, SIGTRAP).
			if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				fmt.Fprintf(os.Stderr, "go-bridge: the engine ended by %v\n", status.Signal())
			}
			return exit.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "go-bridge: %v\n", err)
		return 1
	}
	return 0
}
