package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestThreeAssets: the 3D preview's modules import three.js from the
// folder it's served from, by its hash; each of its files is served, as
// JavaScript, kept; nothing else is. Without the folder, they import from
// nowhere, and the preview says so.
func TestThreeAssets(t *testing.T) {
	dir := t.TempDir()
	for _, name := range threeFiles {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("// "+name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "ColladaLoader.js"), []byte("//"), 0o644); err != nil {
		t.Fatal(err)
	}
	g := &server{serverConfig: serverConfig{threeDir: dir}}
	get := func(g *server, name string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+name, nil))
		return w
	}
	path := g.threePath()
	if !strings.HasPrefix(path, "three-") || path == "three-missing" {
		t.Fatalf("path %q", path)
	}
	if csp := get(g, "model-worker.js").Header().Get("Content-Security-Policy"); csp != modelWorkerCSP {
		t.Fatalf("the model worker's CSP: %q", csp)
	}
	for name, want := range map[string]string{
		"model-view.js":   `import("./` + path + `/three.module.js")`,
		"model-worker.js": `import("./` + path + `/STLLoader.js")`,
	} {
		w := get(g, name)
		if w.Code != 200 || !strings.Contains(w.Body.String(), want) || strings.Contains(w.Body.String(), `"./three/`) {
			t.Fatalf("%s: %d, wants %s", name, w.Code, want)
		}
	}
	for _, name := range threeFiles {
		w := get(g, path+"/"+name)
		if w.Code != 200 || w.Body.String() != "// "+name || w.Header().Get("Cache-Control") != immutableCache {
			t.Fatalf("%s: %d %q", name, w.Code, w.Body.String())
		}
		if strings.HasSuffix(name, ".js") && !strings.Contains(w.Header().Get("Content-Type"), "javascript") {
			t.Fatalf("%s served as %q", name, w.Header().Get("Content-Type"))
		}
	}
	if get(g, path+"/ColladaLoader.js").Code != 404 {
		t.Fatal("a file not listed was served")
	}
	for _, name := range []string{"gcode.js", "model-info.js"} {
		if get(g, name).Code != 200 {
			t.Fatalf("%s isn't served", name)
		}
	}
	if w := get(&server{}, "model-view.js"); !strings.Contains(w.Body.String(), `import("./three-missing/three.module.js")`) {
		t.Fatal("without three.js, its imports should point nowhere")
	}
}
