package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var editNow = time.Date(2026, 11, 4, 9, 30, 0, 0, time.UTC)

// editOPF is an OPF of the given version, with metadata and manifest
// items as given, and the chapter ch1.
func editOPF(version, metadata, manifest string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="` + version + `" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    ` + metadata + `
  </metadata>
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    ` + manifest + `
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`
}

func editBookFiles(opf string, more ...string) []string {
	return append([]string{"META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
		"OEBPS/text/ch1.xhtml", "<html><body><p>1</p></body></html>", "odd//name.txt", "kept, though not read"}, more...)
}

func testPicture(t *testing.T, kind string) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for i := range img.Pix {
		img.Pix[i] = byte(i)
	}
	img.Set(0, 0, color.White)
	var b bytes.Buffer
	if kind == "png" {
		png.Encode(&b, img)
	} else {
		jpeg.Encode(&b, img, nil)
	}
	return b.Bytes()
}

// edited edits the book, and checks every file in it but the OPF and the
// cover (those in changed) is as it was, byte for byte, in order, with
// mimetype first, stored, as it was; it returns the book and its OPF.
func edited(t *testing.T, book []byte, e epubEdit, cover []byte, changed ...string) (*epubZip, string) {
	t.Helper()
	var out bytes.Buffer
	if err := openTestEpub(t, book).editBook(e, cover, &out, editNow); err != nil {
		t.Fatal(err)
	}
	was, _ := zip.NewReader(bytes.NewReader(book), int64(len(book)))
	now, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(now.File) < len(was.File) {
		t.Fatalf("%d files, from %d", len(now.File), len(was.File))
	}
	for i, f := range was.File {
		g := now.File[i]
		if g.Name != f.Name {
			t.Fatalf("file %d: %s, was %s", i, g.Name, f.Name)
		}
		if f.Name == "OEBPS/content.opf" || strings.Contains(strings.Join(changed, " "), f.Name) {
			continue
		}
		a, _ := f.OpenRaw()
		b, _ := g.OpenRaw()
		ab, _ := io.ReadAll(a)
		bb, _ := io.ReadAll(b)
		if !bytes.Equal(ab, bb) || g.CRC32 != f.CRC32 || g.Method != f.Method || !bytes.Equal(g.Extra, f.Extra) {
			t.Errorf("%s changed", f.Name)
		}
	}
	if m := now.File[0]; m.Name != "mimetype" || m.Method != zip.Store || len(m.Extra) != 0 {
		t.Errorf("mimetype: %+v", m.FileHeader)
	}
	z := openTestEpub(t, out.Bytes())
	opf, err := z.read("OEBPS/content.opf", maxEpubMeta)
	if err != nil {
		t.Fatal(err)
	}
	// Well formed, and every prefix declared: encoding/xml leaves one it
	// can't resolve as it is, not a URI.
	d := xml.NewDecoder(bytes.NewReader(opf))
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("not XML: %v\n%s", err, opf)
		}
		if s, ok := tok.(xml.StartElement); ok {
			names := []xml.Name{s.Name}
			for _, a := range s.Attr {
				names = append(names, a.Name)
			}
			for _, n := range names {
				if n.Space != "" && n.Space != "xmlns" && n.Space != "xml" && !strings.Contains(n.Space, ":") {
					t.Errorf("the prefix %s: isn't declared:\n%s", n.Space, opf)
				}
			}
		}
	}
	return z, string(opf)
}

func TestEpubEditDetails(t *testing.T) {
	for _, c := range []struct {
		name, version, metadata string
		edit                    epubEdit
		want                    string // the metadata after
	}{
		{"plain", "3.0", `<dc:title>Old</dc:title><dc:creator>Ann</dc:creator><dc:creator>Second</dc:creator>`,
			epubEdit{Title: "New & <Better>", Creator: " Bea   Writer "},
			`<dc:title>New &amp; &lt;Better&gt;</dc:title><dc:creator>Bea Writer</dc:creator><dc:creator>Second</dc:creator>`},
		{"title only", "3.0", `<dc:title>Old</dc:title><dc:creator>Ann</dc:creator>`,
			epubEdit{Title: "New", Creator: "Ann"},
			`<dc:title>New</dc:title><dc:creator>Ann</dc:creator>`},
		{"self-closed", "2.0", `<dc:title>T</dc:title><dc:creator opf:role="aut"/>`,
			epubEdit{Title: "T", Creator: "Cy"},
			`<dc:title>T</dc:title><dc:creator opf:role="aut">Cy</dc:creator>`},
		{"none to start", "2.0", `<dc:title>T</dc:title>`,
			epubEdit{Title: "T", Creator: "Di"},
			`<dc:title>T</dc:title>
  <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Di</dc:creator>
</metadata>`},
		{"a sort key, stale", "2.0", `<dc:title>T</dc:title><dc:creator opf:file-as="Author, Ann" opf:role="aut">Ann Author</dc:creator>` +
			`<meta name="calibre:title_sort" content="T"/>`,
			epubEdit{Title: "U", Creator: "Eve"},
			`<dc:title>U</dc:title><dc:creator opf:role="aut">Eve</dc:creator>`},
		{"EPUB 3's refinements", "3.0", `<dc:title id="t">T</dc:title><meta refines="#t" property="title-type">main</meta>` +
			`<dc:creator id="c">Ann</dc:creator><meta refines="#c" property="file-as">Ann, A</meta>` +
			`<meta refines="#c" property="role" scheme="marc:relators">aut</meta><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta>`,
			epubEdit{Title: "T", Creator: "Fay"},
			`<dc:title id="t">T</dc:title><meta refines="#t" property="title-type">main</meta>` +
				`<dc:creator id="c">Fay</dc:creator>` +
				`<meta refines="#c" property="role" scheme="marc:relators">aut</meta><meta property="dcterms:modified">2026-11-04T09:30:00Z</meta>`},
		{"the author, gone", "3.0", `<dc:title>T</dc:title><dc:creator id="c">Ann</dc:creator><meta refines="#c" property="role">aut</meta><dc:creator>Two</dc:creator>`,
			epubEdit{Title: "T", Creator: ""},
			`<dc:title>T</dc:title><dc:creator>Two</dc:creator>`},
		{"prefixed otherwise", "2.0", `<d:title xmlns:d="http://purl.org/dc/elements/1.1/">T</d:title>`,
			epubEdit{Title: "T", Creator: "Gus"},
			`<d:title xmlns:d="http://purl.org/dc/elements/1.1/">T</d:title>
  <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Gus</dc:creator>
</metadata>`},
	} {
		t.Run(c.name, func(t *testing.T) {
			opf := editOPF(c.version, c.metadata, "")
			z, got := edited(t, makeEpub(t, editBookFiles(opf)...), c.edit, nil)
			if !strings.Contains(got, c.want) {
				t.Errorf("got\n%s\nwant\n%s", got, c.want)
			}
			// All but the metadata, as it was.
			if a, b := got[:strings.Index(got, "<metadata")], opf[:strings.Index(opf, "<metadata")]; a != b {
				t.Errorf("before the metadata:\n%s", a)
			}
			if a, b := got[strings.Index(got, "<manifest>"):], opf[strings.Index(opf, "<manifest>"):]; a != b {
				t.Errorf("after the metadata:\n%s", a)
			}
			book, err := z.readBook()
			title, _ := epubDetail(c.edit.Title, "", false)
			if err != nil || book.Title != title {
				t.Errorf("read back: %+v, %v", book, err)
			}
		})
	}
}

func TestEpubEditRefused(t *testing.T) {
	plain := editOPF("3.0", `<dc:title>T</dc:title><dc:creator>A</dc:creator>`, "")
	for _, c := range []struct {
		name  string
		files []string
		edit  epubEdit
		want  string
	}{
		{"nothing changed", editBookFiles(plain), epubEdit{Title: " T ", Creator: "A"}, errEpubNoChange.Error()},
		{"no title", editBookFiles(plain), epubEdit{Title: "  ", Creator: "A"}, "the title can't be empty"},
		{"too long", editBookFiles(plain), epubEdit{Title: strings.Repeat("x", maxEpubDetail+1)}, "at most"},
		{"control characters", editBookFiles(plain), epubEdit{Title: "a\x00b"}, "can't be used"},
		{"not XML's", editBookFiles(plain), epubEdit{Title: "a\uffffb"}, "can't be used"},
		{"not XML's, the author", editBookFiles(plain), epubEdit{Title: "T", Creator: "a\ufffeb"}, "can't be used"},
		{"not UTF-8", editBookFiles(strings.Replace(plain, `encoding="UTF-8"`, `encoding="ISO-8859-1"`, 1)),
			epubEdit{Title: "U"}, "isn't in UTF-8"},
		{"DRM", editBookFiles(plain, "META-INF/license.lcpl", "{}"), epubEdit{Title: "U"}, errEpubProtected.Error()},
	} {
		var out bytes.Buffer
		err := openTestEpub(t, makeEpub(t, c.files...)).editBook(c.edit, nil, &out, editNow)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

func TestEpubEditCover(t *testing.T) {
	pngBytes, jpegBytes := testPicture(t, "png"), testPicture(t, "jpeg")
	t.Run("replaced", func(t *testing.T) {
		opf := editOPF("3.0", `<dc:title>T</dc:title>`,
			`<item id="img" href="images/cover.png" media-type="image/png" properties="cover-image"/>`)
		z, got := edited(t, makeEpub(t, editBookFiles(opf, "OEBPS/images/cover.png", "old")...),
			epubEdit{Title: "T", Cover: true}, pngBytes, "OEBPS/images/cover.png")
		if b, _ := z.read("OEBPS/images/cover.png", maxEpubPicture); !bytes.Equal(b, pngBytes) {
			t.Error("the cover wasn't replaced")
		}
		if got != opf {
			t.Errorf("the OPF changed:\n%s", got)
		}
		var out bytes.Buffer
		err := openTestEpub(t, makeEpub(t, editBookFiles(opf, "OEBPS/images/cover.png", "old")...)).
			editBook(epubEdit{Title: "T", Cover: true}, jpegBytes, &out, editNow)
		if err == nil || !strings.Contains(err.Error(), "must be a PNG picture") {
			t.Errorf("a JPEG for a PNG cover: %v", err)
		}
	})
	t.Run("named by EPUB 2's meta", func(t *testing.T) {
		opf := editOPF("2.0", `<dc:title>T</dc:title><meta name="cover" content="img"/>`,
			`<item id="img" href="images/c.jpg" media-type="image/jpeg"/>`)
		z, _ := edited(t, makeEpub(t, editBookFiles(opf, "OEBPS/images/c.jpg", "old")...),
			epubEdit{Title: "T", Cover: true}, jpegBytes, "OEBPS/images/c.jpg")
		if b, _ := z.read("OEBPS/images/c.jpg", maxEpubPicture); !bytes.Equal(b, jpegBytes) {
			t.Error("the cover wasn't replaced")
		}
	})
	for _, version := range []string{"3.0", "2.0"} {
		t.Run("added, EPUB "+version, func(t *testing.T) {
			// A cover.png that isn't the cover, and a <meta name="cover">
			// naming nothing: neither is taken for it.
			opf := editOPF(version, `<dc:title>T</dc:title><meta name="cover" content="gone"/>`,
				`<item id="cover-image" href="cover.png" media-type="image/png"/>`)
			z, got := edited(t, makeEpub(t, editBookFiles(opf, "OEBPS/cover.png", "another picture")...),
				epubEdit{Title: "T", Cover: true}, pngBytes)
			book, err := z.readBook()
			if err != nil || book.Cover != "OEBPS/cover-2.png" {
				t.Fatalf("%+v, %v\n%s", book, err, got)
			}
			if b, _ := z.read("OEBPS/cover-2.png", maxEpubPicture); !bytes.Equal(b, pngBytes) {
				t.Error("the cover isn't in it")
			}
			if b, _ := z.read("OEBPS/cover.png", maxEpubPicture); string(b) != "another picture" {
				t.Error("the other cover.png changed")
			}
			hasProperties := strings.Contains(got, `properties="cover-image"`)
			if hasProperties != (version == "3.0") || strings.Contains(got, `content="gone"`) ||
				!strings.Contains(got, `<meta name="cover" content="cover-image-2"/>`) {
				t.Errorf("EPUB %s:\n%s", version, got)
			}
		})
	}
	t.Run("added, not a picture that can be", func(t *testing.T) {
		var out bytes.Buffer
		err := openTestEpub(t, makeEpub(t, editBookFiles(editOPF("3.0", `<dc:title>T</dc:title>`, ""))...)).
			editBook(epubEdit{Title: "T", Cover: true}, []byte("GIF89a......"), &out, editNow)
		if err == nil || !strings.Contains(err.Error(), "JPEG, PNG or WebP") {
			t.Errorf("a GIF: %v", err)
		}
	})
}

// TestEpubEditTunnel edits a book as the page does, through the tunnel and
// the child: replaced in one step, keeping its permissions, and refused,
// leaving it as it was, if it's changed since; either way, nothing left
// behind.
func TestEpubEditTunnel(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "book.epub")
	book := makeEpub(t, editBookFiles(editOPF("3.0", `<dc:title>Old</dc:title><dc:creator>Ann</dc:creator>`, ""))...)
	os.WriteFile(file, book, 0o640)
	st, _ := os.Stat(file)
	cover := testPicture(t, "jpeg")
	edit := func(req tunnelRequest, data []byte) map[string]any {
		tc := openSession(t, ctx, srv.URL, s)
		req.Type, req.Path, req.Size = "epub-edit", "book.epub", int64(len(data))
		if r := tc.request(t, ctx, req); r["ok"] != true {
			return r
		}
		for at := 0; at < len(data); at += 1000 {
			tc.write(ctx, msgData, data[at:min(at+1000, len(data))])
		}
		var r map[string]any
		_, p, err := tc.read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		json.Unmarshal(p, &r)
		return r
	}
	leftovers := func() {
		t.Helper()
		if des, _ := os.ReadDir(g.downloadsDir); len(des) != 1 {
			t.Errorf("left in the folder: %v", des)
		}
	}
	r := edit(tunnelRequest{IfMtime: "1", IfSize: int64(len(book)), Title: "New"}, nil)
	if r["error"] != errEpubChanged.Error() {
		t.Errorf("changed since: %v", r)
	}
	r = edit(tunnelRequest{IfMtime: fileVersion(st), IfSize: int64(len(book)), Title: "Old", Creator: "Ann"}, nil)
	if r["error"] != errEpubNoChange.Error() {
		t.Errorf("no change: %v", r)
	}
	if b, _ := os.ReadFile(file); !bytes.Equal(b, book) {
		t.Error("the book changed when it shouldn't have")
	}
	leftovers()
	// Changed while the edit was being written: left as it was then.
	epubEditCopied = func() { os.WriteFile(file, []byte("changed meanwhile"), 0o640) }
	r = edit(tunnelRequest{IfMtime: fileVersion(st), IfSize: int64(len(book)), Title: "New"}, nil)
	epubEditCopied = func() {}
	if b, _ := os.ReadFile(file); r["error"] != errEpubChanged.Error() || string(b) != "changed meanwhile" {
		t.Errorf("changed meanwhile: %v, %q", r, b)
	}
	leftovers()
	os.WriteFile(file, book, 0o640)
	os.Chtimes(file, st.ModTime(), st.ModTime())
	st, _ = os.Stat(file)

	r = edit(tunnelRequest{IfMtime: fileVersion(st), IfSize: int64(len(book)), Title: "New", Creator: "Bea"}, cover)
	b, _ := json.Marshal(r["book"])
	var got epubBook
	json.Unmarshal(b, &got)
	if got.Title != "New" || got.Creator != "Bea" || got.Cover != "OEBPS/cover.jpg" {
		t.Fatalf("%v", r)
	}
	st2, _ := os.Stat(file)
	if r["mtime"] != fileVersion(st2) || r["size"] != float64(st2.Size()) || st2.Mode().Perm() != 0o640 {
		t.Errorf("%v; the file is %v, %d bytes", r, st2.Mode(), st2.Size())
	}
	leftovers()
	// Read again, its new cover's there.
	tc := openSession(t, ctx, srv.URL, s)
	if r := tc.request(t, ctx, tunnelRequest{Type: "epub", Path: "book.epub", Item: "OEBPS/cover.jpg"}); r["mime"] != "image/jpeg" {
		t.Errorf("the cover: %v", r)
	}
}

// TestEpubEditCoverNamedMissing: a book whose manifest names a cover that
// isn't in it is given one there, not another named beside it, which
// readers, taking the first, wouldn't see.
func TestEpubEditCoverNamedMissing(t *testing.T) {
	opf := editOPF("3.0", `<dc:title>T</dc:title>`, `<item id="img" href="images/cover.png" media-type="image/png" properties="cover-image"/>`)
	book := makeEpub(t, editBookFiles(opf)...)
	if b, _ := openTestEpub(t, book).readBook(); b.Cover != "OEBPS/images/cover.png" {
		t.Fatalf("named: %q", b.Cover)
	}
	png := testPicture(t, "png")
	z, got := edited(t, book, epubEdit{Title: "T", Cover: true}, png)
	if b, _ := z.read("OEBPS/images/cover.png", maxEpubPicture); !bytes.Equal(b, png) {
		t.Error("not put where it's named")
	}
	if got != opf {
		t.Errorf("the OPF changed:\n%s", got)
	}
	var out bytes.Buffer
	if err := openTestEpub(t, book).editBook(epubEdit{Title: "T", Cover: true}, testPicture(t, "jpeg"), &out, editNow); err == nil {
		t.Error("a JPEG put where a PNG is named")
	}
}

// TestEpubCoverFirstNamed: with two <meta name="cover">, the book is read,
// and its cover changed, as the first names it.
func TestEpubCoverFirstNamed(t *testing.T) {
	opf := editOPF("2.0", `<dc:title>T</dc:title><meta name="cover" content="one"/><meta name="cover" content="two"/>`,
		`<item id="one" href="one.png" media-type="image/png"/><item id="two" href="two.png" media-type="image/png"/>`)
	book := makeEpub(t, editBookFiles(opf, "OEBPS/one.png", "1", "OEBPS/two.png", "2")...)
	if b, _ := openTestEpub(t, book).readBook(); b.Cover != "OEBPS/one.png" {
		t.Errorf("read as %q", b.Cover)
	}
	png := testPicture(t, "png")
	z, _ := edited(t, book, epubEdit{Title: "T", Cover: true}, png, "OEBPS/one.png")
	one, _ := z.read("OEBPS/one.png", maxEpubPicture)
	two, _ := z.read("OEBPS/two.png", maxEpubPicture)
	if !bytes.Equal(one, png) || string(two) != "2" {
		t.Errorf("one %d bytes, two %q", len(one), two)
	}
}

// TestEditSymlinkRefused: a link to a file, saved over from the editor or
// its book's details changed, is refused, the link and its file kept, not
// the link replaced by a file of its own.
func TestEditSymlinkRefused(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	os.Mkdir(filepath.Join(g.downloadsDir, "real"), 0o755)
	real := filepath.Join(g.downloadsDir, "real", "notes.md")
	os.WriteFile(real, []byte("old"), 0o644)
	os.Symlink("real/notes.md", filepath.Join(g.downloadsDir, "notes.md"))
	st, _ := os.Stat(real)
	tc := openSession(t, ctx, srv.URL, s)
	if r := tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "notes.md", Size: 3, Replace: true, IfMtime: fileVersion(st), IfSize: 3}); r["ok"] == true {
		tc.write(ctx, msgData, []byte("new"))
		tc.read(ctx)
		if res := tc.readJSON(t, ctx); res["error"] != errReplaceLink.Error() {
			t.Errorf("saved over the link: %v", res)
		}
	} else if r["error"] != errReplaceLink.Error() {
		t.Errorf("%v", r)
	}
	if fi, err := os.Lstat(filepath.Join(g.downloadsDir, "notes.md")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Error("the link was replaced")
	}
	if b, _ := os.ReadFile(real); string(b) != "old" {
		t.Errorf("real/notes.md holds %q", b)
	}
	// A book, through a link.
	book := makeEpub(t, editBookFiles(editOPF("3.0", `<dc:title>Old</dc:title>`, ""))...)
	os.WriteFile(filepath.Join(g.downloadsDir, "real", "b.epub"), book, 0o644)
	os.Symlink("real/b.epub", filepath.Join(g.downloadsDir, "b.epub"))
	bst, _ := os.Stat(filepath.Join(g.downloadsDir, "real", "b.epub"))
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "epub-edit", Path: "b.epub", Title: "New",
		IfMtime: fileVersion(bst), IfSize: bst.Size()}); r["error"] != errReplaceLink.Error() {
		t.Errorf("a book through a link: %v", r)
	}
}

// TestEpubEditOneCover: a book marking more than one picture as its cover,
// given a new one, has one cover: the new picture, where the first was;
// the others not marked (but kept, as the book may show them).
func TestEpubEditOneCover(t *testing.T) {
	for _, version := range []string{"3.0", "2.0"} {
		t.Run("EPUB "+version, func(t *testing.T) {
			opf := editOPF(version, `<dc:title>T</dc:title><meta name="cover" content="b"/><meta name="cover" content="a"/>`,
				`<item id="a" href="a.png" media-type="image/png" properties="cover-image"/>`+
					`<item id="b" href="b.png" media-type="image/png" properties="scripted cover-image"/>`+
					`<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>`)
			if version == "2.0" {
				opf = strings.ReplaceAll(strings.ReplaceAll(opf, ` properties="scripted cover-image"`, ""), ` properties="cover-image"`, "")
			}
			book := makeEpub(t, editBookFiles(opf, "OEBPS/a.png", "A", "OEBPS/b.png", "B", "OEBPS/c.png", "C")...)
			first := "OEBPS/a.png" // EPUB 3: the first marked; EPUB 2: the first meta's
			if version == "2.0" {
				first = "OEBPS/b.png"
			}
			png := testPicture(t, "png")
			z, got := edited(t, book, epubEdit{Title: "T", Cover: true}, png, first)
			b, err := z.readBook()
			if err != nil || b.Cover != first {
				t.Fatalf("the cover: %+v %v\n%s", b, err, got)
			}
			if c, _ := z.read(first, maxEpubPicture); !bytes.Equal(c, png) {
				t.Error("the new picture isn't where the cover was")
			}
			for _, name := range []string{"a", "b", "c"} {
				if "OEBPS/"+name+".png" != first {
					if c, _ := z.read("OEBPS/"+name+".png", maxEpubPicture); string(c) != strings.ToUpper(name) {
						t.Errorf("%s.png: %q", name, c)
					}
				}
			}
			if n := strings.Count(got, "cover-image"); version == "3.0" && n != 1 || version == "2.0" && n != 0 {
				t.Errorf("%d marked as the cover:\n%s", n, got)
			}
			id := strings.TrimSuffix(strings.TrimPrefix(first, "OEBPS/"), ".png")
			if strings.Count(got, `name="cover"`) != 1 || !strings.Contains(got, `<meta name="cover" content="`+id+`"/>`) {
				t.Errorf("the meta:\n%s", got)
			}
			if version == "3.0" && !strings.Contains(got, `<item id="b" href="b.png" media-type="image/png" properties="scripted"/>`) {
				t.Errorf("b's other properties:\n%s", got)
			}
		})
	}
}
