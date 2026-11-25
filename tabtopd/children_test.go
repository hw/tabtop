package main

import (
	"strings"
	"testing"
	"time"
)

// TestChildSandbox checks the preview children's sandbox (see
// children.go), as Markdown, books and SQLite are read in it: opening
// files, the network, reaching the parent, making processes refused.
func TestChildSandbox(t *testing.T) {
	result := runIsolatedChild(isolatedChild{Args: []string{sandboxCheckArg}, Input: strings.NewReader(""), Timeout: 30 * time.Second, OutputLimit: 4096})
	said := string(result.Output)
	if result.Err != nil || !strings.HasPrefix(said, "sandbox: <nil>;") {
		t.Fatalf("not sandboxed: %q, %v", said, result.Err)
	}
	if strings.Count(said, "operation not permitted") != 9 || !strings.Contains(said, "newer call: function not implemented;") ||
		!strings.HasSuffix(said, "own limits: errno 0; its flags: errno 0") {
		t.Fatalf("not as sandboxed as it should be: %q", said)
	}
}

// TestChildren checks each child is named by its argument, and an
// argument that names none starts nothing.
func TestChildren(t *testing.T) {
	for _, arg := range []string{markdownChildArg, epubChildArg, sqliteChildArg, heifChildArg, goBridgeArg, sandboxCheckArg} {
		if children[arg] == nil {
			t.Errorf("no child for %s", arg)
		}
	}
	if children["-check-config"] != nil {
		t.Error("a flag taken for a child")
	}
}
