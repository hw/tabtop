package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func readyTerminal(t *testing.T, command string) *terminalProcess {
	t.Helper()
	p, err := startTerminalProcess(exec.Command("sh", "-c", command))
	if err != nil {
		t.Fatal(err)
	}
	p.exitTimeout = 20 * time.Millisecond
	t.Cleanup(func() { p.Close() })
	p.pty.SetReadDeadline(time.Now().Add(2 * time.Second))
	ready := make([]byte, 5)
	if _, err := io.ReadFull(p, ready); err != nil || string(ready) != "ready" {
		t.Fatalf("readiness %q: %v", ready, err)
	}
	p.pty.SetReadDeadline(time.Time{})
	return p
}

func TestTerminalProcessIOAndResize(t *testing.T) {
	p := readyTerminal(t, "stty -echo; printf ready; read line; stty size; printf 'got:%s' \"$line\"")
	if err := p.Resize(100, 40); err != nil {
		t.Fatal(err)
	}
	if err := p.Resize(0, 40); err == nil {
		t.Fatal("invalid size accepted")
	}
	if _, err := p.Write([]byte("hello\n")); err != nil {
		t.Fatal(err)
	}
	p.pty.SetReadDeadline(time.Now().Add(2 * time.Second))
	data, _ := io.ReadAll(p) // Linux PTYs report EIO when their slave closes.
	if !strings.Contains(string(data), "40 100") || !strings.Contains(string(data), "got:hello") {
		t.Fatalf("terminal output %q", data)
	}
	if err := p.Wait(); err != nil {
		t.Fatal(err)
	}
}

const unreadTerminal = "trap '' HUP; stty -echo -icanon; printf ready; while :; do :; done"

func TestTerminalProcessCloseUnblocksIOAndReaps(t *testing.T) {
	p := readyTerminal(t, unreadTerminal)
	p.writeTimeout = time.Second
	readDone := make(chan error, 1)
	writeDone := make(chan error, 1)
	go func() { _, err := p.Read(make([]byte, 1)); readDone <- err }()
	go func() { _, err := p.Write(make([]byte, 1<<20)); writeDone <- err }()
	select {
	case err := <-writeDone:
		t.Fatalf("expected blocked input, got %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	before := time.Now()
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if time.Since(before) > time.Second {
		t.Fatal("close exceeded shutdown budget")
	}
	if err := p.Close(); err != nil {
		t.Fatal("second close:", err)
	}
	for _, done := range []<-chan error{readDone, writeDone} {
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("closed I/O returned no error")
			}
		case <-time.After(time.Second):
			t.Fatal("close did not unblock I/O")
		}
	}
	select {
	case <-p.exited:
	default:
		t.Fatal("child was not reaped")
	}
}

func TestTerminalProcessWriteDeadline(t *testing.T) {
	p := readyTerminal(t, unreadTerminal)
	p.writeTimeout = 20 * time.Millisecond
	if _, err := p.Write(make([]byte, 1<<20)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("blocked write: %v", err)
	}
}

func TestTerminalProcessNaturalExit(t *testing.T) {
	p, err := startTerminalProcess(exec.Command("sh", "-c", "exit 7"))
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	select {
	case <-p.exited:
	case <-time.After(2 * time.Second):
		t.Fatal("exit was not reaped")
	}
	var exit *exec.ExitError
	if err := p.Wait(); !errors.As(err, &exit) || exit.ExitCode() != 7 {
		t.Fatalf("exit result: %v", err)
	}
}
