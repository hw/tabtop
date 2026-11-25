package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestGoPageSource: the page-world scripts as one, each in it once and
// guarded on its own: run (by Node, where it's there), one that throws
// as it's set up leaves the next set up, and none of what they share is
// the page's.
func TestGoPageSource(t *testing.T) {
	src := goPageSource()
	for _, js := range goPageScripts() {
		if strings.Count(src, js) != 1 {
			t.Fatalf("a script in it %d times", strings.Count(src, js))
		}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node")
	}
	dir := t.TempDir()
	whole := filepath.Join(dir, "whole.js")
	os.WriteFile(whole, []byte(src), 0o600)
	if out, err := exec.Command(node, "--check", whole).CombinedOutput(); err != nil {
		t.Fatalf("not a script: %v\n%s", err, out)
	}
	probe := goPageSourceOf([]string{`throw new Error("this one can't be set up")`, `globalThis.reached = typeof tabtopAsker === "function" && tabtopID().length > 8`})
	check := filepath.Join(dir, "check.js")
	os.WriteFile(check, []byte(`const vm = require("node:vm");
const ctx = vm.createContext({ window: {}, document: { addEventListener() {} }, setTimeout, clearTimeout, Promise, Map, JSON, Math, Date });
ctx.window.parent = ctx.window; ctx.window.top = ctx.window;
vm.runInContext(`+"`"+strings.ReplaceAll(probe, "`", "\\`")+"`"+`, ctx);
if (ctx.reached !== true) throw new Error("the one after a failed one wasn't set up");
for (const name of ["tabtopTop", "tabtopIsTop", "tabtopID", "tabtopAsker"]) if (vm.runInContext("typeof " + name, ctx) !== "undefined") throw new Error(name + " is the page's");
`), 0o600)
	if out, err := exec.Command(node, check).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
