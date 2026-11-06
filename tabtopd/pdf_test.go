package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A part of a file, as the PDF preview asks for: as much as there is, of
// the file as it was opened, and nothing outside it.
func TestFileRange(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	data := make([]byte, 3*fileChunk+100)
	for i := range data {
		data[i] = byte(i * 13)
	}
	os.WriteFile(filepath.Join(g.downloadsDir, "doc.pdf"), data, 0o644)
	fetch := func(req tunnelRequest) (map[string]any, []byte) {
		tc := openSession(t, ctx, srv.URL, s)
		req.Type, req.Path = "file", "doc.pdf"
		r := tc.request(t, ctx, req)
		if r["ok"] != true {
			return r, nil
		}
		var got []byte
		for {
			kind, p, err := tc.read(ctx)
			if err != nil || kind != msgData {
				break // the end: the tunnel closes
			}
			got = append(got, p...)
			tc.write(ctx, msgData, nil)
		}
		return r, got
	}
	r, _ := fetch(tunnelRequest{Offset: 0, Length: 10})
	mtime := r["mtime"].(string)
	size := int64(len(data))
	for _, c := range []struct{ offset, length, want int64 }{
		{0, 100, 100},
		{fileChunk - 5, fileChunk + 10, fileChunk + 10}, // across chunks
		{size - 50, 1000, 50},                           // as much as there is
		{size, 10, 0},
	} {
		r, got := fetch(tunnelRequest{Offset: c.offset, Length: c.length, IfMtime: mtime, IfSize: size})
		if r["length"] != float64(c.want) || r["size"] != float64(size) || !bytes.Equal(got, data[c.offset:c.offset+c.want]) {
			t.Errorf("%d+%d: %v, %d bytes", c.offset, c.length, r, len(got))
		}
	}
	for _, req := range []tunnelRequest{{Offset: -1, Length: 5}, {Offset: size + 1, Length: 5}, {Offset: 0, Length: maxFileRange + 1}, {Offset: 0, Length: -3}} {
		if r, _ := fetch(req); r["error"] == nil {
			t.Errorf("%+v: %v", req, r)
		}
	}
	// Changed since it was opened: refused, not mixed.
	os.WriteFile(filepath.Join(g.downloadsDir, "doc.pdf"), append(data, 'x'), 0o644)
	if r, _ := fetch(tunnelRequest{Offset: 0, Length: 10, IfMtime: mtime, IfSize: size}); !strings.Contains(fmt.Sprint(r["error"]), "changed since") {
		t.Errorf("changed: %v", r)
	}
}

// pdf.js is served to any origin (the frame's is its own), but not its
// scripting sandbox; the frame's page has its CSP.
func TestPDFJSServed(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{"pdf.min.mjs", "pdf.worker.min.mjs", "pdf.sandbox.min.mjs", "cmaps/UniJIS-UCS2-H.bcmap", "wasm/openjpeg.wasm", "wasm/quickjs-eval.js"} {
		os.MkdirAll(filepath.Join(dir, filepath.Dir(f)), 0o755)
		os.WriteFile(filepath.Join(dir, f), []byte("// "+f), 0o644)
	}
	if got := strings.Join(pdfjsFiles(dir), " "); got != "cmaps/UniJIS-UCS2-H.bcmap pdf.min.mjs pdf.worker.min.mjs wasm/openjpeg.wasm" {
		t.Errorf("files: %s", got)
	}
	g, srv := newE2EServer(t)
	g.pdfjsDir, g.pdfjsNames = dir, pdfjsFiles(dir)
	get := func(p string) (*http.Response, string) {
		res, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}
	_, js := get("/tabtop/pdf-frame.js")
	res, artwork := get("/tabtop/glyphs.js")
	if res.StatusCode != http.StatusOK || res.Header.Get("Access-Control-Allow-Origin") != "*" ||
		!strings.Contains(artwork, "export function iconSVG") {
		t.Fatalf("shared frame glyphs: %d %v", res.StatusCode, res.Header)
	}
	base := g.pdfjsPath()
	if !strings.HasPrefix(base, "pdfjs-") || !strings.Contains(js, `"./`+base+`/"`) {
		t.Fatalf("pdf-frame.js points at %q", base)
	}
	for f, typ := range map[string]string{"pdf.min.mjs": "text/javascript", "cmaps/UniJIS-UCS2-H.bcmap": "application/octet-stream", "wasm/openjpeg.wasm": "application/wasm"} {
		res, body := get("/tabtop/" + base + "/" + f)
		if res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.HasPrefix(res.Header.Get("Content-Type"), typ) || body != "// "+f {
			t.Errorf("%s: %d %v", f, res.StatusCode, res.Header)
		}
	}
	for _, f := range []string{"pdf.sandbox.min.mjs", "wasm/quickjs-eval.js"} {
		if res, _ := get("/tabtop/" + base + "/" + f); res.StatusCode != 404 || res.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("%s: %d", f, res.StatusCode)
		}
	}
	res, page := get("/tabtop/pdf-frame.html")
	if res.Header.Get("Content-Security-Policy") != pdfFrameCSP || !strings.Contains(page, `<script src="pdf-frame.js"></script>`) {
		t.Errorf("pdf-frame.html: %v", res.Header)
	}
	// Each frame's page is sandboxed by itself, as well as by its frame:
	// opened on its own, it's still at an origin of its own.
	for _, f := range []string{"pdf-frame.html", "md-frame.html", "epub-frame.html"} {
		res, _ := get("/tabtop/" + f)
		if csp := res.Header.Get("Content-Security-Policy"); !strings.HasSuffix(csp, "; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox") {
			t.Errorf("%s: %q", f, csp)
		}
	}
	// Without pdf.js, the frame's script points nowhere.
	g.pdfjsDir, g.pdfjsNames = "", nil
	if _, js := get("/tabtop/pdf-frame.js"); !strings.Contains(js, `"./pdfjs-missing/"`) {
		t.Error("without pdf.js, pdf-frame.js points somewhere")
	}
}
