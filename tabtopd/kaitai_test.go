package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKaitaiAssets(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "parsers"), 0755)
	os.WriteFile(filepath.Join(dir, "formats.json"), []byte(`{"formats":[]}`), 0644)
	os.WriteFile(filepath.Join(dir, "parsers", "elf-ABC12345.js"), []byte("export const Parser = 1;"), 0644)
	secret := filepath.Join(t.TempDir(), "secret.js")
	os.WriteFile(secret, []byte("secret"), 0644)
	os.Symlink(secret, filepath.Join(dir, "parsers", "outside.js"))
	g := &server{serverConfig: serverConfig{kaitaiDir: dir}}
	for _, name := range []string{"formats.json", "parsers/elf-ABC12345.js"} {
		r := httptest.NewRequest("GET", "/tabtop/kaitai/"+name, nil)
		w := httptest.NewRecorder()
		if !g.serveKaitai(w, r, "kaitai/"+name) || w.Code != http.StatusOK {
			t.Fatalf("can't serve %s: %d", name, w.Code)
		}
		if !strings.Contains(w.Header().Get("Content-Type"), map[bool]string{true: "javascript", false: "json"}[strings.HasSuffix(name, ".js")]) {
			t.Fatalf("wrong MIME type for %s", name)
		}
		if strings.HasSuffix(name, ".js") && w.Header().Get("Cache-Control") != immutableCache {
			t.Fatal("hashed parser isn't cached")
		}
	}
	for _, name := range []string{"kaitai/../secret.js", "kaitai/parsers/outside.js", "kaitai/sources/foo.ksy", "kaitai/formats.json/", "kaitai/parsers"} {
		if g.serveKaitai(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil), name) {
			t.Fatalf("served %s", name)
		}
	}
}
