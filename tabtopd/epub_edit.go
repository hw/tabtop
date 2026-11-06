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
// written over the old one, at its path, so pages in the book that show it
// show the new one; it must be the same type of picture, which the page
// makes it (see coverBytes in preview.js). A book without a cover is given
// one, beside its OPF, named in the manifest as EPUB 3 and EPUB 2 name one.
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
	"context"

	"github.com/coder/websocket"
)

// The longest title or author, in characters.
const maxEpubDetail = 500

// The pictures a cover may be given as, when it has none to match.
var epubNewCoverTypes = []string{"image/jpeg", "image/png", "image/webp"}

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
// author, whether a new cover comes, on its file descriptor 3, and whether
// to rebuild the contents list from the chapters' headings.
type epubEdit struct {
	Title         string `json:"title"`
	Creator       string `json:"creator"`
	Cover         bool   `json:"cover"`
	RegenerateTOC bool   `json:"regenerate_toc,omitempty"`
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
	// Rebuild contents alone may leave the title empty (Untitled books);
	// title/author edits still require a non-empty title.
	title, err := epubDetail(e.Title, "title", !e.RegenerateTOC)
	if err != nil {
		return err
	}
	creator, err := epubDetail(e.Creator, "author", false)
	if err != nil {
		return err
	}
	opfPath, opf, err := z.packageFile()
	if err != nil {
		return err
	}
	if m := epubXMLEncoding.FindSubmatch(opf); m != nil && !strings.EqualFold(string(m[1]), "utf-8") || !utf8.Valid(opf) {
		return errors.New("its package file (the OPF) isn't in UTF-8, so it can't be changed here")
	}
	sc, err := scanOPF(opf, opfPath)
	if err != nil {
		return err
	}

	var edits []opfEdit
	insert := func(at int, text string) { edits = append(edits, opfEdit{at, at, text}) }
	remove := func(e *opfElement) { edits = append(edits, opfEdit{e.start, e.end, ""}) }
	// dropRefines drops the metadata refining the element e that goes
	// stale with its text: a sort key, or the text in another script; all
	// of it, if e goes.
	dropRefines := func(e *opfElement, all bool) {
		if id := e.attrs["id"]; id != "" {
			for _, m := range sc.metas {
				if m.attrs["refines"] == "#"+id && (all || epubStaleRefines[m.attrs["property"]]) {
					remove(m)
				}
			}
		}
	}
	// Elements added are in Dublin Core's namespace, declared on each:
	// where the book declares it (on the package, the metadata, or only on
	// the element that uses it) can't be counted on.
	const dc, dcDeclare = "dc:", ` xmlns:dc="http://purl.org/dc/elements/1.1/"`
	changed := false
	// Rebuild with no title sent (Untitled books): leave title and author
	// alone. A non-empty title means the client is also saving details.
	touchMeta := !e.RegenerateTOC || title != ""
	if touchMeta {
		if sc.title == nil {
			insert(sc.metadata.endStart, "<"+dc+"title"+dcDeclare+">"+xmlText(title)+"</"+dc+"title>\n")
			changed = true
		} else if sc.title.value() != title {
			edits = append(edits, opfEdit{sc.title.start, sc.title.end, withValue(opf, sc.title, title)})
			dropRefines(sc.title, false)
			for _, m := range sc.metas {
				if m.attrs["name"] == "calibre:title_sort" {
					remove(m)
				}
			}
			changed = true
		}
		switch {
		case sc.creator == nil && creator != "":
			insert(sc.metadata.endStart, "<"+dc+"creator"+dcDeclare+">"+xmlText(creator)+"</"+dc+"creator>\n")
			changed = true
		case sc.creator != nil && creator == "":
			remove(sc.creator)
			dropRefines(sc.creator, true)
			changed = true
		case sc.creator != nil && sc.creator.value() != creator:
			edits = append(edits, opfEdit{sc.creator.start, sc.creator.end, withValue(opf, sc.creator, creator)})
			dropRefines(sc.creator, false)
			changed = true
		}
	}

	// The cover the book names: written over, or, if the book names one
	// it hasn't, put where it says, rather than named again (readers take
	// the first named, so a second would go unseen).
	coverPath := epubCover(sc.items, opfPath, sc.coverImage, sc.coverRef)
	newCover := ""
	if e.Cover {
		got := sniffPicture(cover)
		v3 := strings.HasPrefix(sc.version, "3")
		// The cover's item, and its ID: the one there, or one added.
		var coverEl *opfElement
		coverID := ""
		if coverPath != "" {
			if want := epubPictureType(coverPath); got != want {
				return fmt.Errorf("the new cover must be a %s picture, as the old one is", strings.ToUpper(strings.TrimPrefix(want, "image/")))
			}
			for _, it := range sc.itemEls {
				if it.href == coverPath {
					coverEl, coverID = it, it.attrs["id"]
					break
				}
			}
		} else {
			if !slices.Contains(epubNewCoverTypes, got) {
				return errors.New("the new cover must be a JPEG, PNG or WebP picture")
			}
			// Beside the OPF, by a name and ID not used.
			ext := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[got]
			taken := map[string]bool{}
			for _, f := range z.all {
				taken[f.Name] = true
			}
			name := "cover" + ext
			for i := 2; taken[path.Join(path.Dir(opfPath), name)]; i++ {
				name = fmt.Sprintf("cover-%d%s", i, ext)
			}
			newCover = path.Join(path.Dir(opfPath), name)
			coverID = "cover-image"
			for i := 2; ; i++ {
				if _, ok := sc.items[coverID]; !ok {
					break
				}
				coverID = fmt.Sprintf("cover-image-%d", i)
			}
			properties := ""
			if v3 {
				properties = ` properties="cover-image"`
			}
			insert(sc.manifest.endStart, fmt.Sprintf("<%sitem id=%q href=%q media-type=%q%s/>\n",
				sc.manifest.prefix(), coverID, xmlText(name), got, properties))
		}
		// One cover, and only one: no other item marked as one (EPUB 3),
		// and one <meta name="cover">, naming it (EPUB 2's way, which EPUB
		// 3 readers know too). The pictures that were marked stay, as the
		// book may show them elsewhere.
		for _, it := range sc.itemEls {
			props := strings.Fields(it.attrs["properties"])
			has := slices.Contains(props, "cover-image")
			switch {
			case it != coverEl && has:
				edits = append(edits, opfEdit{it.start, it.startEnd, withProperties(opf, it, slices.DeleteFunc(props, func(p string) bool { return p == "cover-image" }))})
			case it == coverEl && !has && v3:
				edits = append(edits, opfEdit{it.start, it.startEnd, withProperties(opf, it, append(props, "cover-image"))})
			}
		}
		// (An EPUB 3 book whose cover is marked so needs none; one added,
		// or an EPUB 2 book, has one.)
		needed := !v3 || newCover != "" || len(sc.coverMetas) > 0
		right := len(sc.coverMetas) == 1 && sc.coverMetas[0].attrs["content"] == coverID && coverID != ""
		if needed && !right {
			for _, m := range sc.coverMetas {
				remove(m)
			}
			if coverID != "" {
				insert(sc.metadata.endStart, fmt.Sprintf("<%smeta name=\"cover\" content=%q/>\n", sc.metadata.prefix(), xmlText(coverID)))
			}
		}
		changed = true
	}

	var navBytes, ncxBytes []byte
	navPath, ncxPath := "", ""
	if e.RegenerateTOC {
		items, err := z.buildTOCFromSpine()
		if err != nil {
			return err
		}
		var navID string
		navID, navPath = findNavItem(sc)
		if navPath == "" {
			name := z.freeOPFName(opfPath, "nav.xhtml")
			navPath = path.Join(path.Dir(opfPath), name)
			navID = freeManifestID(sc, "nav")
			insert(sc.manifest.endStart, fmt.Sprintf("<%sitem id=%q href=%q media-type=%q properties=%q/>\n",
				sc.manifest.prefix(), navID, xmlText(name), "application/xhtml+xml", "nav"))
			navBytes = writeNavDocument(items, navPath)
		} else if old, err := z.read(navPath, maxEpubMeta); errors.Is(err, errEpubMissing) {
			navBytes = writeNavDocument(items, navPath)
		} else if err != nil {
			return err
		} else {
			navBytes = rewriteNavDocument(old, items, navPath)
		}
		ncxPath = findNCXItem(sc)
		if ncxPath != "" {
			old, err := z.read(ncxPath, maxEpubMeta)
			if err != nil {
				return err
			}
			ncxBytes = rewriteNCXNavMap(old, items, ncxPath)
		}
		changed = true
	}

	if !changed {
		return errEpubNoChange
	}
	// EPUB 3's last-changed date, if it has one, now.
	for _, m := range sc.metas {
		if m.attrs["property"] == "dcterms:modified" && !m.self {
			edits = append(edits, opfEdit{m.startEnd, m.endStart, now.UTC().Format("2006-01-02T15:04:05Z")})
			break
		}
	}
	newOPF, err := applyOPFEdits(opf, edits)
	if err != nil {
		return err
	}
	// It reads back as meant: and with a new cover, it's the one cover.
	check, err := scanOPF(newOPF, opfPath)
	if err != nil {
		return errEpubBadOPF
	}
	if touchMeta {
		if check.title == nil || check.title.value() != title ||
			creator != "" && (check.creator == nil || check.creator.value() != creator) {
			return errEpubBadOPF
		}
	}
	if e.Cover {
		want := coverPath
		if newCover != "" {
			want = newCover
		}
		marked := 0
		for _, it := range check.itemEls {
			if slices.Contains(strings.Fields(it.attrs["properties"]), "cover-image") {
				marked++
			}
		}
		if marked > 1 || len(check.coverMetas) > 1 || epubCover(check.items, opfPath, check.coverImage, check.coverRef) != want {
			return errEpubBadOPF
		}
	}
	if e.RegenerateTOC {
		id, href := findNavItem(check)
		if href != navPath || id == "" {
			return errEpubBadOPF
		}
	}

	w := zip.NewWriter(out)
	if err := w.SetComment(z.comment); err != nil {
		return err
	}
	wrote := func(name string, method uint16, b []byte) error {
		fw, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: method, Modified: now})
		if err == nil {
			_, err = fw.Write(b)
		}
		return err
	}
	opfDone, coverDone, navDone, ncxDone := false, false, false, false
	for _, f := range z.all {
		switch {
		case f.Name == opfPath && !opfDone:
			err = wrote(f.Name, zip.Deflate, newOPF)
			opfDone = true
		case e.Cover && f.Name == coverPath && !coverDone:
			err = wrote(f.Name, zip.Store, cover)
			coverDone = true
		case e.RegenerateTOC && f.Name == navPath && !navDone:
			err = wrote(f.Name, zip.Deflate, navBytes)
			navDone = true
		case e.RegenerateTOC && ncxPath != "" && f.Name == ncxPath && !ncxDone:
			err = wrote(f.Name, zip.Deflate, ncxBytes)
			ncxDone = true
		default:
			err = w.Copy(f)
		}
		if err != nil {
			return err
		}
	}
	if newCover == "" && e.Cover && !coverDone {
		newCover = coverPath // named, but not in the book
	}
	if newCover != "" {
		if err := wrote(newCover, zip.Store, cover); err != nil {
			return err
		}
	}
	if e.RegenerateTOC && !navDone {
		if err := wrote(navPath, zip.Deflate, navBytes); err != nil {
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
	if fileVersion(st) != req.IfMtime || st.Size() != req.IfSize {
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
	if !r.accept(nil) {
		return
	}
	cover := make([]byte, 0, req.Size)
	if req.Size > 0 {
		t.c.SetReadLimit(fileChunk + tunnelOverhead)
		for int64(len(cover)) < req.Size {
			ctx, cancel := context.WithTimeout(context.Background(), fileStall)
			typ, b, err := t.Read(ctx)
			cancel()
			if err != nil {
				return
			}
			if typ != websocket.MessageBinary || int64(len(cover)+len(b)) > req.Size {
				t.Close(websocket.StatusPolicyViolation, "bad cover")
				return
			}
			cover = append(cover, b...)
		}
	}
	edit, _ := json.Marshal(epubEdit{Title: req.Title, Creator: req.Creator, Cover: req.Size > 0, RegenerateTOC: req.RegenerateTOC})

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
	if err != nil || !metaOK || len(after.Spine) != len(before.Spine) ||
		req.Size > 0 && after.Cover == "" || req.RegenerateTOC && len(after.TOC) == 0 {
		log.Printf("editing %q: the changed book didn't read back as it should (%v)", p, err)
		fail("The changed book didn't read back as it should, so the book was left as it was.")
		return
	}
	// One replacing at a time, and only if it's still as it was.
	unlock := lockReplacing(p)
	if err := unchangedSince(store, p, req.IfMtime, req.IfSize); err != nil {
		unlock()
		fail(errEpubChanged.Error())
		return
	}
	_, err = u.finish(path.Base(p), true)
	// Its time and size, read before another save can replace it.
	var nst fs.FileInfo
	if err == nil {
		nst, _ = store.stat(p)
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
