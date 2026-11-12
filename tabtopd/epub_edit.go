package main

// Editing a book's details: its title, its author (the first dc:creator;
// any others stay), its cover picture, and rebuilding its contents list
// from chapter headings (see editBook in preview.js), with the tunnel's
// "epub-edit" request.
//
// The book is rewritten whole, as a new file beside it, which then replaces
// it in one step, as the editor saves text (see tunnelUpload): every file in
// it copied as it is, compressed bytes and all (so mimetype stays first,
// stored, as EPUB needs), but for the package file (the OPF), the cover,
// and, when rebuilding contents, the nav (and NCX if the book has one).
// The OPF is changed in place, a few elements spliced, rather than
// rewritten from what an XML parser makes of it, which would lose its
// namespace prefixes and the rest of how it's written. A new cover is
// never written over the old one, which stays in the book: a picture from
// outside it is added as images/cover.jpg or .png beside the OPF (a JPEG
// or PNG, which the page makes it; see coverBytes in preview-editor.js),
// and one already in it is named the cover where it is; either way named
// in the manifest as EPUB 3 and EPUB 2 name one. A cover page (such as
// cover.xhtml) keeps showing the picture it shows.
// A book without a nav is given one beside its OPF when contents are rebuilt.
//
// As reading is, it's done in the child process (see readEpubIsolated),
// here with longer to do it in, as it copies the whole book. What it makes
// is read back, by another child, before it replaces the book.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"maps"
	"net/http"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"archive/zip"
)

// The longest title or author, in characters.
const maxEpubDetail = 500

// The most pictures one edit removes.
const (
	maxEpubRemove  = 2000
	maxEpubEditArg = 96 << 10 // the edit, as the child's argument (under MAX_ARG_STRLEN, 128 KiB)
)

var (
	errEpubNoChange  = errors.New("nothing was changed")
	errEpubBadOPF    = errors.New("its package file (the OPF) can't be changed here")
	errEpubEditBusy  = errors.New("another book is being changed; try again in a moment")
	epubEditSlots    = newPreviewWork(previewEditConcurrency)
	epubFileAsAttr   = regexp.MustCompile(`\s+(?:[A-Za-z_][\w.-]*:)?file-as\s*=\s*(?:"[^"]*"|'[^']*')`)
	epubXMLEncoding  = regexp.MustCompile(`^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']`)
	epubStaleRefines = map[string]bool{"file-as": true, "alternate-script": true}
)

// epubEdit is what's changed, as the child is told it: the title and the
// author, whether a new cover comes, on its file descriptor 3, or which
// picture already in the book is to be the cover, and whether to rebuild
// the contents list from the chapters' headings.
type epubEdit struct {
	Title     string `json:"title"`
	Creator   string `json:"creator"`
	Cover     bool   `json:"cover"`
	CoverItem string `json:"cover_item,omitempty"` // a picture in the book to name the cover, by its path in it
	// Pictures to remove, by their paths in the book; cover pages showing
	// one are first made to show the cover.
	RemoveItems   []string `json:"remove_items,omitempty"`
	RegenerateTOC bool     `json:"regenerate_toc,omitempty"`
}

// epubEditTimeout is how long rewriting a book of size bytes may take: two
// minutes, and a second more for each 10 MB.
func epubEditTimeout(size int64) time.Duration {
	return 2*time.Minute + time.Duration(size/(10<<20))*time.Second
}

// epubDetail is s as a title or author: its spaces made single, and
// checked.
func epubDetail(s, what string, required bool) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	switch {
	case s == "" && required:
		return "", fmt.Errorf("the %s can't be empty", what)
	case utf8.RuneCountInString(s) > maxEpubDetail:
		return "", fmt.Errorf("the %s can be at most %d characters", what, maxEpubDetail)
	case strings.IndexFunc(s, func(r rune) bool { return unicode.IsControl(r) || r == utf8.RuneError || !xmlChar(r) }) >= 0:
		return "", fmt.Errorf("the %s has characters that can't be used", what)
	}
	return s, nil
}

// xmlChar reports whether r can be in XML at all (its Char production):
// U+FFFE, U+FFFF and lone surrogates, say, can't.
func xmlChar(r rune) bool {
	return r == 0x9 || r == 0xA || r == 0xD || r >= 0x20 && r <= 0xD7FF || r >= 0xE000 && r <= 0xFFFD || r >= 0x10000 && r <= 0x10FFFF
}

// opfElement is an element of the OPF, where it is in it: its start tag
// from start to startEnd, and its end tag from endStart to end (for
// <a/>, both at startEnd).
type opfElement struct {
	name, local                    string // as written (dc:title), and without its prefix
	start, startEnd, endStart, end int
	self                           bool
	attrs                          map[string]string // by local name
	text                           strings.Builder
	href                           string // for a manifest's item, what it names, in the book
}

func (e *opfElement) value() string { return strings.Join(strings.Fields(e.text.String()), " ") }

// prefix is the namespace prefix e is written with, with its colon, or "".
func (e *opfElement) prefix() string {
	if i := strings.IndexByte(e.name, ':'); i >= 0 {
		return e.name[:i+1]
	}
	return ""
}

// opfScan is what editing needs of the OPF.
type opfScan struct {
	version            string
	metadata, manifest *opfElement
	title, creator     *opfElement   // the first of each
	metas              []*opfElement // the metadata's <meta>s
	items              map[string]epubManifestItem
	itemEls            []*opfElement // the manifest's <item>s
	coverImage         *epubManifestItem
	coverRef           string
	coverMeta          *opfElement   // the first <meta name="cover">
	coverMetas         []*opfElement // all of them
}

func scanOPF(opf []byte, opfPath string) (*opfScan, error) {
	sc := &opfScan{items: map[string]epubManifestItem{}}
	d := epubXML(opf, false)
	var stack []*opfElement
	inMetadata := 0
	for {
		before := int(d.InputOffset())
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errEpubBadOPF
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			end := int(d.InputOffset())
			lt := bytes.IndexByte(opf[before:end], '<')
			if lt < 0 {
				return nil, errEpubBadOPF
			}
			start := before + lt
			raw := opf[start+1 : end]
			e := &opfElement{name: string(raw[:bytes.IndexAny(raw, " \t\r\n/>")]), local: tok.Name.Local,
				start: start, startEnd: end, self: bytes.HasSuffix(opf[start:end], []byte("/>")), attrs: map[string]string{}}
			for _, a := range tok.Attr {
				if _, ok := e.attrs[a.Name.Local]; !ok {
					e.attrs[a.Name.Local] = a.Value
				}
			}
			switch {
			case e.local == "package" && len(stack) == 0:
				sc.version = e.attrs["version"]
			case e.local == "metadata" && sc.metadata == nil:
				sc.metadata = e
			case e.local == "manifest" && sc.manifest == nil:
				sc.manifest = e
			case inMetadata > 0 && e.local == "title" && sc.title == nil:
				sc.title = e
			case inMetadata > 0 && e.local == "creator" && sc.creator == nil:
				sc.creator = e
			case inMetadata > 0 && e.local == "meta":
				sc.metas = append(sc.metas, e)
				if e.attrs["name"] == "cover" {
					sc.coverMetas = append(sc.coverMetas, e)
					if sc.coverMeta == nil {
						sc.coverMeta, sc.coverRef = e, e.attrs["content"]
					}
				}
			case len(stack) > 0 && stack[len(stack)-1] == sc.manifest && e.local == "item":
				if href, _, ok := epubResolve(opfPath, e.attrs["href"]); ok {
					e.href = href
					sc.itemEls = append(sc.itemEls, e)
					it := epubManifestItem{href, e.attrs["media-type"], e.attrs["properties"]}
					sc.items[e.attrs["id"]] = it
					if sc.coverImage == nil && strings.Contains(" "+it.properties+" ", " cover-image ") {
						sc.coverImage = &it
					}
				}
			}
			if e.local == "metadata" {
				inMetadata++
			}
			stack = append(stack, e)
		case xml.EndElement:
			if len(stack) == 0 {
				return nil, errEpubBadOPF
			}
			e := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if e.self {
				e.endStart, e.end = e.startEnd, e.startEnd
			} else {
				e.end = int(d.InputOffset())
				lt := bytes.IndexByte(opf[before:e.end], '<')
				if lt < 0 {
					return nil, errEpubBadOPF
				}
				e.endStart = before + lt
			}
			if e.local == "metadata" {
				inMetadata--
			}
		case xml.CharData:
			if len(stack) > 0 && stack[len(stack)-1].text.Len() < 4*maxEpubDetail {
				stack[len(stack)-1].text.Write(tok)
			}
		}
	}
	if len(stack) != 0 || sc.metadata == nil || sc.manifest == nil || sc.metadata.self || sc.manifest.self {
		return nil, errEpubBadOPF
	}
	return sc, nil
}

// opfEdit replaces opf[start:end] with text.
type opfEdit struct {
	start, end int
	text       string
}

func applyOPFEdits(opf []byte, edits []opfEdit) ([]byte, error) {
	slices.SortStableFunc(edits, func(a, b opfEdit) int { return a.start - b.start })
	var out bytes.Buffer
	at := 0
	for _, e := range edits {
		if e.start < at || e.end < e.start {
			return nil, errEpubBadOPF // overlapping: not as expected
		}
		out.Write(opf[at:e.start])
		out.WriteString(e.text)
		at = e.end
	}
	out.Write(opf[at:])
	return out.Bytes(), nil
}

func xmlText(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

// withValue is the element e, as written, with value as all it holds, and
// without the sort key (file-as) that went with what it held.
func withValue(opf []byte, e *opfElement, value string) string {
	tag := string(opf[e.start:e.startEnd])
	if e.self {
		tag = strings.TrimRight(strings.TrimSuffix(tag, "/>"), " \t\r\n") + ">"
	}
	return epubFileAsAttr.ReplaceAllString(tag, "") + xmlText(value) + "</" + e.name + ">"
}

// withProperties is the start tag of e, as written, with props as its
// properties attribute (none, if props is empty).
func withProperties(opf []byte, e *opfElement, props []string) string {
	tag := string(opf[e.start:e.startEnd])
	attr := regexp.MustCompile(`\s+properties\s*=\s*(?:"[^"]*"|'[^']*')`)
	value := ""
	if len(props) > 0 {
		value = ` properties="` + xmlText(strings.Join(props, " ")) + `"`
	}
	if attr.MatchString(tag) {
		return attr.ReplaceAllLiteralString(tag, value)
	}
	end := strings.TrimRight(tag[:len(tag)-1], "/ \t\r\n")
	return end + value + tag[len(end):]
}

// sniffPicture is the type of picture b is, by what's in it.
func sniffPicture(b []byte) string {
	t := http.DetectContentType(b)
	if strings.HasPrefix(t, "image/") {
		return t
	}
	return ""
}

// editBook writes the book, changed as e says, with cover as its new cover
// picture if e.Cover, to out.
func (z *epubZip) editBook(e epubEdit, cover []byte, out io.Writer, now time.Time) error {
	if z.protected() {
		return errEpubProtected
	}
	b := &bookEdit{z: z, e: e, cover: cover, now: now, rewritten: map[string][]byte{}, before: map[string]epubPictureUse{}, removed: map[string]bool{}}
	var err error
	// Rebuild contents alone may leave the title empty (Untitled books);
	// title/author edits still require a non-empty title.
	if b.title, err = epubDetail(e.Title, "title", !e.RegenerateTOC); err != nil {
		return err
	}
	if b.creator, err = epubDetail(e.Creator, "author", false); err != nil {
		return err
	}
	if b.opfPath, b.opf, err = z.packageFile(); err != nil {
		return err
	}
	if m := epubXMLEncoding.FindSubmatch(b.opf); m != nil && !strings.EqualFold(string(m[1]), "utf-8") || !utf8.Valid(b.opf) {
		return errors.New("its package file (the OPF) isn't in UTF-8, so it can't be changed here")
	}
	if b.sc, err = scanOPF(b.opf, b.opfPath); err != nil {
		return err
	}
	b.editDetails()
	for _, stage := range []func() error{b.editCover, b.editCoverPages, b.editRemovals, b.editTOC} {
		if err := stage(); err != nil {
			return err
		}
	}
	if !b.changed {
		return errEpubNoChange
	}
	if err := b.makeOPF(); err != nil {
		return err
	}
	if err := b.checkRemovals(); err != nil {
		return err
	}
	return b.write(out)
}

// bookEdit is an edit of a book (see editBook) as it's made, a stage at a
// time: the package file's changes, the files changed or added, and what
// was asked.
type bookEdit struct {
	z       *epubZip
	e       epubEdit
	cover   []byte
	now     time.Time
	opfPath string
	opf     []byte
	sc      *opfScan

	title, creator string
	touchMeta      bool // the title and author: changed, or left alone
	edits          []opfEdit
	changed        bool

	coverPath  string // the cover, as the book has it
	newCover   string // a cover sent, where it's added
	wantCover  string // the cover asked for, sent or in the book
	finalCover string // the cover, as the book will have it

	rewritten map[string][]byte         // cover pages made to show the new cover
	pictures  []string                  // every picture, if any is to go
	before    map[string]epubPictureUse // what uses them, as the book is
	removed   map[string]bool

	navPath, ncxPath   string
	navBytes, ncxBytes []byte
	newOPF             []byte
}

func (b *bookEdit) insert(at int, text string) { b.edits = append(b.edits, opfEdit{at, at, text}) }
func (b *bookEdit) remove(e *opfElement)       { b.edits = append(b.edits, opfEdit{e.start, e.end, ""}) }

// dropRefines drops the metadata refining the element e that goes stale
// with its text: a sort key, or the text in another script; all of it, if
// e goes.
func (b *bookEdit) dropRefines(e *opfElement, all bool) {
	if id := e.attrs["id"]; id != "" {
		for _, m := range b.sc.metas {
			if m.attrs["refines"] == "#"+id && (all || epubStaleRefines[m.attrs["property"]]) {
				b.remove(m)
			}
		}
	}
}

// Elements added are in Dublin Core's namespace, declared on each: where
// the book declares it (on the package, the metadata, or only on the
// element that uses it) can't be counted on.
const dcPrefix, dcDeclare = "dc:", ` xmlns:dc="http://purl.org/dc/elements/1.1/"`

// editDetails sets the title and author. Rebuilding the contents with no
// title sent (Untitled books) leaves them alone; a non-empty title means
// the client is also saving details.
func (b *bookEdit) editDetails() {
	sc, title, creator := b.sc, b.title, b.creator
	b.touchMeta = !b.e.RegenerateTOC || title != ""
	if !b.touchMeta {
		return
	}
	if sc.title == nil {
		b.insert(sc.metadata.endStart, "<"+dcPrefix+"title"+dcDeclare+">"+xmlText(title)+"</"+dcPrefix+"title>\n")
		b.changed = true
	} else if sc.title.value() != title {
		b.edits = append(b.edits, opfEdit{sc.title.start, sc.title.end, withValue(b.opf, sc.title, title)})
		b.dropRefines(sc.title, false)
		for _, m := range sc.metas {
			if m.attrs["name"] == "calibre:title_sort" {
				b.remove(m)
			}
		}
		b.changed = true
	}
	switch {
	case sc.creator == nil && creator != "":
		b.insert(sc.metadata.endStart, "<"+dcPrefix+"creator"+dcDeclare+">"+xmlText(creator)+"</"+dcPrefix+"creator>\n")
		b.changed = true
	case sc.creator != nil && creator == "":
		b.remove(sc.creator)
		b.dropRefines(sc.creator, true)
		b.changed = true
	case sc.creator != nil && sc.creator.value() != creator:
		b.edits = append(b.edits, opfEdit{sc.creator.start, sc.creator.end, withValue(b.opf, sc.creator, creator)})
		b.dropRefines(sc.creator, false)
		b.changed = true
	}
}

// editCover names the new cover. It's never written over the old one,
// which stays in the book (its pages may show it). One from outside the
// book is added, as images/cover.jpg or .png beside the OPF
// (OEBPS/images/, as most books are laid out), under a name not taken;
// one already in the book is named the cover where it is.
func (b *bookEdit) editCover() error {
	z, e, sc, opf := b.z, b.e, b.sc, b.opf
	b.coverPath = epubCover(sc.items, b.opfPath, sc.coverImage, sc.coverRef)
	b.finalCover = b.coverPath
	if e.CoverItem != "" && e.Cover {
		return errors.New("a cover comes from the book or from outside it, not both")
	}
	if !e.Cover && (e.CoverItem == "" || e.CoverItem == b.coverPath) {
		return nil
	}
	v3 := strings.HasPrefix(sc.version, "3")
	// The cover's item, and its ID: the one chosen, or one added.
	var coverEl *opfElement
	coverID := ""
	if e.CoverItem != "" {
		for _, it := range sc.itemEls {
			if it.href == e.CoverItem {
				coverEl, coverID = it, it.attrs["id"]
				break
			}
		}
		if coverEl == nil || z.files[e.CoverItem] == nil || epubPictureType(e.CoverItem) == "" ||
			coverEl.attrs["media-type"] != "" && !strings.HasPrefix(coverEl.attrs["media-type"], "image/") {
			return errors.New("that isn't a picture in the book")
		}
		if coverID == "" {
			return errors.New("that picture has no ID in the book's package file, so it can't be named the cover")
		}
		b.wantCover = e.CoverItem
	} else {
		got := sniffPicture(b.cover)
		ext := map[string]string{"image/jpeg": ".jpg", "image/png": ".png"}[got]
		if ext == "" {
			return errors.New("the new cover must be a JPEG or PNG picture")
		}
		// Not a name a file in the book has, or the manifest names.
		dir := path.Dir(b.opfPath)
		taken := map[string]bool{}
		for _, f := range z.all {
			taken[f.Name] = true
		}
		for _, it := range sc.itemEls {
			taken[it.href] = true
		}
		name := "images/cover" + ext
		for i := 2; taken[path.Join(dir, name)]; i++ {
			name = fmt.Sprintf("images/cover-%d%s", i, ext)
		}
		b.newCover, b.wantCover = path.Join(dir, name), path.Join(dir, name)
		coverID = freeManifestID(sc, "cover-image")
		properties := ""
		if v3 {
			properties = ` properties="cover-image"`
		}
		b.insert(sc.manifest.endStart, fmt.Sprintf("<%sitem id=%q href=%q media-type=%q%s/>\n",
			sc.manifest.prefix(), coverID, xmlText(name), got, properties))
	}
	b.finalCover = b.wantCover
	// One cover, and only one: no other item marked as one (EPUB 3), and
	// one <meta name="cover">, naming it (EPUB 2's way, which EPUB 3
	// readers know too). The pictures that were marked stay, as the book
	// may show them elsewhere.
	for _, it := range sc.itemEls {
		props := strings.Fields(it.attrs["properties"])
		has := slices.Contains(props, "cover-image")
		switch {
		case it != coverEl && has:
			b.edits = append(b.edits, opfEdit{it.start, it.startEnd, withProperties(opf, it, slices.DeleteFunc(props, func(p string) bool { return p == "cover-image" }))})
		case it == coverEl && !has && v3:
			b.edits = append(b.edits, opfEdit{it.start, it.startEnd, withProperties(opf, it, append(props, "cover-image"))})
		}
	}
	// (An EPUB 3 book whose cover is marked so needs none; one added, or
	// an EPUB 2 book, has one.)
	needed := !v3 || b.newCover != "" || len(sc.coverMetas) > 0
	right := len(sc.coverMetas) == 1 && sc.coverMetas[0].attrs["content"] == coverID && coverID != ""
	if needed && !right {
		for _, m := range sc.coverMetas {
			b.remove(m)
		}
		if coverID != "" {
			// Quoted as XML, not Go: the ID may be the book's own.
			b.insert(sc.metadata.endStart, "<"+sc.metadata.prefix()+`meta name="cover" content="`+xmlText(coverID)+"\"/>\n")
		}
	}
	b.changed = true
	return nil
}

// editCoverPages makes the cover pages of pictures going show the cover
// (as it'll be) instead. With no cover, they keep it, and it stays. It
// notes what uses each picture, as the book is: the final check (see
// checkRemovals) reads again only the files this changes.
func (b *bookEdit) editCoverPages() error {
	if len(b.e.RemoveItems) == 0 {
		return nil
	}
	b.pictures, _ = b.z.allPictures(b.opfPath, b.sc)
	uses, err := b.z.pictureUses(pictureScan{opfPath: b.opfPath, opf: b.opf, items: b.sc.items}, b.pictures, b.coverPath)
	if err != nil {
		return err
	}
	for _, u := range uses {
		b.before[u.Path] = u
	}
	for _, u := range uses {
		if b.finalCover == "" || u.Path == b.finalCover || !slices.Contains(b.e.RemoveItems, u.Path) {
			continue
		}
		for _, page := range u.CoverPages {
			data, ok := b.rewritten[page]
			if !ok {
				if data, err = b.z.read(page, maxEpubChapter); err != nil {
					return err
				}
			}
			if changedPage, n := repointCover(page, data, u.Path, b.finalCover); n > 0 {
				b.rewritten[page] = changedPage
				b.changed = true
			}
		}
	}
	return nil
}

// editRemovals takes the pictures to remove out of the manifest (with
// what refines them); they're left out of the book as it's written. Each
// must be used by nothing after (see checkRemovals).
func (b *bookEdit) editRemovals() error {
	for _, p := range b.e.RemoveItems {
		if !slices.Contains(b.pictures, p) {
			return fmt.Errorf("%s isn't a picture in the book", p)
		}
		if p == b.finalCover {
			return errors.New("the book's cover can't be removed")
		}
		if b.removed[p] {
			continue
		}
		b.removed[p] = true
		b.changed = true
		for _, it := range b.sc.itemEls {
			if it.href != p {
				continue
			}
			// What refines it goes with it, and any other change to it
			// (such as its cover-image mark) gives way to its going.
			gone := []*opfElement{it}
			if id := it.attrs["id"]; id != "" {
				for _, m := range b.sc.metas {
					if m.attrs["refines"] == "#"+id {
						gone = append(gone, m)
					}
				}
			}
			for _, g := range gone {
				b.edits = slices.DeleteFunc(b.edits, func(ed opfEdit) bool {
					return ed.start >= g.start && ed.end <= g.end && ed.end > ed.start || ed.start > g.start && ed.start < g.end
				})
				b.remove(g)
			}
		}
	}
	return nil
}

// editTOC rebuilds the contents, as asked: the navigation document
// (added, if the book has none) and the NCX, if it has one.
func (b *bookEdit) editTOC() error {
	if !b.e.RegenerateTOC {
		return nil
	}
	z, sc := b.z, b.sc
	items, err := z.buildTOCFromSpine()
	if err != nil {
		return err
	}
	var navID string
	navID, b.navPath = findNavItem(sc)
	if b.navPath == "" {
		name := z.freeOPFName(b.opfPath, "nav.xhtml")
		b.navPath = path.Join(path.Dir(b.opfPath), name)
		navID = freeManifestID(sc, "nav")
		b.insert(sc.manifest.endStart, fmt.Sprintf("<%sitem id=%q href=%q media-type=%q properties=%q/>\n",
			sc.manifest.prefix(), navID, xmlText(name), "application/xhtml+xml", "nav"))
		b.navBytes = writeNavDocument(items, b.navPath)
	} else if old, err := z.read(b.navPath, maxEpubMeta); errors.Is(err, errEpubMissing) {
		b.navBytes = writeNavDocument(items, b.navPath)
	} else if err != nil {
		return err
	} else {
		b.navBytes = rewriteNavDocument(old, items, b.navPath)
	}
	if b.ncxPath = findNCXItem(sc); b.ncxPath != "" {
		old, err := z.read(b.ncxPath, maxEpubMeta)
		if err != nil {
			return err
		}
		b.ncxBytes = rewriteNCXNavMap(old, items, b.ncxPath)
	}
	b.changed = true
	return nil
}

// makeOPF makes the package file, with EPUB 3's last-changed date (if it
// has one) now, and checks it reads back as meant: with a new cover, it's
// the one cover.
func (b *bookEdit) makeOPF() error {
	for _, m := range b.sc.metas {
		if m.attrs["property"] == "dcterms:modified" && !m.self {
			b.edits = append(b.edits, opfEdit{m.startEnd, m.endStart, b.now.UTC().Format("2006-01-02T15:04:05Z")})
			break
		}
	}
	var err error
	if b.newOPF, err = applyOPFEdits(b.opf, b.edits); err != nil {
		return err
	}
	check, err := scanOPF(b.newOPF, b.opfPath)
	if err != nil {
		return errEpubBadOPF
	}
	if b.touchMeta {
		if check.title == nil || check.title.value() != b.title ||
			b.creator != "" && (check.creator == nil || check.creator.value() != b.creator) {
			return errEpubBadOPF
		}
	}
	if b.wantCover != "" {
		marked := 0
		for _, it := range check.itemEls {
			if slices.Contains(strings.Fields(it.attrs["properties"]), "cover-image") {
				marked++
			}
		}
		if marked > 1 || len(check.coverMetas) > 1 || epubCover(check.items, b.opfPath, check.coverImage, check.coverRef) != b.wantCover {
			return errEpubBadOPF
		}
	}
	if b.e.RegenerateTOC {
		id, href := findNavItem(check)
		if href != b.navPath || id == "" {
			return errEpubBadOPF
		}
	}
	for _, it := range check.itemEls {
		if b.removed[it.href] {
			return errEpubBadOPF
		}
	}
	return nil
}

// checkRemovals checks the pictures removed are used by nothing, as the
// book will be: no file (as changed) referring to one, or naming it. The
// package file is read with the manifest as it was, so a spine entry or
// fallback naming a removed item by its ID still counts.
func (b *bookEdit) checkRemovals() error {
	if len(b.removed) == 0 {
		return nil
	}
	after := map[string][]byte{}
	maps.Copy(after, b.rewritten)
	if b.navBytes != nil {
		after[b.navPath] = b.navBytes
	}
	if b.ncxBytes != nil {
		after[b.ncxPath] = b.ncxBytes
	}
	// Cover pages made to show the new cover count only by what they
	// refer to: a name left in alt text, say, isn't a use.
	refsOnly := map[string]bool{}
	for page := range b.rewritten {
		refsOnly[page] = true
	}
	gone := slices.Sorted(maps.Keys(b.removed))
	uses, err := b.z.pictureUses(pictureScan{opfPath: b.opfPath, opf: b.newOPF, items: b.sc.items, override: after, only: true, refsOnly: refsOnly}, gone, b.finalCover)
	if err != nil {
		return err
	}
	for _, u := range uses {
		// As changed, the files changed; as they are, the rest.
		users := slices.Clone(u.Users)
		for _, f := range b.before[u.Path].Users {
			if _, changed := after[f]; !changed && f != b.opfPath && !slices.Contains(users, f) {
				users = append(users, f)
			}
		}
		if users = slices.DeleteFunc(users, func(f string) bool { return b.removed[f] }); len(users) > 0 {
			slices.Sort(users)
			return fmt.Errorf("%s can't be removed: %s uses it", path.Base(u.Path), strings.Join(users, ", "))
		}
	}
	return nil
}

// write writes the book, as changed, to out: each file as it was, but
// those changed, those removed left out, and those added.
func (b *bookEdit) write(out io.Writer) error {
	z := b.z
	w := zip.NewWriter(out)
	if err := w.SetComment(z.comment); err != nil {
		return err
	}
	wrote := func(name string, method uint16, data []byte) error {
		fw, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: method, Modified: b.now})
		if err == nil {
			_, err = fw.Write(data)
		}
		return err
	}
	toc := b.e.RegenerateTOC
	opfDone, navDone, ncxDone := false, false, false
	for _, f := range z.all {
		var err error
		switch {
		case f.Name == b.opfPath && !opfDone:
			err = wrote(f.Name, zip.Deflate, b.newOPF)
			opfDone = true
		case toc && f.Name == b.navPath && !navDone:
			err = wrote(f.Name, zip.Deflate, b.navBytes)
			navDone = true
		case toc && b.ncxPath != "" && f.Name == b.ncxPath && !ncxDone:
			err = wrote(f.Name, zip.Deflate, b.ncxBytes)
			ncxDone = true
		case b.removed[f.Name]:
			// Removed: left out.
		case b.rewritten[f.Name] != nil && z.files[f.Name] == f:
			err = wrote(f.Name, zip.Deflate, b.rewritten[f.Name])
		default:
			err = w.Copy(f)
		}
		if err != nil {
			return err
		}
	}
	if b.newCover != "" {
		if err := wrote(b.newCover, zip.Store, b.cover); err != nil {
			return err
		}
	}
	if toc && !navDone {
		if err := wrote(b.navPath, zip.Deflate, b.navBytes); err != nil {
			return err
		}
	}
	return w.Close()
}

// epubEditChild is the child's part in editing (see renderEpubChild): the
// book on stdin, the edit as args[1], a new cover on descriptor 3, and the
// changed book written to descriptor 4.
func epubEditChild(z *epubZip, args []string) ([]byte, error) {
	var e epubEdit
	if len(args) != 2 || json.Unmarshal([]byte(args[1]), &e) != nil {
		return nil, errors.New("not a question the child answers")
	}
	var cover []byte
	if e.Cover {
		var err error
		cover, err = io.ReadAll(io.LimitReader(os.NewFile(3, "cover"), maxEpubPicture+1))
		if err != nil || len(cover) > maxEpubPicture {
			return nil, errors.New("the new cover is too big")
		}
	}
	out := os.NewFile(4, "book")
	bw := bufio.NewWriterSize(out, 1<<20)
	if err := z.editBook(e, cover, bw, time.Now()); err != nil {
		return nil, err
	}
	if err := bw.Flush(); err != nil {
		return nil, err
	}
	return []byte(`{"ok":true}`), nil
}

// tunnelEpubEdit answers an "epub-edit" request: the book at req.Path,
// as it was (req.IfMtime, req.IfSize), given the title req.Title and the
// author req.Creator, and, if req.Size, a new cover, its bytes sent after
// the request; with req.RegenerateTOC, its contents list is rebuilt from
// the chapters' headings.
func (g *server) tunnelEpubEdit(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	p := path.Clean(strings.Trim(req.Path, "/"))
	if req.IfMtime == "" || len(req.Title) > 4*maxEpubDetail || len(req.Creator) > 4*maxEpubDetail {
		r.fail("That's not a change that can be made.")
		return
	}
	if req.Size < 0 || req.Size > maxEpubPicture {
		r.fail(fmt.Sprintf("The cover picture is too big: it can be at most %s.", humanSize(maxEpubPicture)))
		return
	}
	opened, err := openDownloadsFile(g.downloadsDir, p)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	f, st := opened.file, opened.info
	store := opened.store
	if req.changed(st) {
		r.fail(errEpubChanged.Error())
		return
	}
	// A link to a book can't be saved over (see finish): said now, not
	// once the book's been written again.
	if lst, err := store.root.Lstat(p); err == nil && lst.Mode()&fs.ModeSymlink != 0 {
		r.fail(errReplaceLink.Error())
		return
	}
	dir := path.Dir(p)
	if d, _, err := store.open(dir); err == nil {
		free, _, ok := g.transfers.uploadRoom(d)
		d.Close()
		if ok && free < st.Size()+req.Size+1<<20 {
			r.fail("There isn't room on the disk for the changed book.")
			return
		}
	}
	// The edit goes to the child as one argument, which the kernel keeps
	// under 128 KiB (MAX_ARG_STRLEN): measured as it's sent, escapes and
	// all, it's bounded well inside that. (Checked before the book's read.)
	edit, _ := json.Marshal(epubEdit{Title: req.Title, Creator: req.Creator, Cover: req.Size > 0, CoverItem: req.CoverItem,
		RemoveItems: req.RemoveItems, RegenerateTOC: req.RegenerateTOC})
	if len(req.RemoveItems) > maxEpubRemove || len(edit) > maxEpubEditArg {
		r.fail("That's not a change that can be made.")
		return
	}
	// The book read first, before its cover is sent: one that can't be
	// changed (damaged, or with DRM) is refused without it.
	got, err := readEpubIsolated(f, "book")
	var before epubBook
	if err == nil && json.Unmarshal(got, &before) != nil {
		err = errEpubNotBook
	}
	if err != nil {
		r.fail(err.Error())
		return
	}
	if req.CoverItem != "" && (req.Size > 0 || !slices.Contains(before.Pictures, req.CoverItem)) {
		r.fail("That picture can't be made the cover.")
		return
	}
	if !r.accept(nil) {
		return
	}
	cover, ok := receiveData(t, req.Size, "bad cover")
	if !ok {
		return
	}
	u, err := store.startUpload(dir)
	if err != nil {
		r.fail(uploadError(err))
		return
	}
	// Failing, the new book goes first, then the page is told: the reply
	// can wait on the tunnel's closing.
	fail := func(message string) {
		u.abort()
		r.fail(message)
	}
	if err := runEpubEdit(f, u.f, cover, st.Size(), string(edit)); err != nil {
		fail(err.Error())
		return
	}
	epubEditCopied()
	// The new book, read back, as it should be, before it replaces this one.
	nf, _, err := store.open(u.tmp)
	if err != nil {
		fail("The changed book couldn't be read back.")
		return
	}
	got, err = readEpubIsolated(nf, "book")
	nf.Close()
	var after epubBook
	if err == nil && json.Unmarshal(got, &after) != nil {
		err = errEpubNotBook
	}
	title, _ := epubDetail(req.Title, "title", !req.RegenerateTOC)
	creator, _ := epubDetail(req.Creator, "author", false)
	metaOK := after.Title == title && (creator == "" || after.Creator == creator)
	if req.RegenerateTOC && title == "" {
		metaOK = after.Title == before.Title && after.Creator == before.Creator
	}
	// And the cover named, and the pictures removed, as asked: checked here
	// too, not only by the child that made it.
	removedLeft := slices.ContainsFunc(req.RemoveItems, func(p string) bool { return slices.Contains(after.Pictures, p) })
	if err != nil || !metaOK || len(after.Spine) != len(before.Spine) ||
		req.Size > 0 && after.Cover == "" || req.CoverItem != "" && after.Cover != req.CoverItem ||
		removedLeft || req.RegenerateTOC && len(after.TOC) == 0 {
		log.Printf("editing %q: the changed book didn't read back as it should (%v)", p, err)
		fail("The changed book didn't read back as it should, so the book was left as it was.")
		return
	}
	// One replacing at a time, and only if it's still as it was.
	target, unlock, err := store.beginReplacement(p)
	if err != nil {
		fail(uploadError(err))
		return
	}
	if err := unchangedSince(target, path.Base(p), req.IfMtime, req.IfSize); err != nil {
		unlock()
		fail(errEpubChanged.Error())
		return
	}
	_, err = u.finishAt(path.Base(p), true, target)
	// Its time and size, read before another save can replace it.
	var nst fs.FileInfo
	if err == nil {
		nst, _ = target.stat(path.Base(p))
	}
	unlock()
	if err != nil {
		r.fail(uploadError(err))
		return
	}
	if req.RegenerateTOC {
		log.Printf("rebuilt the contents of the book %q", p)
	} else {
		log.Printf("changed the details of the book %q", p)
	}
	res := map[string]any{"book": after}
	if nst != nil {
		res["mtime"], res["size"] = fileVersion(nst), nst.Size()
	}
	if u.unsynced {
		res["warning"] = "saved, but the disk didn't confirm it; it could be lost if the power fails soon"
	}
	r.finish(res)
}

// epubEditCopied is called once the changed book is written, before it's
// read back: for tests, to change the book meanwhile.
var epubEditCopied = func() {}

// runEpubEdit has a child write the book open as f, changed as edit says,
// to out, with cover as its new cover if it's not empty.
func runEpubEdit(f, out *os.File, cover []byte, size int64, edit string) error {
	release, ok := epubEditSlots.acquire()
	if !ok {
		return errEpubEditBusy
	}
	defer release()
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	defer pr.Close()
	go func() {
		pw.Write(cover) // till the child has it, or has gone
		pw.Close()
	}()
	_, err = runEpubChild(f, epubEditTimeout(size), []*os.File{pr, out}, "edit", edit)
	return err
}
