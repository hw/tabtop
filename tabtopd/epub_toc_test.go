package main

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

func TestBuildTOCFromSpine(t *testing.T) {
	ch1 := `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 id="t">Title One</h1><p>x</p><h2 id="a">Section A</h2><h3 id="a1">Detail</h3><h2>Section B</h2><h2 id="bad id">Invalid anchor</h2>
</body></html>`
	ch2 := `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>no headings</p></body></html>`
	opf := `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/plain_chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`
	z := openTestEpub(t, makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
		"OEBPS/text/ch1.xhtml", ch1, "OEBPS/text/plain_chapter.xhtml", ch2))
	got, err := z.buildTOCFromSpine()
	if err != nil {
		t.Fatal(err)
	}
	want := []epubTOCItem{
		{"Title One", "OEBPS/text/ch1.xhtml", "t", 1},
		{"Section A", "OEBPS/text/ch1.xhtml", "a", 2},
		{"Detail", "OEBPS/text/ch1.xhtml", "a1", 3},
		{"plain chapter", "OEBPS/text/plain_chapter.xhtml", "", 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestEpubEditRegenerateTOC(t *testing.T) {
	ch1 := `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="one">Alpha</h1><h2 id="sub">Beta</h2></body></html>`
	ch2 := `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Gamma</h1></body></html>`

	t.Run("no toc: nav created", func(t *testing.T) {
		opf := editOPF("3.0", `<dc:title>T</dc:title><dc:creator>A</dc:creator>`,
			`<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>`)
		opf = strings.Replace(opf, `<spine><itemref idref="c1"/></spine>`,
			`<spine><itemref idref="c1"/><itemref idref="c2"/></spine>`, 1)
		book := makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
			"OEBPS/text/ch1.xhtml", ch1, "OEBPS/text/ch2.xhtml", ch2, "odd//name.txt", "kept")
		z, got := edited(t, book, epubEdit{Title: "T", Creator: "A", RegenerateTOC: true}, nil)
		if !strings.Contains(got, `properties="nav"`) || !strings.Contains(got, `href="nav.xhtml"`) {
			t.Fatalf("OPF missing nav:\n%s", got)
		}
		nav, err := z.read("OEBPS/nav.xhtml", maxEpubMeta)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{`epub:type="toc"`, `href="text/ch1.xhtml#one"`, `>Alpha</a>`, `href="text/ch1.xhtml#sub"`, `>Beta</a>`,
			`href="text/ch2.xhtml"`, `>ch2</a>`} {
			if !strings.Contains(string(nav), want) {
				t.Errorf("nav missing %q in\n%s", want, nav)
			}
		}
		rb, err := z.readBook()
		if err != nil || len(rb.TOC) != 3 || rb.TOC[0].Label != "Alpha" || rb.TOC[0].Frag != "b-one" ||
			rb.TOC[1].Label != "Beta" || rb.TOC[1].Frag != "b-sub" || rb.TOC[2].Label != "ch2" {
			t.Fatalf("read back TOC: %+v, %v", rb.TOC, err)
		}
	})

	t.Run("existing nav replaced", func(t *testing.T) {
		oldNav := `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="text/ch1.xhtml">Start</a></li></ol></nav>
<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Old Label</a></li></ol></nav>
<nav epub:type="page-list"><ol><li><a href="text/ch1.xhtml#one">1</a></li></ol></nav>
</body></html>`
		opf := editOPF("3.0", `<dc:title>T</dc:title>`,
			`<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`)
		book := makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
			"OEBPS/text/ch1.xhtml", ch1, "OEBPS/nav.xhtml", oldNav, "odd//name.txt", "kept")
		z, _ := edited(t, book, epubEdit{Title: "T", RegenerateTOC: true}, nil, "OEBPS/nav.xhtml")
		rb, err := z.readBook()
		if err != nil || len(rb.TOC) != 2 || rb.TOC[0].Label != "Alpha" || rb.TOC[0].Label == "Old Label" {
			t.Fatalf("read back TOC: %+v, %v", rb.TOC, err)
		}
		nav, _ := z.read("OEBPS/nav.xhtml", maxEpubMeta)
		s := string(nav)
		if strings.Contains(s, "Old Label") {
			t.Fatalf("old toc kept:\n%s", s)
		}
		if !strings.Contains(s, `epub:type="landmarks"`) || !strings.Contains(s, "Start") ||
			!strings.Contains(s, `epub:type="page-list"`) || !strings.Contains(s, ">1</a>") {
			t.Fatalf("landmarks/page-list lost:\n%s", s)
		}
	})

	t.Run("missing nav file written", func(t *testing.T) {
		opf := editOPF("3.0", `<dc:title>T</dc:title>`,
			`<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`)
		book := makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
			"OEBPS/text/ch1.xhtml", ch1, "odd//name.txt", "kept")
		z, _ := edited(t, book, epubEdit{Title: "T", RegenerateTOC: true}, nil)
		nav, err := z.read("OEBPS/nav.xhtml", maxEpubMeta)
		if err != nil || !strings.Contains(string(nav), "Alpha") {
			t.Fatalf("missing nav not written: %v\n%s", err, nav)
		}
		rb, err := z.readBook()
		if err != nil || len(rb.TOC) < 1 || rb.TOC[0].Label != "Alpha" {
			t.Fatalf("read back TOC: %+v, %v", rb.TOC, err)
		}
	})

	t.Run("untitled book", func(t *testing.T) {
		opf := editOPF("3.0", `<dc:creator>A</dc:creator>`, "")
		book := makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
			"OEBPS/text/ch1.xhtml", ch1, "odd//name.txt", "kept")
		z, got := edited(t, book, epubEdit{RegenerateTOC: true}, nil)
		if strings.Contains(got, "dc:title") {
			t.Fatalf("title inserted into untitled book:\n%s", got)
		}
		rb, err := z.readBook()
		if err != nil || rb.Title != "" || rb.Creator != "A" || len(rb.TOC) < 1 || rb.TOC[0].Label != "Alpha" {
			t.Fatalf("read back: %+v, %v", rb, err)
		}
	})

	t.Run("ncx only rewritten", func(t *testing.T) {
		oldNCX := `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head/><docTitle><text>Keep Me</text></docTitle><docAuthor><text>Ann</text></docAuthor>
<navMap><navPoint id="p1"><navLabel><text>Stale</text></navLabel><content src="text/ch1.xhtml"/></navPoint></navMap></ncx>`
		opf := `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>`
		book := makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
			"OEBPS/text/ch1.xhtml", ch1, "OEBPS/toc.ncx", oldNCX, "odd//name.txt", "kept")
		z, got := edited(t, book, epubEdit{Title: "T", RegenerateTOC: true}, nil, "OEBPS/toc.ncx")
		if !strings.Contains(got, `properties="nav"`) {
			t.Fatalf("expected a nav to be added:\n%s", got)
		}
		ncx, err := z.read("OEBPS/toc.ncx", maxEpubMeta)
		if err != nil {
			t.Fatal(err)
		}
		s := string(ncx)
		if !strings.Contains(s, "Keep Me") || !strings.Contains(s, "<text>Ann</text>") {
			t.Fatalf("docTitle/docAuthor lost:\n%s", s)
		}
		if strings.Contains(s, "Stale") || !strings.Contains(s, "Alpha") {
			t.Fatalf("navMap not rebuilt:\n%s", s)
		}
		rb, err := z.readBook()
		// Nav preferred over NCX once both exist.
		if err != nil || len(rb.TOC) < 1 || rb.TOC[0].Label != "Alpha" {
			t.Fatalf("read back TOC: %+v, %v", rb.TOC, err)
		}
	})

	t.Run("nav and ncx both updated", func(t *testing.T) {
		oldNav := `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Old</a></li></ol></nav></body></html>`
		oldNCX := `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head/><docTitle><text>Book</text></docTitle>
<navMap><navPoint id="p1"><navLabel><text>Old NCX</text></navLabel><content src="text/ch1.xhtml"/></navPoint></navMap></ncx>`
		opf := editOPF("3.0", `<dc:title>T</dc:title>`,
			`<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`+
				`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`)
		opf = strings.Replace(opf, `<spine>`, `<spine toc="ncx">`, 1)
		book := makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
			"OEBPS/text/ch1.xhtml", ch1, "OEBPS/nav.xhtml", oldNav, "OEBPS/toc.ncx", oldNCX, "odd//name.txt", "kept")
		z, _ := edited(t, book, epubEdit{Title: "T", RegenerateTOC: true}, nil, "OEBPS/nav.xhtml", "OEBPS/toc.ncx")
		nav, _ := z.read("OEBPS/nav.xhtml", maxEpubMeta)
		ncx, _ := z.read("OEBPS/toc.ncx", maxEpubMeta)
		if strings.Contains(string(nav), "Old") || !strings.Contains(string(nav), "Alpha") {
			t.Fatalf("nav: %s", nav)
		}
		if strings.Contains(string(ncx), "Old NCX") || !strings.Contains(string(ncx), "Alpha") {
			t.Fatalf("ncx: %s", ncx)
		}
	})

	t.Run("DRM refused", func(t *testing.T) {
		opf := editOPF("3.0", `<dc:title>T</dc:title>`, "")
		var out bytes.Buffer
		err := openTestEpub(t, makeEpub(t, editBookFiles(opf, "META-INF/license.lcpl", "{}")...)).
			editBook(epubEdit{Title: "T", RegenerateTOC: true}, nil, &out, editNow)
		if err == nil || err.Error() != errEpubProtected.Error() {
			t.Fatalf("got %v", err)
		}
	})
}

func TestEpubHrefAndFilenameLabel(t *testing.T) {
	if got := epubHref("OEBPS/nav.xhtml", "OEBPS/text/ch 2.xhtml", "sec"); got != "text/ch%202.xhtml#sec" {
		t.Errorf("href: %q", got)
	}
	if got := epubHref("OEBPS/nav/toc.xhtml", "OEBPS/text/ch1.xhtml", ""); got != "../text/ch1.xhtml" {
		t.Errorf("nested href: %q", got)
	}
	if got := tocFilenameLabel("OEBPS/text/plain_chapter.xhtml"); got != "plain chapter" {
		t.Errorf("label: %q", got)
	}
}


