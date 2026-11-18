//go:build linux && (amd64 || arm64)

package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestGoSeccompFilter runs programs in a sandbox with the engine's filter:
// what's allowed works, what's refused is.
func TestGoSeccompFilter(t *testing.T) {
	bwrap, _ := exec.LookPath("bwrap")
	if probeBwrap(bwrap) != nil {
		t.Skip("bubblewrap can't make its sandbox here")
	}
	run := func(argv ...string) (string, error) {
		filter, err := goSeccompFile()
		if err != nil {
			t.Fatal(err)
		}
		defer filter.Close()
		args := append(goSandboxSystem(), "--unshare-all", "--cap-drop", "ALL", "--die-with-parent", "--dev", "/dev",
			"--tmpfs", "/tmp", "--seccomp", "3")
		cmd := exec.Command(bwrap, append(args, argv...)...)
		cmd.ExtraFiles = []*os.File{filter}
		out, err := cmd.CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
	if out, err := run("sh", "-c", "echo ok"); err != nil || out != "ok" {
		t.Fatalf("a shell under the filter: %v %q", err, out)
	}
	if out, err := run("unshare", "-U", "true"); err == nil {
		t.Errorf("unshare -U worked under the filter: %q", out)
	}
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3, for the socket checks")
	}
	script := `import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.close()
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.close()
s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0); s.close()
for fam, typ, proto in ((38, 5, 0), (40, 1, 0), (socket.AF_NETLINK, socket.SOCK_RAW, 12)):  # AF_ALG, AF_VSOCK, netfilter
    try:
        socket.socket(fam, typ, proto)
        print("allowed", fam, proto); sys.exit(1)
    except OSError as e:
        if e.errno != 97: print("errno", e.errno, fam, proto); sys.exit(1)
print("ok")`
	if out, err := run(py, "-I", "-c", script); err != nil || out != "ok" {
		t.Errorf("sockets under the filter: %v %q", err, out)
	}
}
