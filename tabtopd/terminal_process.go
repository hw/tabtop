package main

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// terminalProcess owns the PTY, child reaping and bounded shutdown. It knows
// nothing about tunnels; Close unblocks PTY I/O and is safe to call twice.
type terminalProcess struct {
	cmd          *exec.Cmd
	pty          *os.File
	exited       chan struct{}
	waitErr      error // published by closing exited
	closeOnce    sync.Once
	closeErr     error
	writeTimeout time.Duration
	exitTimeout  time.Duration
}

func startTerminal(command string) (*terminalProcess, error) {
	cmd := ttyCommand(command)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	return startTerminalProcess(cmd)
}

func startTerminalProcess(cmd *exec.Cmd) (*terminalProcess, error) {
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		return nil, err
	}
	// A nonblocking duplicate lets Go's poller enforce deadlines and interrupt
	// reads when Close runs; duplication is atomically close-on-exec.
	fd, err := unix.FcntlInt(ptmx.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err == nil {
		err = unix.SetNonblock(fd, true)
	}
	if err != nil {
		if fd >= 0 {
			unix.Close(fd)
		}
		ptmx.Close()
		cmd.Process.Kill()
		cmd.Wait()
		return nil, err
	}
	ptmx.Close()
	p := &terminalProcess{cmd: cmd, pty: os.NewFile(uintptr(fd), "terminal"), exited: make(chan struct{}), writeTimeout: 5 * time.Second, exitTimeout: 2 * time.Second}
	go func() { p.waitErr = cmd.Wait(); close(p.exited) }()
	return p, nil
}

func (p *terminalProcess) Read(b []byte) (int, error) { return p.pty.Read(b) }
func (p *terminalProcess) Write(b []byte) (int, error) {
	if err := p.pty.SetWriteDeadline(time.Now().Add(p.writeTimeout)); err != nil {
		return 0, err
	}
	return p.pty.Write(b)
}
func (p *terminalProcess) Resize(cols, rows int) error {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return errors.New("invalid terminal size")
	}
	raw, err := p.pty.SyscallConn()
	if err != nil {
		return err
	}
	var resizeErr error
	err = raw.Control(func(fd uintptr) {
		resizeErr = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
	})
	if err != nil {
		return err
	}
	return resizeErr
}
func (p *terminalProcess) Wait() error { <-p.exited; return p.waitErr }
func (p *terminalProcess) Close() error {
	p.closeOnce.Do(func() {
		p.closeErr = p.pty.Close()
		timer := time.NewTimer(p.exitTimeout)
		defer timer.Stop()
		select {
		case <-p.exited:
		case <-timer.C:
			p.cmd.Process.Kill()
			<-p.exited
		}
	})
	return p.closeErr
}
