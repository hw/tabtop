package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// search runs searchFile to the end, carrying on as the page does.
func search(t *testing.T, data []byte, pattern, mask string, from int64, backward bool, stretch int64) int64 {
	t.Helper()
	value, m, err := searchPattern(pattern, mask)
	if err != nil {
		t.Fatal(err)
	}
	for steps := 0; ; steps++ {
		found, next, err := searchFile(context.Background(), bytes.NewReader(data), int64(len(data)), value, m, from, backward, stretch, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if found >= 0 || next < 0 {
			return found
		}
		if steps > 1000 {
			t.Fatal("the search didn't end")
		}
		from = next
	}
}

func TestSearchFile(t *testing.T) {
	data := make([]byte, 3*searchChunk+100)
	for i := range data {
		data[i] = byte(i * 7 % 251)
	}
	// Straddling the first chunk's end, and again near the end.
	at1, at2 := int64(searchChunk-2), int64(len(data)-10)
	copy(data[at1:], []byte{0xde, 0xad, 0xbe, 0xef})
	copy(data[at2:], []byte{0xde, 0xad, 0xbe, 0xef})
	all := strings.Repeat("ff", 4)
	for _, stretch := range []int64{searchStretch, 1} {
		if got := search(t, data, "deadbeef", all, 0, false, stretch); got != at1 {
			t.Errorf("forwards (stretch %d): %d, want %d", stretch, got, at1)
		}
		if got := search(t, data, "deadbeef", all, at1+1, false, stretch); got != at2 {
			t.Errorf("forwards on (stretch %d): %d, want %d", stretch, got, at2)
		}
		if got := search(t, data, "deadbeef", all, int64(len(data)), true, stretch); got != at2 {
			t.Errorf("backwards (stretch %d): %d, want %d", stretch, got, at2)
		}
		if got := search(t, data, "deadbeef", all, at2-1, true, stretch); got != at1 {
			t.Errorf("backwards on, across the chunk (stretch %d): %d, want %d", stretch, got, at1)
		}
		if got := search(t, data, "deadbeef", all, at1-1, true, stretch); got != -1 {
			t.Errorf("backwards before both: %d", got)
		}
	}
	// Wildcards: a whole byte (mask 00), and half of one (mask f0 / 0f).
	if got := search(t, data, "de00be00", "ff00ff00", 0, false, searchStretch); got != at1 {
		t.Errorf("?? bytes: %d", got)
	}
	if got := search(t, data, "d00dbeef", "f00fffff", 0, false, searchStretch); got != at1 {
		t.Errorf("nibbles: %d", got)
	}
	// No whole byte to look for first: still found.
	if got := search(t, data, "d00db0e0", "f00ff0f0", 0, false, searchStretch); got != at1 {
		t.Errorf("only nibbles: %d", got)
	}
	// Brute force agrees, for a few patterns, both ways.
	small := data[:5000]
	for _, p := range []string{"070e", "00", "fa"} {
		want := bytes.Index(small, mustHex(p))
		if got := search(t, small, p, strings.Repeat("ff", len(p)/2), 0, false, 1); int(got) != want {
			t.Errorf("%s forwards: %d, want %d", p, got, want)
		}
		want = bytes.LastIndex(small, mustHex(p))
		if got := search(t, small, p, strings.Repeat("ff", len(p)/2), int64(len(small)), true, 1); int(got) != want {
			t.Errorf("%s backwards: %d, want %d", p, got, want)
		}
	}
	for _, bad := range [][2]string{{"00", "00"}, {"", ""}, {"0", "f"}, {"00", "ffff"}, {strings.Repeat("00", maxSearchPattern+1), strings.Repeat("ff", maxSearchPattern+1)}} {
		if _, _, err := searchPattern(bad[0], bad[1]); err == nil {
			t.Errorf("%q / %q accepted", bad[0], bad[1])
		}
	}
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// TestFilePatchTunnel patches a file through the tunnel: in place (the
// same inode, the same size), only as the page read it, never past its
// end, through a link, or with runs out of order.
func TestFilePatchTunnel(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "data.bin")
	os.WriteFile(file, []byte("0123456789abcdef"), 0o640)
	st, _ := os.Stat(file)
	// (The bytes where the runs go, as the file has them now.)
	before := func(name string, runs []bytePatch) string {
		var b []byte
		if st, err := os.Stat(filepath.Join(g.downloadsDir, name)); err == nil && st.Mode().IsRegular() {
			b, _ = os.ReadFile(filepath.Join(g.downloadsDir, name))
		}
		sum := sha256.New()
		for _, r := range runs {
			if n := int64(len(r.Hex) / 2); r.Offset >= 0 && r.Offset+n <= int64(len(b)) {
				sum.Write(b[r.Offset : r.Offset+n])
			}
		}
		return hex.EncodeToString(sum.Sum(nil))
	}
	patch := func(name, version string, size int64, runs ...bytePatch) map[string]any {
		return openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "file-patch", Path: name, IfMtime: version, IfSize: size, Patches: runs, IfBytes: before(name, runs)})
	}
	run := func(at int64, h string) bytePatch { return bytePatch{Offset: at, Hex: h} }
	for name, runs := range map[string][]bytePatch{
		"past the end": {run(15, "0000")},
		"out of order": {run(4, "00"), run(2, "00")},
		"overlapping":  {run(2, "0000"), run(3, "00")},
		"negative":     {run(-1, "00")},
		"not hex":      {run(0, "zz")},
		"empty run":    {run(0, "")},
		"nothing":      nil,
	} {
		if r := patch("data.bin", fileVersion(st), st.Size(), runs...); r["error"] == nil {
			t.Errorf("%s: %v", name, r)
		}
	}
	if r := patch("data.bin", fileVersion(st), st.Size(), run(0, strings.Repeat("00", maxPatchBytes+1))); r["error"] == nil {
		t.Error("over the limit")
	}
	// Too many runs: said so, not taken for a malformed patch.
	big := filepath.Join(g.downloadsDir, "big.bin")
	os.WriteFile(big, make([]byte, 2*maxPatchRuns+2), 0o640)
	bst, _ := os.Stat(big)
	var many []bytePatch
	for i := range maxPatchRuns + 1 {
		many = append(many, run(int64(2*i), "01"))
	}
	if r := patch("big.bin", fileVersion(bst), bst.Size(), many...); !strings.Contains(fmt.Sprint(r["error"]), "separate stretches") {
		t.Errorf("too many runs: %v", r)
	}
	if r := patch("data.bin", "1-1", st.Size(), run(0, "41")); r["error"] == nil {
		t.Error("an old version")
	}
	if b, _ := os.ReadFile(file); string(b) != "0123456789abcdef" {
		t.Fatalf("changed by a refused patch: %q", b)
	}
	// Its version and size as they were, but not the bytes where the runs
	// go (changed within the same tick of the clock): refused.
	stale := []bytePatch{run(0, "41")}
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "file-patch", Path: "data.bin", IfMtime: fileVersion(st), IfSize: st.Size(), Patches: stale,
		IfBytes: hex.EncodeToString(sha256.New().Sum([]byte("x"))[:32])}); r["error"] == nil {
		t.Error("bytes not as the page saw them")
	}
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "file-patch", Path: "data.bin", IfMtime: fileVersion(st), IfSize: st.Size(), Patches: stale}); r["error"] == nil {
		t.Error("no bytes said")
	}
	if b, _ := os.ReadFile(file); string(b) != "0123456789abcdef" {
		t.Fatalf("changed by a refused patch: %q", b)
	}
	r := patch("data.bin", fileVersion(st), st.Size(), run(0, "41"), run(4, "4243"), run(15, "5a"))
	after, _ := os.Stat(file)
	if b, _ := os.ReadFile(file); string(b) != "A123BC6789abcdeZ" || !os.SameFile(st, after) || after.Size() != 16 || after.Mode().Perm() != 0o640 {
		t.Fatalf("patched: %q, %v", b, r)
	}
	if r["mtime"] != fileVersion(after) || r["size"] != float64(16) {
		t.Errorf("reply %v", r)
	}
	// Through a link: refused, the file left alone.
	os.Symlink("data.bin", filepath.Join(g.downloadsDir, "link.bin"))
	if r := patch("link.bin", fileVersion(after), after.Size(), run(0, "00")); r["error"] != errReplaceLink.Error() {
		t.Errorf("through a link: %v", r)
	}
	// A hard link: refused, and the other name (outside Downloads) left alone.
	outside := filepath.Join(t.TempDir(), "elsewhere.bin")
	os.WriteFile(outside, []byte("keep"), 0o640)
	os.Link(outside, filepath.Join(g.downloadsDir, "hard.bin"))
	hst, _ := os.Stat(outside)
	if r := patch("hard.bin", fileVersion(hst), hst.Size(), run(0, "00")); r["error"] != errHardLinked.Error() {
		t.Errorf("a hard link: %v", r)
	}
	if b, _ := os.ReadFile(outside); string(b) != "keep" {
		t.Errorf("changed through a hard link: %q", b)
	}
	// Not a file: refused before it's opened (a FIFO would otherwise block).
	syscall.Mkfifo(filepath.Join(g.downloadsDir, "pipe.bin"), 0o640)
	if r := patch("pipe.bin", "1-1", 0, run(0, "00")); r["error"] == nil {
		t.Errorf("a FIFO: %v", r)
	}
	// Search, through the tunnel: as the page read it.
	tc := openSession(t, ctx, srv.URL, s)
	if r := tc.request(t, ctx, tunnelRequest{Type: "file-search", Path: "data.bin", IfMtime: fileVersion(after), IfSize: 16, Pattern: "4200", Mask: "ff00"}); r["found"] != float64(4) || r["next"] != float64(-1) {
		t.Errorf("search: %v", r)
	}
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "file-search", Path: "data.bin", IfMtime: fileVersion(st) + "x", IfSize: 16, Pattern: "42", Mask: "ff"}); r["error"] == nil {
		t.Errorf("search of an old version: %v", r)
	}
	// With file support off, neither.
	g.fsOff = true
	for _, req := range []tunnelRequest{{Type: "file-patch", Path: "data.bin", IfMtime: fileVersion(after), IfSize: 16, Patches: []bytePatch{run(0, "00")}},
		{Type: "file-search", Path: "data.bin", Pattern: "41", Mask: "ff"}} {
		if r := openSession(t, ctx, srv.URL, s).request(t, ctx, req); r["error"] == nil {
			t.Errorf("%s with WEB_FS=0: %v", req.Type, r)
		}
	}
}

// TestSearchFileCancelled: a search given up on stops (its slot freed)
// rather than reading on to its stretch's end.
func TestSearchFileCancelled(t *testing.T) {
	data := make([]byte, 8*searchChunk)
	value, mask, _ := searchPattern("ff", "ff")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, backward := range []bool{false, true} {
		from := int64(0)
		if backward {
			from = int64(len(data) - 1)
		}
		found, next, err := searchFile(ctx, bytes.NewReader(data), int64(len(data)), value, mask, from, backward, int64(len(data)), time.Minute)
		if err == nil || found != -1 || next != -1 {
			t.Errorf("backward %v: %d %d %v", backward, found, next, err)
		}
	}
}
