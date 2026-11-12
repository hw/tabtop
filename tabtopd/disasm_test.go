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
	// The assembler it imports, beside it.
	if !strings.Contains(w.Body.String(), `"./x86-asm.js"`) {
		t.Error("the worker doesn't import the assembler")
	}
	if w := get(g, "x86-asm.js"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "makeAssembler") {
		t.Errorf("x86-asm.js: %d", w.Code)
	}
	// None: the worker says so when it fetches.
	off := &server{}
	if body := get(off, "disasm-worker.js").Body.String(); !strings.Contains(body, `"./disasm-missing/iced.js"`) {
		t.Errorf("without -disasm-dir: %s", body)
	}
}
