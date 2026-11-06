package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// makeEpub is a book of files, by name, in order; mimetype first, stored,
// as EPUB has it.
func makeEpub(t *testing.T, files ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, _ := w.CreateHeader(&zip.FileHeader{Name: "mimetype", Method: zip.Store})
	f.Write([]byte("application/epub+zip"))
	for i := 0; i+1 < len(files); i += 2 {
		f, err := w.Create(files[i])
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(files[i+1]))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func openTestEpub(t *testing.T, b []byte) *epubZip {
	t.Helper()
	z, err := openEpubZip(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	return z
}

const testContainer = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`

// testOPF is an OPF listing chapters ch1, ch2 (with a space in its name)
// and a non-linear note, with a nav, an NCX, or both, as extra says.
func testOPF(manifest, spineAttrs string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>  A  Book &amp; More </dc:title><dc:creator>Ann Author</dc:creator><dc:creator>Second</dc:creator>
  <dc:language>en</dc:language><meta property="rendition:layout">reflowable</meta>
</metadata>
<manifest>
  <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  <item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/>
  <item id="note" href="text/note.xhtml" media-type="application/xhtml+xml"/>
  <item id="pic" href="images/a.png" media-type="image/png"/>
  ` + manifest + `
</manifest>
<spine ` + spineAttrs + `><itemref idref="c1"/><itemref idref="note" linear="no"/><itemref idref="c2"/></spine>
</package>`
}

const testChapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title/><script src="x.js"/><style>p { color: red }</style><link rel="stylesheet" href="s.css"/></head>
<body onload="alert(1)">
<a id="n1"/><p>one</p>
<div/><p>two</p>
<script src="y.js"/><p>three</p>
<title/><p>four</p>
<textarea/><p>five</p>
<noscript><svg xmlns="http://www.w3.org/2000/svg"/><p>hidden</p></noscript><p>six</p>
<noscript><body><p>hidden</p></body></noscript><p>seven</p>
<h1 id="sec" epub:type="title" class="big" style="color:red" onclick="alert(2)">Heading</h1>
<p>See <a href="ch%202.xhtml#part">the next</a>, <a href="#sec">this</a>, <a href="../../../out.xhtml">out</a>,
<a href="https://example.com/x" onclick="steal()">the web</a>, <a href="javascript:alert(3)">js</a>.</p>
<img src="../images/a.png" alt="A picture" onerror="alert(4)"/>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../images/cover.jpg"/><script>alert(5)</script></svg>
<iframe src="https://example.com/"></iframe><form action="https://example.com/"><input name="q"/></form>
<math><mi>x</mi></math>
<p>end &eacute; &amp; &lt;b&gt;</p>
</body></html>`

func TestEpubChapter(t *testing.T) {
	z := openTestEpub(t, makeEpub(t, "OEBPS/text/ch1.xhtml", testChapter))
	got, err := z.renderChapter("OEBPS/text/ch1.xhtml")
	if err != nil {
		t.Fatal(err)
	}
	// Each paragraph after a self-closed element is there, not swallowed.
	for _, want := range []string{"<p>one</p>", "<p>two</p>", "<p>three</p>", "<p>four</p>", "<p>five</p>", "<p>six</p>", "<p>seven</p>",
		`<h1 id="b-sec">Heading</h1>`, `<a id="b-n1"></a>`,
		`<a href="OEBPS/text/ch%202.xhtml#b-part" rel="nofollow noreferrer">the next</a>`,
		`<a href="OEBPS/text/ch1.xhtml#b-sec" rel="nofollow noreferrer">this</a>`,
		`<a href="https://example.com/x" rel="nofollow noreferrer noopener" target="_blank">the web</a>`,
		`<img src="OEBPS/images/a.png" alt="A picture">`, `<img src="OEBPS/images/cover.jpg" alt="">`,
		"<p>end é &amp; &lt;b&gt;</p>"} {
		if !strings.Contains(got, want) {
			t.Errorf("no %s in\n%s", want, got)
		}
	}
	for _, bad := range []string{"alert", "steal", "script", "style", "color", "onclick", "onload", "onerror", "iframe",
		"form", "input", "textarea", "math", "hidden", "noscript", "class", "epub", "x.js", "s.css", "out.xhtml", "javascript", "<mi>", "svg"} {
		if strings.Contains(got, bad) {
			t.Errorf("%q in\n%s", bad, got)
		}
	}
	if _, err := z.renderChapter("OEBPS/images/a.png"); err == nil {
		t.Error("a picture rendered as a chapter")
	}
	if _, err := z.renderChapter("OEBPS/text/none.xhtml"); err != errEpubMissing {
		t.Errorf("a missing chapter: %v", err)
	}
}

func TestEpubResolve(t *testing.T) {
	for _, c := range []struct{ base, href, item, frag string }{
		{"OEBPS/text/a.xhtml", "b.xhtml", "OEBPS/text/b.xhtml", ""},
		{"OEBPS/text/a.xhtml", "../images/p%20q.png", "OEBPS/images/p q.png", ""},
		{"OEBPS/text/a.xhtml", "#x%20y", "OEBPS/text/a.xhtml", "x y"},
		{"OEBPS/text/a.xhtml", "/top.xhtml#t", "top.xhtml", "t"},
		{"OEBPS/text/a.xhtml", "../../../etc/passwd", "", ""},
		{"OEBPS/text/a.xhtml", "https://example.com/", "", ""},
		{"OEBPS/text/a.xhtml", "//example.com/", "", ""},
		{"OEBPS/text/a.xhtml", "javascript:alert(1)", "", ""},
		{"a.opf", "c.xhtml?x=1", "c.xhtml", ""},
	} {
		item, frag, ok := epubResolve(c.base, c.href)
		if item != c.item || frag != c.frag || ok != (c.item != "") {
			t.Errorf("%s from %s: %q %q %v", c.href, c.base, item, frag, ok)
		}
	}
}

const testNav = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="landmarks"><ol><li><a href="../text/note.xhtml">Landmark</a></li></ol></nav>
<nav epub:type="toc"><h2>Contents</h2><ol>
<li><a href="../text/ch1.xhtml">Chapter
  One</a><ol><li><a href="../text/ch1.xhtml#sec">A section</a></li></ol></li>
<li><span>Part two</span><ol><li><a href="../text/ch%202.xhtml">Chapter Two</a></li></ol></li>
<li><a href="../text/missing.xhtml">Gone</a></li>
<li><a href="../text/note.xhtml"><span>Split</span> <span>label</span></a></li>
<li><span><a href="../text/note.xhtml#n">Inside a span</a></span></li>
</ol></nav></body></html>`

const testNCX = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
<navPoint id="p1"><navLabel><text>First</text></navLabel><content src="text/ch1.xhtml"/>
  <navPoint id="p1a"><navLabel><text>Inner</text></navLabel><content src="text/ch1.xhtml#sec"/></navPoint></navPoint>
<navPoint id="p2"><content src="text/ch%202.xhtml"/><navLabel><text>Second</text></navLabel></navPoint>
</navMap></ncx>`

func testBookFiles(manifest, spineAttrs string, more ...string) []string {
	return append([]string{"META-INF/container.xml", testContainer, "OEBPS/content.opf", testOPF(manifest, spineAttrs),
		"OEBPS/text/ch1.xhtml", testChapter, "OEBPS/text/ch 2.xhtml", "<html><body><p id='part'>2</p></body></html>",
		"OEBPS/text/note.xhtml", "<html><body>note</body></html>", "OEBPS/images/a.png", "png"}, more...)
}

func TestEpubBook(t *testing.T) {
	spine := []string{"OEBPS/text/ch1.xhtml", "OEBPS/text/ch 2.xhtml"}
	nav := `<item id="nav" href="nav/toc.xhtml" properties="nav" media-type="application/xhtml+xml"/>`
	ncx := `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
	for _, c := range []struct {
		name     string
		manifest string
		spine    string
		files    []string
		toc      []epubTOCItem
	}{
		{"nav", nav, "", []string{"OEBPS/nav/toc.xhtml", testNav}, []epubTOCItem{
			{"Chapter One", "OEBPS/text/ch1.xhtml", "", 1},
			{"A section", "OEBPS/text/ch1.xhtml", "b-sec", 2},
			{"Chapter Two", "OEBPS/text/ch 2.xhtml", "", 2},
			{"Split label", "OEBPS/text/note.xhtml", "", 1},
			{"Inside a span", "OEBPS/text/note.xhtml", "b-n", 1},
		}},
		{"ncx", ncx, `toc="ncx"`, []string{"OEBPS/toc.ncx", testNCX}, []epubTOCItem{
			{"First", "OEBPS/text/ch1.xhtml", "", 1},
			{"Inner", "OEBPS/text/ch1.xhtml", "b-sec", 2},
			{"Second", "OEBPS/text/ch 2.xhtml", "", 1},
		}},
		{"nav before ncx", nav + ncx, `toc="ncx" page-progression-direction="rtl"`,
			[]string{"OEBPS/nav/toc.xhtml", testNav, "OEBPS/toc.ncx", testNCX}, nil},
		{"none", "", "", nil, []epubTOCItem{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			z := openTestEpub(t, makeEpub(t, testBookFiles(c.manifest, c.spine, c.files...)...))
			book, err := z.readBook()
			if err != nil {
				t.Fatal(err)
			}
			if book.Title != "A Book & More" || book.Creator != "Ann Author" || book.Language != "en" || book.Fixed ||
				!reflect.DeepEqual(book.Spine, spine) {
				t.Errorf("%+v", book)
			}
			if c.toc != nil && !reflect.DeepEqual(book.TOC, c.toc) {
				t.Errorf("contents %+v", book.TOC)
			}
			if c.name == "nav before ncx" && (len(book.TOC) != 5 || book.TOC[0].Label != "Chapter One" || !book.RTL) {
				t.Errorf("%+v", book)
			}
		})
	}
}

func TestEpubNotBooks(t *testing.T) {
	if _, err := openEpubZip(strings.NewReader("not a zip"), 9); err != errEpubNotBook {
		t.Errorf("not a zip: %v", err)
	}
	z := openTestEpub(t, makeEpub(t, "OEBPS/content.opf", testOPF("", "")))
	if _, err := z.readBook(); err != errEpubNotBook {
		t.Errorf("no container.xml: %v", err)
	}
	// No chapter in the spine that's there.
	z = openTestEpub(t, makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", testOPF("", "")))
	if _, err := z.readBook(); err != errEpubNotBook {
		t.Errorf("no chapters: %v", err)
	}
	// Names leading out of the book aren't in it.
	z = openTestEpub(t, makeEpub(t, "../evil.xhtml", "<p>x</p>", "/abs.xhtml", "<p>x</p>", "ok.xhtml", "<p>x</p>"))
	if len(z.files) != 2 || z.files["ok.xhtml"] == nil {
		t.Errorf("files: %v", z.files)
	}
}

func TestEpubDRM(t *testing.T) {
	encryption := func(algorithm string) string {
		return `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
<enc:EncryptedData><enc:EncryptionMethod Algorithm="` + algorithm + `"/><enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`
	}
	for _, c := range []struct {
		name  string
		files []string
		drm   bool
	}{
		{"AES", []string{"META-INF/encryption.xml", encryption("http://www.w3.org/2001/04/xmlenc#aes128-cbc")}, true},
		{"LCP", []string{"META-INF/license.lcpl", "{}"}, true},
		{"fonts only", []string{"META-INF/encryption.xml", encryption("http://www.idpf.org/2008/embedding")}, false},
		{"Adobe's fonts", []string{"META-INF/encryption.xml", encryption("http://ns.adobe.com/pdf/enc#RC")}, false},
	} {
		z := openTestEpub(t, makeEpub(t, testBookFiles("", "", c.files...)...))
		_, err := z.readBook()
		if (err == errEpubProtected) != c.drm || !c.drm && err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

func TestEpubLimits(t *testing.T) {
	// A chapter that unpacks to more than a chapter may be.
	big := strings.Repeat("<p>x</p>", maxEpubChapter/8+10)
	z := openTestEpub(t, makeEpub(t, "a.xhtml", big))
	if _, err := z.renderChapter("a.xhtml"); err != errEpubTooBig {
		t.Errorf("a big chapter: %v", err)
	}
	// One that says it's small, and isn't: what it unpacks to is what counts.
	f := z.files["a.xhtml"]
	f.UncompressedSize64 = 10
	// (zip itself won't unpack past what it says: it's damaged, then.)
	if _, err := z.read("a.xhtml", 1000); err != errEpubTooBig && err != errEpubNotBook {
		t.Errorf("a chapter bigger than it says: %v", err)
	}
	// Too many files.
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for i := 0; i <= maxEpubEntries; i++ {
		w.CreateHeader(&zip.FileHeader{Name: fmt.Sprint(i), Method: zip.Store})
	}
	w.Close()
	if _, err := openEpubZip(bytes.NewReader(buf.Bytes()), int64(buf.Len())); err == nil || !strings.Contains(err.Error(), "files in it") {
		t.Errorf("too many files: %v", err)
	}
}

// TestEpubTunnel reads a book as the page does, through the tunnel and the
// child process: the book, a chapter, a picture, and a book changed since.
func TestEpubTunnel(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	png := []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("p", 3*fileChunk))
	book := makeEpub(t, append(testBookFiles(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`, `toc="ncx"`,
		"OEBPS/toc.ncx", testNCX), "OEBPS/images/b.png", string(png))...)
	os.WriteFile(filepath.Join(g.downloadsDir, "book.epub"), book, 0o644)
	os.WriteFile(filepath.Join(g.downloadsDir, "not.epub"), []byte("text"), 0o644)
	ask := func(req tunnelRequest) (map[string]any, []byte) {
		tc := openSession(t, ctx, srv.URL, s)
		req.Type = "epub"
		r := tc.request(t, ctx, req)
		var got []byte
		if r["ok"] == true && r["mime"] != nil {
			for {
				kind, p, err := tc.read(ctx)
				if err != nil || kind != msgData {
					break
				}
				got = append(got, p...)
				tc.write(ctx, msgData, nil)
			}
		}
		return r, got
	}
	r, _ := ask(tunnelRequest{Path: "book.epub"})
	b, _ := json.Marshal(r["book"])
	var got epubBook
	json.Unmarshal(b, &got)
	if r["ok"] != true || got.Title != "A Book & More" || len(got.Spine) != 2 || len(got.TOC) != 3 || r["size"] != float64(len(book)) {
		t.Fatalf("the book: %v", r)
	}
	mtime := r["mtime"].(string)
	r, _ = ask(tunnelRequest{Path: "book.epub", Item: "OEBPS/text/ch1.xhtml", IfMtime: mtime, IfSize: int64(len(book))})
	if h, _ := r["html"].(string); !strings.Contains(h, "<p>five</p>") || strings.Contains(h, "alert") {
		t.Errorf("a chapter: %v", r)
	}
	r, pic := ask(tunnelRequest{Path: "book.epub", Item: "OEBPS/images/b.png", IfMtime: mtime, IfSize: int64(len(book))})
	if r["mime"] != "image/png" || !bytes.Equal(pic, png) {
		t.Errorf("a picture: %v, %d bytes", r, len(pic))
	}
	for _, c := range []struct {
		req  tunnelRequest
		want string
	}{
		{tunnelRequest{Path: "not.epub"}, errEpubNotBook.Error()},
		{tunnelRequest{Path: "book.epub", Item: "OEBPS/text/none.xhtml"}, errEpubMissing.Error()},
		{tunnelRequest{Path: "book.epub", Item: "OEBPS/content.opf"}, "it isn't a chapter"},
		{tunnelRequest{Path: "book.epub", Item: "../book.epub"}, "it isn't a chapter"},
		{tunnelRequest{Path: "book.epub", Item: "OEBPS/text/ch1.xhtml", IfMtime: "1", IfSize: int64(len(book))}, errEpubChanged.Error()},
		{tunnelRequest{Path: "none.epub"}, "Not found."},
	} {
		if r, _ := ask(c.req); r["error"] != c.want {
			t.Errorf("%+v: %v, want %q", c.req, r, c.want)
		}
	}
}

func TestEpubLatin1(t *testing.T) {
	chapter := "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><html><body><p>caf\xe9 " +
		strings.Repeat("\xe0\xe9\xee\xf5\xfc ", 3000) + "fin</p></body></html>"
	z := openTestEpub(t, makeEpub(t, "a.xhtml", chapter))
	got, err := z.renderChapter("a.xhtml")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "<p>café àéîõü ") || !strings.HasSuffix(got, " fin</p>") || strings.Count(got, "àéîõü") != 3000 {
		t.Errorf("%.80s … %s", got, got[len(got)-20:])
	}
}

// TestEpubLongChapter reads a chapter of some megabytes, as a book in one
// file has, through the tunnel and the child, in good time (but with the
// race detector, a smaller one, in whatever time).
func TestEpubLongChapter(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	var long strings.Builder
	long.WriteString("<html><body>")
	size := 6 << 20
	if raceEnabled {
		size = 2 << 20
	}
	for i := 0; long.Len() < size; i++ {
		fmt.Fprintf(&long, "<p id=\"p%d\">Paragraph %d, with <em>some</em> words in it, and <a href=\"#p1\">a link</a>.</p>\n", i, i)
	}
	long.WriteString("<p>The end.</p></body></html>")
	book := makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", testOPF("", ""),
		"OEBPS/text/ch1.xhtml", long.String(), "OEBPS/text/ch 2.xhtml", "<p>2</p>")
	os.WriteFile(filepath.Join(g.downloadsDir, "long.epub"), book, 0o644)
	start := time.Now()
	r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "epub", Path: "long.epub", Item: "OEBPS/text/ch1.xhtml"})
	h, _ := r["html"].(string)
	if !strings.Contains(h, "<p>The end.</p>") || !strings.Contains(h, `id="b-p100"`) {
		t.Fatalf("%.200v", r)
	}
	if took := time.Since(start); took > epubTimeout/2 && !raceEnabled {
		t.Errorf("a %d MB chapter took %v", long.Len()>>20, took)
	} else {
		t.Logf("a %d MB chapter: %d MB of HTML in %v", long.Len()>>20, len(h)>>20, took.Round(time.Millisecond))
	}
}

func TestEpubDataPictures(t *testing.T) {
	png := base64.StdEncoding.EncodeToString(testPicture(t, "png"))
	wrapped := png[:20] + "\n   " + png[20:]
	chapter := `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><body>
<img src="DATA:IMAGE/PNG;BASE64,` + wrapped + `" alt="in the chapter"/>
<svg><image xlink:href="data:image/png;base64,` + png + `"/></svg>
<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" alt="html"/>
<img src="data:image/png;base64,not*base64" alt="broken"/>
<a href="data:image/png;base64,` + png + `">a link</a>
</body></html>`
	got, err := openTestEpub(t, makeEpub(t, "a.xhtml", chapter)).renderChapter("a.xhtml")
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(got, `src="data:image/png;base64,`+png+`"`); n != 2 {
		t.Errorf("%d pictures kept, not 2:\n%s", n, got)
	}
	for _, bad := range []string{"text/html", "not*base64", `href="data`} {
		if strings.Contains(got, bad) {
			t.Errorf("%s kept:\n%s", bad, got)
		}
	}
}

// TestFolderPreviewsClosed: asked to preview, read or edit a folder as a
// file, the gateway refuses, and closes what it opened to find out.
func TestFolderPreviewsClosed(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	for _, d := range []string{"notes.md", "book.epub"} {
		os.Mkdir(filepath.Join(g.downloadsDir, d), 0o755)
	}
	open := func() int {
		des, _ := os.ReadDir("/proc/self/fd")
		return len(des)
	}
	before := open()
	for range 40 {
		for _, req := range []tunnelRequest{{Type: "markdown", Path: "notes.md"}, {Type: "epub", Path: "book.epub"},
			{Type: "epub-edit", Path: "book.epub", IfMtime: "1", Title: "x"}} {
			tc := openSession(t, ctx, srv.URL, s)
			r := tc.request(t, ctx, req)
			tc.c.Close(websocket.StatusNormalClosure, "")
			if r["error"] != "Not found." {
				t.Fatalf("%s of a folder: %v", req.Type, r)
			}
		}
	}
	// (Each request's own connection may be a moment closing.)
	time.Sleep(200 * time.Millisecond)
	if after := open(); after-before > 20 {
		t.Errorf("%d descriptors open before, %d after 120 refused", before, after)
	}
}

// TestEpubLayoutNotTitle: a title that starts "layout:" is a title, and a
// book's layout is read from its own meta, whatever the title says.
func TestEpubLayoutNotTitle(t *testing.T) {
	opf := editOPF("3.0", `<dc:title>layout: pre-paginated</dc:title><dc:creator>layout: Ann</dc:creator>`+
		`<meta property="rendition:layout">pre-paginated</meta>`, "")
	book, err := openTestEpub(t, makeEpub(t, editBookFiles(opf)...)).readBook()
	if err != nil || book.Title != "layout: pre-paginated" || book.Creator != "layout: Ann" || !book.Fixed {
		t.Errorf("%+v, %v", book, err)
	}
}
