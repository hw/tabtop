package main

import (
	"bytes"
	"slices"
	"strings"
	"testing"
)

// trimBook is a book with a cover, a cover page showing it, a chapter
// showing one picture, a stylesheet using another, a script naming a
// third, and one picture nothing uses (refined by a meta).
func trimBook(t *testing.T, version string) []byte {
	t.Helper()
	opf := editOPF(version, `<dc:title>T</dc:title><meta name="cover" content="cov"/><meta refines="#spare" property="role">x</meta>`,
		`<item id="cov" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`+
			`<item id="cp" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`+
			`<item id="fig" href="images/fig.png" media-type="image/png"/>`+
			`<item id="bg" href="images/bg%20one.png" media-type="image/png"/>`+
			`<item id="named" href="images/named.png" media-type="image/png"/>`+
			`<item id="spare" href="images/spare.png" media-type="image/png"/>`+
			`<item id="css" href="style.css" media-type="text/css"/><item id="js" href="app.js" media-type="text/javascript"/>`)
	if version == "2.0" {
		opf = strings.ReplaceAll(opf, ` properties="cover-image"`, "")
	}
	return makeEpub(t, "META-INF/container.xml", testContainer, "OEBPS/content.opf", opf,
		"OEBPS/text/ch1.xhtml", `<html><body><p>Words and more words.</p><img src="../images/fig.png" alt=""/></body></html>`,
		"OEBPS/text/cover.xhtml", `<html><head><title>Cover</title></head><body><div><img src="../cover.jpg" alt="Cover"/></div></body></html>`,
		"OEBPS/style.css", `body { background: url("images/bg%20one.png") }`,
		"OEBPS/app.js", `show("named.png")`,
		"OEBPS/cover.jpg", string(testPicture(t, "jpeg")),
		"OEBPS/images/fig.png", "F", "OEBPS/images/bg one.png", "B", "OEBPS/images/named.png", "N", "OEBPS/images/spare.png", "S")
}

func TestEpubPictureUses(t *testing.T) {
	uses, err := openTestEpub(t, trimBook(t, "3.0")).pictureReport()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]epubPictureUse{}
	for _, u := range uses {
		got[u.Path] = u
	}
	want := map[string][]string{
		"OEBPS/cover.jpg":         {"OEBPS/text/cover.xhtml"},
		"OEBPS/images/fig.png":    {"OEBPS/text/ch1.xhtml"},
		"OEBPS/images/bg one.png": {"OEBPS/style.css"},
		"OEBPS/images/named.png":  {"OEBPS/app.js"},
		"OEBPS/images/spare.png":  nil,
	}
	if len(got) != len(want) {
		t.Fatalf("pictures: %+v", uses)
	}
	for p, users := range want {
		if !slices.Equal(got[p].Users, users) || got[p].Bytes <= 0 {
			t.Errorf("%s: %+v, want users %v", p, got[p], users)
		}
	}
	if c := got["OEBPS/cover.jpg"]; !c.Cover || !slices.Equal(c.CoverPages, []string{"OEBPS/text/cover.xhtml"}) {
		t.Errorf("the cover: %+v", c)
	}
	if len(got["OEBPS/images/fig.png"].CoverPages) != 0 {
		t.Error("a chapter taken for a cover page")
	}
}

// trimmed edits book with e, and returns the book made and its OPF.
func trimmed(t *testing.T, book []byte, e epubEdit, cover []byte) (*epubZip, string) {
	t.Helper()
	var out bytes.Buffer
	if err := openTestEpub(t, book).editBook(e, cover, &out, editNow); err != nil {
		t.Fatal(err)
	}
	z := openTestEpub(t, out.Bytes())
	opf, err := z.read("OEBPS/content.opf", maxEpubMeta)
	if err != nil {
		t.Fatal(err)
	}
	return z, string(opf)
}

func TestEpubRemoveUnused(t *testing.T) {
	book := trimBook(t, "3.0")
	z, opf := trimmed(t, book, epubEdit{Title: "T", RemoveItems: []string{"OEBPS/images/spare.png"}}, nil)
	if z.files["OEBPS/images/spare.png"] != nil || strings.Contains(opf, "spare") {
		t.Errorf("not removed:\n%s", opf)
	}
	for _, kept := range []string{"OEBPS/cover.jpg", "OEBPS/images/fig.png", "OEBPS/images/bg one.png", "OEBPS/images/named.png", "OEBPS/text/cover.xhtml"} {
		if z.files[kept] == nil {
			t.Errorf("%s went too", kept)
		}
	}
	if b, err := z.readBook(); err != nil || b.Cover != "OEBPS/cover.jpg" {
		t.Errorf("the book: %+v %v", b, err)
	}
	for item, want := range map[string]string{
		"OEBPS/images/fig.png":    "text/ch1.xhtml uses it",
		"OEBPS/images/bg one.png": "style.css uses it",
		"OEBPS/images/named.png":  "app.js uses it",
		"OEBPS/cover.jpg":         "cover can't be removed",
		"OEBPS/text/ch1.xhtml":    "isn't a picture",
	} {
		var out bytes.Buffer
		err := openTestEpub(t, book).editBook(epubEdit{Title: "T", RemoveItems: []string{item}}, nil, &out, editNow)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", item, err)
		}
	}
}

// TestEpubRemoveOldCover: with a new cover, from outside the book or in
// it, the cover page shows it, and the old cover can go.
func TestEpubRemoveOldCover(t *testing.T) {
	for _, version := range []string{"3.0", "2.0"} {
		book := trimBook(t, version)
		png := testPicture(t, "png")
		for name, c := range map[string]struct {
			e     epubEdit
			cover []byte
			want  string
			ref   string
		}{
			"added":   {epubEdit{Title: "T", Cover: true}, png, "OEBPS/images/cover.png", `src="../images/cover.png"`},
			"in book": {epubEdit{Title: "T", CoverItem: "OEBPS/images/spare.png"}, nil, "OEBPS/images/spare.png", `src="../images/spare.png"`},
		} {
			t.Run(version+" "+name, func(t *testing.T) {
				c.e.RemoveItems = []string{"OEBPS/cover.jpg"}
				z, opf := trimmed(t, book, c.e, c.cover)
				if b, err := z.readBook(); err != nil || b.Cover != c.want {
					t.Fatalf("the cover: %+v %v\n%s", b, err, opf)
				}
				if z.files["OEBPS/cover.jpg"] != nil || strings.Contains(opf, "cover.jpg") || strings.Contains(opf, `"cov"`) {
					t.Errorf("the old cover stayed:\n%s", opf)
				}
				page, _ := z.read("OEBPS/text/cover.xhtml", maxEpubChapter)
				if !strings.Contains(string(page), c.ref) || !strings.Contains(string(page), `alt="Cover"`) {
					t.Errorf("the cover page: %s", page)
				}
			})
		}
	}
}

// TestEpubRemoveOldCoverSameName: the old cover, OEBPS/cover.png, and the
// new one, OEBPS/images/cover.png, share a name: the cover page, naming
// only the new one, doesn't keep the old one.
func TestEpubRemoveOldCoverSameName(t *testing.T) {
	opf := editOPF("3.0", `<dc:title>T</dc:title>`,
		`<item id="cov" href="cover.png" media-type="image/png" properties="cover-image"/><item id="cp" href="cp.xhtml" media-type="application/xhtml+xml"/>`)
	book := makeEpub(t, editBookFiles(opf, "OEBPS/cover.png", "old", "OEBPS/cp.xhtml", `<html><body><img src="cover.png"/></body></html>`)...)
	z, _ := trimmed(t, book, epubEdit{Title: "T", Cover: true, RemoveItems: []string{"OEBPS/cover.png"}}, testPicture(t, "png"))
	page, _ := z.read("OEBPS/cp.xhtml", maxEpubChapter)
	if z.files["OEBPS/cover.png"] != nil || string(page) != `<html><body><img src="images/cover.png"/></body></html>` {
		t.Errorf("the old cover: %v; the page: %s", z.files["OEBPS/cover.png"] != nil, page)
	}
}

func TestRelativeRef(t *testing.T) {
	for _, c := range [][3]string{
		{"OEBPS/text", "OEBPS/images/a b.png", "../images/a%20b.png"},
		{"OEBPS", "OEBPS/images/c.png", "images/c.png"},
		{".", "images/c.png", "images/c.png"},
		{"OEBPS/text", "c.png", "../../c.png"},
	} {
		if got := relativeRef(c[0], c[1]); got != c[2] {
			t.Errorf("%s -> %s: %s, want %s", c[0], c[1], got, c[2])
		}
	}
}

// TestEpubCoverPages: a short chapter whose only picture is the cover
// isn't a cover page (repointing it would change the chapter); a page the
// guide marks as the cover is, text and all, as is one with no text.
func TestEpubCoverPages(t *testing.T) {
	opf := editOPF("3.0", `<dc:title>T</dc:title>`,
		`<item id="cov" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`+
			`<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>`+
			`<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`+
			`<item id="d" href="d.xhtml" media-type="application/xhtml+xml"/><item id="plate" href="plate.png" media-type="image/png"/>`)
	opf = strings.Replace(opf, "</package>", `<guide><reference type="cover" href="b.xhtml" title="Cover"/></guide></package>`, 1)
	book := makeEpub(t, editBookFiles(opf, "OEBPS/cover.jpg", "J",
		"OEBPS/a.xhtml", `<html><body><p>The first chapter's text, short.</p><img src="cover.jpg"/></body></html>`,
		"OEBPS/b.xhtml", `<html><body><h1>The Title of the Book, Overlaid</h1><img src="cover.jpg"/></body></html>`,
		"OEBPS/c.xhtml", `<html><body><img src="cover.jpg" alt="The cover"/></body></html>`,
		"OEBPS/d.xhtml", `<html><body><img src="plate.png"/></body></html>`, "OEBPS/plate.png", "P")...)
	uses, err := openTestEpub(t, book).pictureReport()
	if err != nil || len(uses) != 2 {
		t.Fatalf("%+v %v", uses, err)
	}
	// A page that's only an illustration, unmarked, isn't a cover page.
	if plate := uses[1]; plate.Path != "OEBPS/plate.png" || len(plate.CoverPages) != 0 || !slices.Equal(plate.Users, []string{"OEBPS/d.xhtml"}) {
		t.Errorf("the plate: %+v", plate)
	}
	if got := uses[0]; !slices.Equal(got.Users, []string{"OEBPS/a.xhtml", "OEBPS/b.xhtml", "OEBPS/c.xhtml"}) ||
		!slices.Equal(got.CoverPages, []string{"OEBPS/b.xhtml", "OEBPS/c.xhtml"}) {
		t.Errorf("%+v", got)
	}
}

// TestEpubFormerCoverPage: a cover page the book marks as one, left showing
// a former cover when the cover changed (before cover pages were made to
// follow it): that picture is offered, and removing it makes the page show
// the cover. Without a cover, it stays.
func TestEpubFormerCoverPage(t *testing.T) {
	for name, mark := range map[string][2]string{
		"guide":     {`<guide><reference type="cover" title="Cover Image" href="xhtml/cover.xhtml"/></guide>`, `<body>`},
		"epub:type": {"", `<body class="cover" epub:type="cover">`},
	} {
		t.Run(name, func(t *testing.T) {
			opf := editOPF("3.0", `<dc:title>T</dc:title><meta name="cover" content="new"/>`,
				`<item id="cp" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>`+
					`<item id="old" href="images/9781718504455.jpg" media-type="image/jpeg"/>`+
					`<item id="new" href="images/cover-2.png" media-type="image/png" properties="cover-image"/>`)
			opf = strings.Replace(opf, "</package>", mark[0]+"</package>", 1)
			page := `<html xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Cover</title></head>` + mark[1] +
				`<div class="cover"><img src="../images/9781718504455.jpg" alt="Cover: The Book, by Its Author, with a long description"/></div></body></html>`
			png := testPicture(t, "png")
			book := makeEpub(t, editBookFiles(opf, "OEBPS/xhtml/cover.xhtml", page, "OEBPS/images/9781718504455.jpg", "J", "OEBPS/images/cover-2.png", string(png))...)
			uses, err := openTestEpub(t, book).pictureReport()
			if err != nil {
				t.Fatal(err)
			}
			old := uses[slices.IndexFunc(uses, func(u epubPictureUse) bool { return u.Path == "OEBPS/images/9781718504455.jpg" })]
			if old.Cover || !slices.Equal(old.CoverPages, []string{"OEBPS/xhtml/cover.xhtml"}) {
				t.Fatalf("the former cover: %+v", old)
			}
			z, opfAfter := trimmed(t, book, epubEdit{Title: "T", RemoveItems: []string{old.Path}}, nil)
			after, _ := z.read("OEBPS/xhtml/cover.xhtml", maxEpubChapter)
			if z.files[old.Path] != nil || strings.Contains(opfAfter, "9781718504455") || !strings.Contains(string(after), `src="../images/cover-2.png"`) {
				t.Errorf("the page: %s\n%s", after, opfAfter)
			}
		})
	}
	// No cover to show instead: the cover page keeps its picture.
	opf := editOPF("3.0", `<dc:title>T</dc:title>`, `<item id="cp" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="old" href="old.jpg" media-type="image/jpeg"/>`)
	book := makeEpub(t, editBookFiles(opf, "OEBPS/cover.xhtml", `<html><body epub:type="cover"><img src="old.jpg"/></body></html>`, "OEBPS/old.jpg", "J")...)
	var out bytes.Buffer
	if err := openTestEpub(t, book).editBook(epubEdit{Title: "T", RemoveItems: []string{"OEBPS/old.jpg"}}, nil, &out, editNow); err == nil || !strings.Contains(err.Error(), "cover.xhtml uses it") {
		t.Errorf("with no cover: %v", err)
	}
}

// TestEpubRemoveNamedByID: a picture the package file names by its ID (a
// spine entry, or another item's fallback) is used, though its item would
// be gone from the manifest.
func TestEpubRemoveNamedByID(t *testing.T) {
	for name, repl := range map[string][2]string{
		"spine":    {`<itemref idref="c1"/>`, `<itemref idref="c1"/><itemref idref="spare"/>`},
		"fallback": {`id="fig" href="images/fig.png"`, `id="fig" fallback="spare" href="images/fig.png"`},
	} {
		opf := strings.Replace(editOPF("3.0", `<dc:title>T</dc:title>`,
			`<item id="fig" href="images/fig.png" media-type="image/png"/><item id="spare" href="images/spare.png" media-type="image/png"/>`), repl[0], repl[1], 1)
		book := makeEpub(t, editBookFiles(opf, "OEBPS/images/fig.png", "F", "OEBPS/images/spare.png", "S",
			"OEBPS/text/ch1.xhtml", `<html><body><img src="../images/fig.png"/></body></html>`)...)
		var out bytes.Buffer
		err := openTestEpub(t, book).editBook(epubEdit{Title: "T2", RemoveItems: []string{"OEBPS/images/spare.png"}}, nil, &out, editNow)
		if err == nil || !strings.Contains(err.Error(), "content.opf uses it") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// TestEpubRemoveOldCoverMentioned: a cover page naming the old cover in a
// srcset and in its alt text: the srcset's made to show the new cover, the
// alt text left, and the old cover goes, with the other changes saved.
func TestEpubRemoveOldCoverMentioned(t *testing.T) {
	opf := editOPF("3.0", `<dc:title>T</dc:title>`,
		`<item id="cov" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/><item id="cp" href="cp.xhtml" media-type="application/xhtml+xml"/>`)
	book := makeEpub(t, editBookFiles(opf, "OEBPS/cover.jpg", "J",
		"OEBPS/cp.xhtml", `<html><body><img src="cover.jpg" srcset="cover.jpg 1x, cover.jpg 2x" alt="cover.jpg"/></body></html>`)...)
	z, opfAfter := trimmed(t, book, epubEdit{Title: "New title", Cover: true, RemoveItems: []string{"OEBPS/cover.jpg"}}, testPicture(t, "png"))
	page, _ := z.read("OEBPS/cp.xhtml", maxEpubChapter)
	want := `<html><body><img src="images/cover.png" srcset="images/cover.png 1x, images/cover.png 2x" alt="cover.jpg"/></body></html>`
	if z.files["OEBPS/cover.jpg"] != nil || string(page) != want || !strings.Contains(opfAfter, "New title") {
		t.Errorf("the page: %s\n%s", page, opfAfter)
	}
}

// TestRepointCoverAmpersand: a new cover named with an &, in a url(): as
// %26, so the page stays well-formed XHTML (and HTML reads it the same).
func TestRepointCoverAmpersand(t *testing.T) {
	page := `<html><body><div style="background:url(old.jpg)"></div><img src="old.jpg"/></body></html>`
	got, n := repointCover("OEBPS/cp.xhtml", []byte(page), "OEBPS/old.jpg", "OEBPS/a&b.jpg")
	want := `<html><body><div style="background:url(a%26b.jpg)"></div><img src="a&amp;b.jpg"/></body></html>`
	if string(got) != want || n != 2 {
		t.Errorf("%d: %s", n, got)
	}
	if p, _, ok := epubResolve("OEBPS/cp.xhtml", "a%26b.jpg"); !ok || p != "OEBPS/a&b.jpg" {
		t.Errorf("resolves to %q", p)
	}
}
