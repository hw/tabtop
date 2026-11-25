package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInpaintAssets(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "migan.onnx"), []byte("model"), 0o644); err != nil {
		t.Fatal(err)
	}
	g := &server{serverConfig: serverConfig{inpaintDir: dir}}
	get := func(g *server, name string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+name, nil))
		return w
	}
	w := get(g, "image-inpaint-worker.js")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"./`+g.inpaintPath()+`/migan.onnx"`) || !strings.Contains(w.Body.String(), `importScripts("./ort-worker.js")`) {
		t.Fatalf("worker paths: %d %s", w.Code, w.Body.String())
	}
	// (The runtime's set up by ort-worker.js, served with background removal's path.)
	if ort := get(g, "ort-worker.js").Body.String(); !strings.Contains(ort, `"./background-missing/ort.wasm.min.js"`) {
		t.Fatalf("runtime path: %s", ort)
	}
	if w.Header().Get("Content-Security-Policy") != backgroundWorkerCSP || strings.Contains(filesCSP, "wasm") {
		t.Fatal("WASM must stay confined to the worker")
	}
	w = get(g, g.inpaintPath()+"/migan.onnx")
	if w.Code != 200 || w.Body.String() != "model" || w.Header().Get("Cache-Control") != immutableCache {
		t.Fatalf("model asset: %d %s", w.Code, w.Body.String())
	}
	if get(g, g.inpaintPath()+"/LICENSE.migan").Code != 404 {
		t.Fatal("unlisted file served")
	}
	if w := get(&server{}, "image-inpaint-worker.js"); !strings.Contains(w.Body.String(), `"./inpaint-missing/migan.onnx"`) {
		t.Fatal("missing model path")
	}
}
