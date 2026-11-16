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

// TestDisasmMissing: a disassembler whose files aren't in -disasm-dir is
// said to the page and the worker as not to be had, like one turned off,
// and the others, each with a path of its own, are served all the same.
func TestDisasmMissing(t *testing.T) {
	get := func(g *server, p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+p, nil))
		return w
	}
	// As a directory from before ARM64 had a module of its own.
	dir := t.TempDir()
	for _, name := range []string{"iced.js", "iced_x86_bg.wasm", "capstone.js", "capstone.wasm"} {
		os.WriteFile(filepath.Join(dir, name), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	}
	g := &server{serverConfig: serverConfig{disasmDir: dir}}
	worker := get(g, "disasm-worker.js").Body.String()
	for _, script := range []string{"hex-view.js", "disasm-worker.js"} {
		if body := get(g, script).Body.String(); !strings.Contains(body, `const DISASM_OFF = ["arm64"];`) {
			t.Errorf("%s isn't told that ARM64 isn't to be had", script)
		}
	}
	if !strings.Contains(worker, `"./disasm-missing/arm64-asm.wasm"`) {
		t.Error("ARM64's module has a path, with no file")
	}
	for _, file := range []string{"iced.js", "capstone.wasm"} {
		m := regexp.MustCompile(`"\./(disasm-[^/"]+)/` + regexp.QuoteMeta(file) + `"`).FindStringSubmatch(worker)
		if m == nil || m[1] == "disasm-missing" {
			t.Fatalf("%s, with ARM64's module missing: %v", file, m)
		}
		if w := get(g, m[1]+"/"+file); w.Code != http.StatusOK {
			t.Errorf("%s, with ARM64's module missing: %d", file, w.Code)
		}
	}
	// One of a disassembler's two files missing: that one isn't to be had.
	os.Remove(filepath.Join(dir, "capstone.wasm"))
	if body := get(&server{serverConfig: serverConfig{disasmDir: dir}}, "hex-view.js").Body.String(); !strings.Contains(body, `const DISASM_OFF = ["capstone","arm64"];`) {
		t.Error("with capstone.wasm gone, the page isn't told Capstone isn't to be had")
	}
	// A file that's there but can't be read as one (a directory of its
	// name): the page and the worker are told the same of it, that it isn't
	// to be had.
	unread := t.TempDir()
	for _, name := range disasmAssetNames() {
		os.WriteFile(filepath.Join(unread, name), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	}
	os.Remove(filepath.Join(unread, "arm64-asm.wasm"))
	os.Mkdir(filepath.Join(unread, "arm64-asm.wasm"), 0o755)
	u := &server{serverConfig: serverConfig{disasmDir: unread}}
	if page, worker := get(u, "hex-view.js").Body.String(), get(u, "disasm-worker.js").Body.String(); !strings.Contains(page, `const DISASM_OFF = ["arm64"];`) ||
		!strings.Contains(worker, `const DISASM_OFF = ["arm64"];`) || !strings.Contains(worker, `"./disasm-missing/arm64-asm.wasm"`) {
		t.Error("with arm64-asm.wasm unreadable, the page and the worker aren't told the same of ARM64")
	}
	// No -disasm-dir: none of those with files; RISC-V's and MIPS's, which are scripts, still are.
	if body := get(&server{}, "hex-view.js").Body.String(); !strings.Contains(body, `const DISASM_OFF = ["x86","capstone","arm64"];`) {
		t.Error("with no -disasm-dir, the page isn't told what isn't to be had")
	}
	// All there, none off: nothing said.
	for _, name := range disasmAssetNames() {
		os.WriteFile(filepath.Join(dir, name), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	}
	if body := get(&server{serverConfig: serverConfig{disasmDir: dir}}, "hex-view.js").Body.String(); !strings.Contains(body, "const DISASM_OFF = [];") {
		t.Error("with every file there, the page is told something isn't to be had")
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
