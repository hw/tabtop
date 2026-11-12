package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBackgroundAssets(t *testing.T) {
	dir := t.TempDir()
	for _, name := range backgroundFiles {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	g := &server{serverConfig: serverConfig{backgroundDir: dir}}
	get := func(g *server, name string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+name, nil))
		return w
	}
	w := get(g, "image-background-worker.js")
	base := g.backgroundPath()
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"./`+base+`/u2netp.onnx"`) || strings.Contains(w.Body.String(), `"./background/`) {
		t.Fatalf("worker paths: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "'wasm-unsafe-eval'") || strings.Contains(filesCSP, "wasm") {
		t.Fatal("WASM must be allowed only in the worker")
	}
	for _, name := range backgroundFiles {
		w := get(g, base+"/"+name)
		if w.Code != 200 || w.Body.String() != name || w.Header().Get("Cache-Control") != immutableCache {
			t.Errorf("asset %s: %d %s", name, w.Code, w.Body.String())
		}
		if strings.HasSuffix(name, ".wasm") && w.Header().Get("Content-Type") != "application/wasm" {
			t.Error("WASM has the wrong content type")
		}
	}
	if w := get(g, base+"/not-listed"); w.Code != 404 {
		t.Error("unlisted file was served")
	}
	if w := get(&server{}, "image-background-worker.js"); !strings.Contains(w.Body.String(), `"./background-missing/u2netp.onnx"`) {
		t.Error("missing assets must use an unavailable path")
	}
}
