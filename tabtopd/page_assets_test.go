package main

import (
	"io/fs"
	"net/http"
	"strings"
	"testing"
)

// Every script embedded is served: none needs listing a second time.
func TestEmbeddedScriptsServed(t *testing.T) {
	_, srv := newE2EServer(t)
	scripts, _ := fs.Glob(pageFiles, "*.js")
	if len(scripts) < 50 {
		t.Fatalf("only %d scripts embedded", len(scripts))
	}
	for _, name := range scripts {
		res, err := http.Get(srv.URL + "/tabtop/" + name)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK || !strings.Contains(res.Header.Get("Content-Type"), "javascript") {
			t.Errorf("%s: %d %s", name, res.StatusCode, res.Header.Get("Content-Type"))
		}
	}
}
