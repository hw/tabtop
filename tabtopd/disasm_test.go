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

// TestDisasmAssets: the worker is served with a CSP of its own, which lets
// it (not the page) run WebAssembly, pointing at the disassembler's files,
// which are served from there, as WebAssembly; without -disasm-dir, at a
// path that isn't.
func TestDisasmAssets(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "iced.js"), []byte("self.icedInit = 1;"), 0o644)
	os.WriteFile(filepath.Join(dir, "iced_x86_bg.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	os.WriteFile(filepath.Join(dir, "capstone.js"), []byte("self.MCapstone = 1;"), 0o644)
	os.WriteFile(filepath.Join(dir, "capstone.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	os.WriteFile(filepath.Join(dir, "arm64-asm.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	get := func(g *server, p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+p, nil))
		return w
	}
	g := &server{serverConfig: serverConfig{disasmDir: dir}}
	w := get(g, "disasm-worker.js")
	csp := w.Header().Get("Content-Security-Policy")
	if w.Code != http.StatusOK || !strings.Contains(csp, "'wasm-unsafe-eval'") || !strings.Contains(csp, "default-src 'none'") ||
		!strings.Contains(w.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("the worker: %d, %q, %q", w.Code, csp, w.Header().Get("Content-Type"))
	}
	if strings.Contains(filesCSP, "wasm") {
		t.Error("the page itself may run WebAssembly")
	}
	m := regexp.MustCompile(`"\./(disasm-[^/"]+)/iced\.js"`).FindStringSubmatch(w.Body.String())
	if m == nil || strings.Contains(w.Body.String(), `"./disasm/`) {
		t.Fatalf("the worker's paths: %s", w.Body.String())
	}
	if w := get(g, m[1]+"/iced.js"); w.Code != http.StatusOK || w.Body.String() != "self.icedInit = 1;" {
		t.Errorf("iced.js: %d", w.Code)
	}
	if w := get(g, m[1]+"/iced_x86_bg.wasm"); w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/wasm" {
		t.Errorf("the WebAssembly: %d, %q", w.Code, w.Header().Get("Content-Type"))
	}
	if w := get(g, m[1]+"/LICENSE.iced"); w.Code != http.StatusNotFound {
		t.Errorf("a file not listed: %d", w.Code)
	}
	// Both backends use the hashed asset path and the same restricted CSP.
	if !strings.Contains(w.Body.String(), `"./`+m[1]+`/capstone.js"`) || !strings.Contains(w.Body.String(), `"./`+m[1]+`/capstone.wasm"`) {
		t.Error("the ARM32 backend doesn't use the versioned asset path")
	}
	if !strings.Contains(w.Body.String(), `"./`+m[1]+`/arm64-asm.wasm"`) {
		t.Error("ARM64's module doesn't use the versioned asset path")
	}
	for _, file := range []string{"capstone.js", "capstone.wasm", "arm64-asm.wasm"} {
		if w := get(g, m[1]+"/"+file); w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
			t.Errorf("%s: %d, %q", file, w.Code, w.Header().Get("Cache-Control"))
		} else if strings.HasSuffix(file, ".wasm") && w.Header().Get("Content-Type") != "application/wasm" {
			t.Errorf("%s: %q", file, w.Header().Get("Content-Type"))
		}
	}
	// The assembler it imports, beside it.
	if !strings.Contains(w.Body.String(), `"./x86-asm.js"`) {
		t.Error("the worker doesn't import the assembler")
	}
	if w := get(g, "x86-asm.js"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "makeAssembler") {
		t.Errorf("x86-asm.js: %d", w.Code)
	}
	// RISC-V's and MIPS's, scripts beside it too, with no files of their own.
	for _, name := range []string{"riscv", "mips"} {
		if !strings.Contains(w.Body.String(), `"./`+name+`-asm.js"`) {
			t.Errorf("the worker doesn't import %s-asm.js", name)
		}
		if w := get(g, name+"-asm.js"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "root."+name) {
			t.Errorf("%s-asm.js: %d", name, w.Code)
		}
	}
	// None: the worker says so when it fetches.
	off := &server{}
	if body := get(off, "disasm-worker.js").Body.String(); !strings.Contains(body, `"./disasm-missing/iced.js"`) {
		t.Errorf("without -disasm-dir: %s", body)
	}
	// None turned off: the page and the worker are told so.
	for _, script := range []string{"hex-view.js", "disasm-worker.js"} {
		if body := get(g, script).Body.String(); !strings.Contains(body, "const DISASM_OFF = [];") {
			t.Errorf("%s doesn't say that no disassembler is off", script)
		}
	}
}

// TestDisasmDisable: -disasm-disable (WEB_DISASM_DISABLE) turns off the
// disassemblers it names: the page and the worker are told which, and their
// files aren't served (nor need be there), while the others' are.
func TestDisasmDisable(t *testing.T) {
	for value, want := range map[string]string{
		"": "", "none": "", "all": "x86,capstone,arm64,riscv,mips", "x86": "x86", "arm64,x86": "x86,arm64", " capstone , arm64 ": "capstone,arm64",
		"x86,capstone,arm64": "x86,capstone,arm64", "capstone,capstone": "capstone", "riscv": "riscv", "mips,riscv": "riscv,mips", "riscv,x86,capstone,arm64": "x86,capstone,arm64,riscv",
	} {
		if got, err := disasmDisabled(value); err != nil || strings.Join(got, ",") != want {
			t.Errorf("%q: %v, %v; want %q", value, got, err, want)
		}
	}
	for _, value := range []string{"thumb", "x86,", ",", "all,x86", "none,arm64", "X86", "x86 arm64"} {
		if got, err := disasmDisabled(value); err == nil {
			t.Errorf("%q is taken: %v", value, got)
		}
	}
	// Only iced-x86 is there: enough, with the others off.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "iced.js"), []byte("self.icedInit = 1;"), 0o644)
	os.WriteFile(filepath.Join(dir, "iced_x86_bg.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	get := func(g *server, p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+p, nil))
		return w
	}
	g := &server{serverConfig: serverConfig{disasmDir: dir, disasmOff: "arm64,capstone"}}
	worker := get(g, "disasm-worker.js").Body.String()
	m := regexp.MustCompile(`"\./(disasm-[^/"]+)/iced\.js"`).FindStringSubmatch(worker)
	if m == nil || m[1] == "disasm-missing" {
		t.Fatalf("the worker's paths, with x86 alone on: %v", m)
	}
	for _, script := range []string{"hex-view.js", "disasm-worker.js"} {
		if body := get(g, script).Body.String(); !strings.Contains(body, `const DISASM_OFF = ["capstone","arm64"];`) || strings.Contains(body, "const DISASM_OFF = [];") {
			t.Errorf("%s isn't told what's off", script)
		}
	}
	if w := get(g, m[1]+"/iced.js"); w.Code != http.StatusOK {
		t.Errorf("iced.js, on: %d", w.Code)
	}
	for _, file := range []string{"capstone.js", "capstone.wasm", "arm64-asm.wasm"} {
		if w := get(g, m[1]+"/"+file); w.Code != http.StatusNotFound {
			t.Errorf("%s, off: %d", file, w.Code)
		}
	}
	// All off: nothing of it is served.
	none := &server{serverConfig: serverConfig{disasmDir: dir, disasmOff: "all"}}
	if body := get(none, "disasm-worker.js").Body.String(); !strings.Contains(body, `"./disasm-missing/iced.js"`) || !strings.Contains(body, `const DISASM_OFF = ["x86","capstone","arm64","riscv","mips"];`) {
		t.Error("with all off, the worker still has its files' path, or isn't told")
	}
	if w := get(none, m[1]+"/iced.js"); w.Code != http.StatusNotFound {
		t.Errorf("iced.js, with all off: %d", w.Code)
	}
}
