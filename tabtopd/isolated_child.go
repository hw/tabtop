package main

// Shared mechanics for preview children. Callers retain their own input,
// timeout/output limits, child arguments and interpretation of child errors.
import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

type isolatedChild struct {
	Args        []string
	Input       io.Reader
	ExtraFiles  []*os.File
	Timeout     time.Duration
	OutputLimit int
}
type childResult struct {
	Output             []byte
	Err                error
	TimedOut, Overflow bool
	ExitCode           int
}

func runIsolatedChild(spec isolatedChild) childResult {
	exe, err := os.Executable()
	if err != nil {
		return childResult{Err: err, ExitCode: -1}
	}
	ctx, cancel := context.WithTimeout(context.Background(), spec.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, spec.Args...)
	cmd.Stdin = spec.Input
	cmd.ExtraFiles = spec.ExtraFiles
	out := &cappedBuffer{max: spec.OutputLimit}
	cmd.Stdout = out
	cmd.Env = []string{"GOMAXPROCS=1", "GOMEMLIMIT=512MiB"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	err = cmd.Run()
	exitCode := 0
	if err != nil {
		exitCode = -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			exitCode = exit.ExitCode()
		}
	}
	return childResult{Output: out.buffer.Bytes(), Err: err, TimedOut: ctx.Err() != nil, Overflow: out.over, ExitCode: exitCode}
}

var errChildOutputLimit = errors.New("child output limit exceeded")

type cappedBuffer struct {
	// Do not embed Buffer: its promoted ReadFrom lets io.Copy bypass Write.
	buffer bytes.Buffer
	max    int
	over   bool
}

func (out *cappedBuffer) Write(p []byte) (int, error) {
	if len(p) > out.max-out.buffer.Len() {
		out.over = true
		return 0, errChildOutputLimit
	}
	return out.buffer.Write(p)
}
