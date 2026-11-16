package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestDemangleAssets: the demangler is the worker's too, in -disasm-dir,
// but a set of its own: served whichever disassemblers are turned off, and
// whether or not their files are there; and they are without it.
func TestDemangleAssets(t *testing.T) {
	get := func(g *server, p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+p, nil))
		return w
	}
	path := regexp.MustCompile(`"\./(demangle-[^/"]+)/demangle\.wasm"`)
	// It alone is there, and every disassembler is off.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "demangle.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	g := &server{serverConfig: serverConfig{disasmDir: dir, disasmOff: "all"}}
	worker := get(g, "disasm-worker.js").Body.String()
	m := path.FindStringSubmatch(worker)
	if m == nil || m[1] == "demangle-missing" || strings.Contains(worker, `"./demangle/`) {
		t.Fatalf("the worker's path to the demangler: %v", m)
	}
	if w := get(g, m[1]+"/demangle.wasm"); w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/wasm" ||
		!strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("demangle.wasm: %d, %q, %q", w.Code, w.Header().Get("Content-Type"), w.Header().Get("Cache-Control"))
	}
	if w := get(g, m[1]+"/iced.js"); w.Code != http.StatusNotFound {
		t.Errorf("a file that isn't the demangler's, under its path: %d", w.Code)
	}
	// It isn't there (a -disasm-dir from before it): the disassemblers still are.
	old := t.TempDir()
	for _, name := range disasmAssetNames() {
		os.WriteFile(filepath.Join(old, name), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	}
	before := &server{serverConfig: serverConfig{disasmDir: old}}
	worker = get(before, "disasm-worker.js").Body.String()
	if !strings.Contains(worker, `"./demangle-missing/demangle.wasm"`) {
		t.Error("without demangle.wasm, the worker isn't pointed at nothing for it")
	}
	d := regexp.MustCompile(`"\./(disasm-[^/"]+)/arm64-asm\.wasm"`).FindStringSubmatch(worker)
	if d == nil || d[1] == "disasm-missing" {
		t.Fatalf("without demangle.wasm, the disassemblers' path: %v", d)
	}
	if w := get(before, d[1]+"/arm64-asm.wasm"); w.Code != http.StatusOK {
		t.Errorf("a disassembler's file, without the demangler: %d", w.Code)
	}
	// No -disasm-dir: neither.
	if body := get(&server{}, "disasm-worker.js").Body.String(); !strings.Contains(body, `"./demangle-missing/demangle.wasm"`) {
		t.Error("without -disasm-dir, the worker has a path to the demangler")
	}
}

// disasmAssetNames is every disassembler's files, as -disasm-dir has them.
func disasmAssetNames() []string {
	names := []string{}
	for _, e := range disasmEngines {
		names = append(names, e.files...)
	}
	return names
}
