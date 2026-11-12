package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSegmentAssets(t *testing.T) {
	dir := t.TempDir()
	for _, name := range segmentFiles {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	g := &server{serverConfig: serverConfig{segmentDir: dir}}
	get := func(g *server, name string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+name, nil))
		return w
	}
	w := get(g, "image-segment-worker.js")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"./`+g.segmentPath()+`/" + name`) {
		t.Fatalf("worker paths: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"./background-missing/ort.wasm.min.js"`) {
		t.Fatal("the runtime isn't background removal's")
	}
	if w.Header().Get("Content-Security-Policy") != backgroundWorkerCSP {
		t.Fatal("WASM must stay confined to the worker")
	}
	for _, name := range segmentFiles {
		w = get(g, g.segmentPath()+"/"+name)
		if w.Code != 200 || w.Body.String() != name || w.Header().Get("Cache-Control") != immutableCache {
			t.Fatalf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	if get(g, g.segmentPath()+"/LICENSE.mobilesam").Code != 404 {
		t.Fatal("unlisted file served")
	}
	if w := get(&server{}, "image-segment-worker.js"); !strings.Contains(w.Body.String(), `"./segment-missing/" + name`) {
		t.Fatal("missing model path")
	}
}
