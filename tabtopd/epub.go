package main

// EPUB previews: the files page shows a book a chapter at a time, in a
// sandboxed frame of its own (epub-frame.html, epub-frame.js), as Markdown
// is shown: nothing in it can reach the site. tabtopd opens the book (a
// zip), and answers three things through the tunnel's "epub" request:
//
//   - with no Item, the book: its title, author and language, its chapters
//     in reading order (the spine), its pictures (from the manifest, for
//     choosing a cover), and its contents (EPUB 3's nav, or EPUB 2's NCX);
//   - with Item a chapter, the chapter, as HTML: its body, rewritten (links
//     and pictures as paths in the book, IDs prefixed so they can't clash
//     with the frame's own) and then cleaned with bluemonday, as Markdown
//     is. Book scripts, styles, fonts, forms, inline SVG and MathML are
//     left out;
//   - with Item a picture, its bytes.
//
// So only what's read comes over, however big the book is.
//
// Chapters are XHTML, which HTML parsers misread (<title/> or <a id="x"/>
// open elements that swallow what follows), so they're read as XML,
// leniently, and written out as HTML here. All of it, the zip included,
// runs in a child process, tabtopd run with epubChildArg, given the open
// book as its stdin, on one core and killed after epubTimeout, as Markdown
// is rendered: a book made to take long or to take memory, as one sent
// through an upload link could be, costs that child, not the gateway.
//
// Books with DRM can't be read, and say so; a book whose only encryption
// is the font obfuscation EPUB allows is read, as its fonts aren't used.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/microcosm-cc/bluemonday"
)

const (
	epubChildArg = "-render-epub"
	epubTimeout  = 10 * time.Second

	maxEpubEntries = 20000
	maxEpubMeta    = 4 << 20  // container.xml, the OPF, the nav or NCX: each, unpacked
	maxEpubChapter = 8 << 20  // a chapter, unpacked
	maxEpubPicture = 20 << 20 // a picture, unpacked
	maxEpubSpine   = 10000
	maxEpubTOC     = 10000
	maxEpubOut     = 48 << 20 // what the child may answer
)

var (
	errEpubNotBook   = errors.New("it isn't an EPUB book, or it's damaged")
	errEpubProtected = errors.New("it's protected (DRM), so it can only be read in the app it was bought for")
	errEpubTooBig    = errors.New("it's too big to show")
	errEpubMissing   = errors.New("it isn't in the book")
	errEpubSlow      = errors.New("it takes too long to read")
	errEpubBusy      = errors.New("other files are being read; try again in a moment")
	errEpubChanged   = errors.New("The book has changed since it was opened. Open it again.")
)

// epubBook is a book, as the frame is told it.
type epubBook struct {
	Title    string        `json:"title"`
	Creator  string        `json:"creator,omitempty"`
	Language string        `json:"language,omitempty"`
	RTL      bool          `json:"rtl,omitempty"`      // pages turn right to left
	Fixed    bool          `json:"fixed,omitempty"`    // laid out by page, as comics are: it may look wrong
	Cover    string        `json:"cover,omitempty"`    // its cover picture, as a path in the book, if it says which (see epubCover); perhaps missing from it
	Spine    []string      `json:"spine"`              // the chapters, in reading order, as paths in the book
	Pictures []string      `json:"pictures,omitempty"` // pictures in the book, as paths, for choosing a cover (see askBookDetails)
	TOC      []epubTOCItem `json:"toc"`
}

// epubTOCItem is an entry in the contents: Label, at Level (from 1), going
// to the chapter Item, at the element with the ID Frag (prefixed, as the
// chapter's are), if any.
type epubTOCItem struct {
	Label string `json:"label"`
	Item  string `json:"item"`
	Frag  string `json:"frag,omitempty"`
	Level int    `json:"level"`
}

// epubZip is a book's files, by their names in it.
type epubZip struct {
	files map[string]*zip.File
	// Every file in it, in order, those not in files too, and its comment:
	// all kept when it's rewritten (see editBook).
	all     []*zip.File
	comment string
}

func openEpubZip(r io.ReaderAt, size int64) (*epubZip, error) {
	zr, err := openBoundedZip(r, size, epubDirectoryLimits)
	if errors.Is(err, epubDirectoryLimits.err) {
		return nil, err
	}
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		return nil, errEpubNotBook
	}
	if len(zr.File) > maxEpubEntries {
		return nil, fmt.Errorf("it has more than %d files in it", maxEpubEntries)
	}
	z := &epubZip{files: make(map[string]*zip.File, len(zr.File)), all: zr.File, comment: zr.Comment}
	for _, f := range zr.File {
		// Only plain names: none leading out, or absolute.
		if f.Name == "" || path.Clean(f.Name) != f.Name || strings.HasPrefix(f.Name, "/") || f.Name == ".." ||
			strings.HasPrefix(f.Name, "../") || strings.Contains(f.Name, "\\") || !utf8.ValidString(f.Name) {
			continue
		}
		if _, ok := z.files[f.Name]; !ok {
			z.files[f.Name] = f
		}
	}
	return z, nil
}

// read returns the file name in the book, unpacked, if it's at most max
// bytes; what its header says is checked, and then what it unpacks to.
func (z *epubZip) read(name string, max int64) ([]byte, error) {
	f := z.files[name]
	if f == nil {
		return nil, errEpubMissing
	}
	if f.UncompressedSize64 > uint64(max) {
		return nil, errEpubTooBig
	}
	rc, err := f.Open()
	if err != nil {
		return nil, errEpubNotBook
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, max+1))
	if err != nil {
		return nil, errEpubNotBook
	}
	if int64(len(b)) > max {
		return nil, errEpubTooBig
	}
	return b, nil
}

// Encryption EPUB allows on fonts alone (IDPF's, and Adobe's), which isn't
// DRM: the book's text is plain.
var epubFontObfuscation = map[string]bool{
	"http://www.idpf.org/2008/embedding": true,
	"http://ns.adobe.com/pdf/enc#RC":     true,
}

// protected reports whether the book has DRM: a Readium LCP licence, or
// encryption other than fonts'.
func (z *epubZip) protected() bool {
	if z.files["META-INF/license.lcpl"] != nil {
		return true
	}
	b, err := z.read("META-INF/encryption.xml", maxEpubMeta)
	if errors.Is(err, errEpubMissing) {
		return false
	}
	if err != nil {
		return true // can't tell: as if it is
	}
	d := epubXML(b, false)
	for {
		tok, err := d.Token()
		if err != nil {
			return false
		}
		if s, ok := tok.(xml.StartElement); ok && s.Name.Local == "EncryptionMethod" && !epubFontObfuscation[attr(s, "Algorithm")] {
			return true
		}
	}
}

// epubXML is a lenient XML decoder: books are often not quite XML. For
// XHTML (chapters, the nav), HTML's empty elements, as <br>, close
// themselves; not in the OPF and NCX, whose <meta> holds text.
func epubXML(b []byte, xhtml bool) *xml.Decoder {
	d := xml.NewDecoder(bytes.NewReader(b))
	d.Strict = false
	if xhtml {
		d.AutoClose = xml.HTMLAutoClose
	}
	d.Entity = xml.HTMLEntity
	d.CharsetReader = func(charset string, r io.Reader) (io.Reader, error) {
		switch strings.ToLower(charset) {
		case "utf-8", "utf8", "us-ascii", "ascii":
			return r, nil
		case "iso-8859-1", "latin1", "latin-1", "windows-1252", "cp1252":
			return latin1Reader{r}, nil
		}
		return nil, fmt.Errorf("its text is in %s, which can't be read here", charset)
	}
	return d
}

// latin1Reader turns ISO 8859-1 into UTF-8 (and Windows-1252 nearly).
type latin1Reader struct{ r io.Reader }

func (l latin1Reader) Read(p []byte) (int, error) {
	// Each byte becomes at most two: read no more than fit.
	if len(p) < 2 {
		return 0, io.ErrShortBuffer
	}
	buf := make([]byte, len(p)/2)
	n, err := l.r.Read(buf)
	out := p[:0]
	for _, c := range buf[:n] {
		out = utf8.AppendRune(out, rune(c))
	}
	return len(out), err
}

func attr(s xml.StartElement, local string) string {
	for _, a := range s.Attr {
		if a.Name.Local == local {
			return a.Value
		}
	}
	return ""
}

var (
	urlScheme = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
	webLink   = regexp.MustCompile(`(?i)^(https?|mailto):`)
)

// epubResolve resolves href, from the file base in the book, to the file
// it names in it, and its fragment, if any. ok is false for a link out of
// the book (to the web, say), or one leading out of it.
func epubResolve(base, href string) (item, frag string, ok bool) {
	href = strings.TrimSpace(href)
	if i := strings.IndexByte(href, '#'); i >= 0 {
		href, frag = href[:i], href[i+1:]
		if f, err := url.PathUnescape(frag); err == nil {
			frag = f
		}
	}
	if strings.HasPrefix(href, "//") || urlScheme.MatchString(href) {
		return "", "", false
	}
	if i := strings.IndexByte(href, '?'); i >= 0 {
		href = href[:i]
	}
	p, err := url.PathUnescape(href)
	if err != nil {
		return "", "", false
	}
	if p == "" {
		return base, frag, true
	}
	if strings.HasPrefix(p, "/") {
		p = path.Clean(strings.TrimLeft(p, "/"))
	} else {
		p = path.Join(path.Dir(base), p)
	}
	if p == "." || p == ".." || strings.HasPrefix(p, "../") {
		return "", "", false
	}
	return p, frag, true
}

// epubManifestItem is a file the OPF lists.
type epubManifestItem struct {
	href, mediaType, properties string
}

// epubCover is the path of the book's cover picture, from its OPF's
// manifest: the item marked cover-image (EPUB 3), else the one EPUB 2's
// <meta name="cover" content> names, by its ID (or, as some books have it,
// its path); "" if neither says, or what they name isn't a picture. It's
// never guessed from names: a guess could take another picture for it.
// coverImage is the first item marked cover-image, if any.
func epubCover(manifest map[string]epubManifestItem, opfPath string, coverImage *epubManifestItem, coverRef string) string {
	picture := func(it epubManifestItem) bool {
		return epubPictureType(it.href) != "" && (it.mediaType == "" || strings.HasPrefix(it.mediaType, "image/"))
	}
	if coverImage != nil && picture(*coverImage) {
		return coverImage.href
	}
	if it, ok := manifest[coverRef]; ok && coverRef != "" {
		if picture(it) {
			return it.href
		}
		return ""
	}
	if p, _, ok := epubResolve(opfPath, coverRef); ok && coverRef != "" {
		for _, it := range manifest {
			if it.href == p && picture(it) {
				return p
			}
		}
	}
	return ""
}

// packageFile finds the book's package file (its OPF), as
// META-INF/container.xml names it, and returns its path and what's in it.
func (z *epubZip) packageFile() (string, []byte, error) {
	container, err := z.read("META-INF/container.xml", maxEpubMeta)
	if err != nil {
		return "", nil, errEpubNotBook
	}
	d := epubXML(container, false)
	for {
		tok, err := d.Token()
		if err != nil {
			return "", nil, errEpubNotBook
		}
		if s, ok := tok.(xml.StartElement); ok && s.Name.Local == "rootfile" {
			if p, _, ok := epubResolve("", attr(s, "full-path")); ok {
				opf, err := z.read(p, maxEpubMeta)
				if err != nil {
					return "", nil, errEpubNotBook
				}
				return p, opf, nil
			}
		}
	}
}

// readBook reads the book's structure.
func (z *epubZip) readBook() (*epubBook, error) {
	if z.protected() {
		return nil, errEpubProtected
	}
	opfPath, opf, err := z.packageFile()
	if err != nil {
		return nil, err
	}

	book := &epubBook{Spine: []string{}, TOC: []epubTOCItem{}}
	manifest := map[string]epubManifestItem{}
	var spine, nonLinear []string
	ncxID, coverRef := "", ""
	var coverImage *epubManifestItem
	var section string // metadata, manifest or spine
	var field *string  // the metadata field being read
	layout := false    // it's the rendition:layout meta's (else a dc: field's)
	var text strings.Builder
	d := epubXML(opf, false)
	for {
		tok, err := d.Token()
		if err != nil {
			break
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			switch name := tok.Name.Local; {
			case name == "metadata" || name == "manifest" || name == "spine":
				section = name
				if name == "spine" {
					ncxID = attr(tok, "toc")
					book.RTL = attr(tok, "page-progression-direction") == "rtl"
				}
			case section == "metadata" && (name == "title" && book.Title == "" || name == "creator" && book.Creator == "" ||
				name == "language" && book.Language == ""):
				field = map[string]*string{"title": &book.Title, "creator": &book.Creator, "language": &book.Language}[name]
				text.Reset()
			case section == "metadata" && name == "meta":
				if attr(tok, "name") == "cover" && coverRef == "" {
					// The first, as the editor takes it (see scanOPF).
					coverRef = attr(tok, "content")
				}
				if attr(tok, "property") == "rendition:layout" {
					field = new(string)
					layout = true
					text.Reset()
				}
			case section == "manifest" && name == "item" && len(manifest) < maxEpubEntries:
				if href, _, ok := epubResolve(opfPath, attr(tok, "href")); ok {
					it := epubManifestItem{href, attr(tok, "media-type"), attr(tok, "properties")}
					manifest[attr(tok, "id")] = it
					if coverImage == nil && strings.Contains(" "+it.properties+" ", " cover-image ") {
						coverImage = &it
					}
				}
			case section == "spine" && name == "itemref" && len(spine)+len(nonLinear) < maxEpubSpine:
				if attr(tok, "linear") == "no" {
					nonLinear = append(nonLinear, attr(tok, "idref"))
				} else {
					spine = append(spine, attr(tok, "idref"))
				}
			}
		case xml.CharData:
			if field != nil && text.Len() < 2000 {
				text.Write(tok)
			}
		case xml.EndElement:
			if field != nil {
				s := strings.Join(strings.Fields(text.String()), " ")
				if layout {
					book.Fixed = s == "pre-paginated"
				} else {
					*field = s
				}
				field, layout = nil, false
			}
			if tok.Name.Local == section {
				section = ""
			}
		}
	}
	if len(spine) == 0 {
		spine = nonLinear
	}
	for _, id := range spine {
		if it, ok := manifest[id]; ok && z.files[it.href] != nil {
			book.Spine = append(book.Spine, it.href)
		}
	}
	if len(book.Spine) == 0 {
		return nil, errEpubNotBook
	}
	// What the book names as its cover, even if it's not in the book, as
	// happens: the editor puts one there.
	book.Cover = epubCover(manifest, opfPath, coverImage, coverRef)

	// Pictures in the book, from the manifest: for choosing one as the cover.
	seenPic := map[string]bool{}
	for _, it := range manifest {
		if seenPic[it.href] || z.files[it.href] == nil || epubPictureType(it.href) == "" ||
			it.mediaType != "" && !strings.HasPrefix(it.mediaType, "image/") ||
			z.files[it.href].UncompressedSize64 > uint64(maxEpubPicture) {
			continue
		}
		book.Pictures = append(book.Pictures, it.href)
		seenPic[it.href] = true
	}
	slices.Sort(book.Pictures)

	// The contents: EPUB 3's nav, else EPUB 2's NCX.
	for _, it := range manifest {
		if strings.Contains(" "+it.properties+" ", " nav ") {
			book.TOC = z.navContents(it.href)
			break
		}
	}
	if len(book.TOC) == 0 {
		ncx, ok := manifest[ncxID]
		if !ok {
			for _, it := range manifest {
				if it.mediaType == "application/x-dtbncx+xml" {
					ncx, ok = it, true
					break
				}
			}
		}
		if ok {
			book.TOC = z.ncxContents(ncx.href)
		}
	}
	return book, nil
}

// navContents reads the contents from EPUB 3's nav document, at name: the
// <nav epub:type="toc">, or failing that, the first <nav>.
func (z *epubZip) navContents(name string) []epubTOCItem {
	b, err := z.read(name, maxEpubMeta)
	if err != nil {
		return nil
	}
	for _, tocOnly := range []bool{true, false} {
		var out []epubTOCItem
		d := epubXML(b, true)
		inNav, navDepth, depth := false, 0, 0
		// The label being read: from the <a> or <span> that opened it, at
		// labelDepth, to its end, whatever's in it (<a><span>Chapter</span>
		// <span>One</span></a>); a link in a span takes the link's place
		// (<span><a href>One</a></span>).
		var label *strings.Builder
		labelDepth := 0
		var link epubTOCItem
		for len(out) < maxEpubTOC {
			tok, err := d.Token()
			if err != nil {
				break
			}
			switch tok := tok.(type) {
			case xml.StartElement:
				depth++
				switch tok.Name.Local {
				case "nav":
					if !inNav && (!tocOnly || strings.Contains(" "+attr(tok, "type")+" ", " toc ")) {
						inNav, navDepth = true, depth
					}
				case "ol":
					if inNav {
						link.Level++
					}
				case "a", "span":
					if !inNav {
						break
					}
					item, frag, ok := epubResolve(name, attr(tok, "href"))
					if !ok || attr(tok, "href") == "" || tok.Name.Local != "a" {
						item = "" // a heading, going nowhere
					}
					if label == nil {
						link.Item, link.Frag = item, prefixID(frag)
						label, labelDepth = &strings.Builder{}, depth
					} else if link.Item == "" && item != "" {
						link.Item, link.Frag = item, prefixID(frag)
					}
				}
			case xml.CharData:
				if label != nil && label.Len() < 1000 {
					label.Write(tok)
				}
			case xml.EndElement:
				switch tok.Name.Local {
				case "ol":
					if inNav && link.Level > 0 {
						link.Level--
					}
				case "a", "span":
					if label != nil && depth == labelDepth {
						link.Label = strings.Join(strings.Fields(label.String()), " ")
						if link.Label != "" && link.Item != "" && z.files[link.Item] != nil {
							out = append(out, epubTOCItem{link.Label, link.Item, link.Frag, max(link.Level, 1)})
						}
						label = nil
					}
				}
				if inNav && depth == navDepth && tok.Name.Local == "nav" {
					inNav = false
					if len(out) > 0 {
						return out
					}
				}
				depth--
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

// ncxContents reads the contents from EPUB 2's NCX, at name.
func (z *epubZip) ncxContents(name string) []epubTOCItem {
	b, err := z.read(name, maxEpubMeta)
	if err != nil {
		return nil
	}
	var out []epubTOCItem
	// Each navPoint's label and target, at its depth, kept till both are
	// read; the entry goes in when its target is.
	type point struct {
		label     string
		item      string
		frag      string
		level     int
		added     bool
		inLabel   bool
		labelText strings.Builder
	}
	var stack []*point
	d := epubXML(b, false)
	for len(out) < maxEpubTOC {
		tok, err := d.Token()
		if err != nil {
			break
		}
		var top *point
		if len(stack) > 0 {
			top = stack[len(stack)-1]
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			switch tok.Name.Local {
			case "navPoint":
				stack = append(stack, &point{level: len(stack) + 1})
			case "navLabel":
				if top != nil {
					top.inLabel = true
				}
			case "content":
				if top != nil && !top.added {
					if item, frag, ok := epubResolve(name, attr(tok, "src")); ok && z.files[item] != nil {
						top.item, top.frag = item, prefixID(frag)
						if top.label != "" {
							out = append(out, epubTOCItem{top.label, top.item, top.frag, top.level})
							top.added = true
						}
					}
				}
			}
		case xml.CharData:
			if top != nil && top.inLabel && top.labelText.Len() < 1000 {
				top.labelText.Write(tok)
			}
		case xml.EndElement:
			switch tok.Name.Local {
			case "navLabel":
				if top != nil {
					top.inLabel = false
					top.label = strings.Join(strings.Fields(top.labelText.String()), " ")
					if top.item != "" && top.label != "" && !top.added {
						out = append(out, epubTOCItem{top.label, top.item, top.frag, top.level})
						top.added = true
					}
				}
			case "navPoint":
				if len(stack) > 0 {
					stack = stack[:len(stack)-1]
				}
			}
		}
	}
	return out
}

// prefixID is the ID id has in a chapter as shown (see renderChapter), so
// none clashes with the frame's own.
func prefixID(id string) string {
	if id == "" {
		return ""
	}
	return "b-" + id
}

// epubItemURL is the path of item in the book as a relative URL, as a
// chapter's links and pictures are given: the frame reads it back.
func epubItemURL(item, frag string) string {
	u := (&url.URL{Path: item}).String()
	if frag != "" {
		u += "#" + url.PathEscape(prefixID(frag))
	}
	return u
}

// The elements left out of a chapter with all they hold, and the ones with
// no end tag.
var (
	epubDropped = map[string]bool{"head": true, "script": true, "style": true, "noscript": true, "template": true,
		"iframe": true, "object": true, "embed": true, "math": true, "title": true, "link": true, "meta": true,
		"textarea": true, "select": true, "button": true, "audio": true, "video": true, "canvas": true}
	epubVoid = map[string]bool{"area": true, "br": true, "col": true, "hr": true, "img": true, "input": true,
		"source": true, "track": true, "wbr": true}
	epubElementName = regexp.MustCompile(`^[a-z][a-z0-9]{0,15}$`)
	// The attributes kept, besides id, href and src, which are rewritten.
	epubAttrs = map[string]bool{"alt": true, "title": true, "lang": true, "dir": true, "colspan": true, "rowspan": true,
		"start": true}
)

// epubPolicy checks the rewritten chapter, after its XML allowlist.
// Its distinct trust boundary is documented in docs/preview-security.md.
var epubPolicy = func() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	p.AllowElements("figure", "figcaption", "section", "article", "aside", "header", "footer", "nav", "ruby", "rt", "rp",
		"rb", "small", "sup", "sub", "span", "div", "abbr", "cite", "dfn", "kbd", "samp", "var", "mark", "time")
	p.AllowAttrs("id").Matching(regexp.MustCompile(`^b-[\pL\pN_.:-]{1,200}$`)).Globally()
	p.AllowDataURIImages()
	p.RequireNoReferrerOnLinks(true)
	p.AddTargetBlankToFullyQualifiedLinks(true)
	return p
}()

// epubDataPicture is src, a picture in the chapter itself as a data: URI
// (base64 GIF, JPEG, PNG, SVG or WebP), as the chapter is given it: its
// type in lower case, and without the line breaks books wrap it with; ok is
// false for anything else. (epubPolicy then checks it decodes.)
func epubDataPicture(src string) (string, bool) {
	src = strings.Join(strings.Fields(src), "")
	m := epubDataPictureURI.FindStringSubmatch(src)
	if m == nil {
		return "", false
	}
	return "data:image/" + strings.ToLower(m[1]) + ";base64," + src[len(m[0]):], true
}

var epubDataPictureURI = regexp.MustCompile(`(?i)^data:image/(gif|jpeg|png|svg\+xml|webp);base64,`)

// renderChapter returns the chapter at name in the book as HTML: its body,
// with links and pictures as paths in the book (see epubItemURL), and its
// IDs prefixed (see prefixID), cleaned.
func (z *epubZip) renderChapter(chapter string) (string, error) {
	switch strings.ToLower(path.Ext(chapter)) {
	case ".xhtml", ".html", ".htm", ".xml":
	default:
		return "", errors.New("it isn't a chapter")
	}
	src, err := z.read(chapter, maxEpubChapter)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	d := epubXML(src, true)
	// skip counts the elements being left out, with what's in them;
	// open, those written, by name, to close each as it was written
	// (a name not written is closed by nothing). Before the body is
	// reached, nothing is written.
	skip, inBody, sawBody := 0, false, false
	var open []string
	inSVG := 0
	for {
		tok, err := d.Token()
		if err != nil {
			if err != io.EOF && out.Len() == 0 && !sawBody {
				return "", fmt.Errorf("it can't be read: %v", err)
			}
			break
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			name := strings.ToLower(tok.Name.Local)
			if name == "body" && !sawBody {
				inBody, sawBody = true, true
				open = append(open, "")
				continue
			}
			if !inBody || skip > 0 || epubDropped[name] {
				if inBody {
					skip++
				}
				open = append(open, "")
				continue
			}
			if name == "svg" {
				// Only its pictures, as a cover's often is.
				inSVG++
				open = append(open, "")
				continue
			}
			if inSVG > 0 {
				if name == "image" {
					if d, ok := epubDataPicture(attr(tok, "href")); ok {
						out.WriteString(`<img src="` + html.EscapeString(d) + `" alt="">`)
					} else if item, _, ok := epubResolve(chapter, attr(tok, "href")); ok {
						out.WriteString(`<img src="` + html.EscapeString(epubItemURL(item, "")) + `" alt="">`)
					}
				}
				open = append(open, "")
				continue
			}
			if !epubElementName.MatchString(name) {
				open = append(open, "")
				continue
			}
			out.WriteString("<" + name)
			for _, a := range tok.Attr {
				local := strings.ToLower(a.Name.Local)
				v := a.Value
				switch {
				case local == "id":
					v = prefixID(v)
				case local == "href" && name == "a":
					if item, frag, ok := epubResolve(chapter, v); ok {
						v = epubItemURL(item, frag)
					} else if !webLink.MatchString(strings.TrimSpace(v)) {
						continue
					}
				case local == "src" && name == "img":
					if d, ok := epubDataPicture(v); ok {
						v = d
						break
					}
					item, _, ok := epubResolve(chapter, v)
					if !ok {
						continue
					}
					v = epubItemURL(item, "")
				case !epubAttrs[local] || a.Name.Space != "" && local != "lang":
					continue
				}
				out.WriteString(" " + local + `="` + html.EscapeString(v) + `"`)
			}
			out.WriteString(">")
			if epubVoid[name] {
				open = append(open, "")
			} else {
				open = append(open, name)
			}
		case xml.EndElement:
			if len(open) == 0 {
				continue
			}
			name := strings.ToLower(tok.Name.Local)
			top := open[len(open)-1]
			open = open[:len(open)-1]
			switch {
			case skip > 0:
				// (First: a <body> within what's left out, as some books
				// have, is left out with it, not taken as the chapter's end.)
				skip--
			case name == "body" && top == "":
				inBody = false
			case name == "svg" && inSVG > 0:
				inSVG--
			case top != "":
				out.WriteString("</" + top + ">")
			}
		case xml.CharData:
			if inBody && skip == 0 && inSVG == 0 {
				out.WriteString(html.EscapeString(string(tok)))
			}
		}
		if out.Len() > maxEpubChapter*2 {
			return "", errEpubTooBig
		}
	}
	return epubPolicy.Sanitize(out.String()), nil
}

// EPUB's image subset is declared alongside browser MIME/kind metadata.
func epubPictureType(name string) string {
	kind := fileTypes[strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")]
	if kind.EpubPicture {
		return kind.MIME
	}
	return ""
}

// renderEpubChild is main for the child: the book on stdin; args say what
// of it: "book", "chapter <name>", "picture <name>", or "edit <edit>" (see
// epubEditChild). It answers on
// stdout: the book or {html} as JSON, or the picture's bytes; or, failing,
// why, with status 1.
func renderEpubChild(args []string) int {
	out, err := epubChildAnswer(os.Stdin, args)
	if err != nil {
		fmt.Fprint(os.Stdout, err)
		return 1
	}
	os.Stdout.Write(out)
	return 0
}

func epubChildAnswer(f *os.File, args []string) ([]byte, error) {
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return nil, errEpubNotBook
	}
	z, err := openEpubZip(f, st.Size())
	if err != nil {
		return nil, err
	}
	switch {
	case len(args) == 1 && args[0] == "book":
		book, err := z.readBook()
		if err != nil {
			return nil, err
		}
		return json.Marshal(book)
	case len(args) == 2 && args[0] == "chapter":
		if z.protected() {
			return nil, errEpubProtected
		}
		h, err := z.renderChapter(args[1])
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]string{"html": h})
	case len(args) == 2 && args[0] == "edit":
		return epubEditChild(z, args)
	case len(args) == 2 && args[0] == "picture":
		if epubPictureType(args[1]) == "" {
			return nil, errors.New("it isn't a picture")
		}
		if z.protected() {
			return nil, errEpubProtected
		}
		return z.read(args[1], maxEpubPicture)
	}
	return nil, errors.New("not a question the child answers")
}

// epubFrameHTML is the book's frame's page, served with the Markdown
// frame's CSP (mdFrameCSP): scripts only from the site, pictures only as
// blob: and data: URLs, and nothing fetched.
var epubFrameHTML = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\n" +
	"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Book</title>\n<style>" +
	epubFrameCSS + "</style>\n<div id=\"bar\"></div><nav id=\"contents\" hidden aria-label=\"Contents\"></nav>" +
	"<main id=\"doc\"></main><nav id=\"ends\" aria-label=\"Chapters\"></nav>\n<script src=\"epub-frame.js\"></script>\n"

var epubSlots = newPreviewWork(previewReadConcurrency)

// readEpubIsolated asks a child about the book open as f (see
// renderEpubChild).
func readEpubIsolated(f *os.File, args ...string) ([]byte, error) {
	release, ok := epubSlots.acquire()
	if !ok {
		return nil, errEpubBusy
	}
	defer release()
	return runEpubChild(f, epubTimeout, nil, args...)
}

// runEpubChild runs a child on the book open as f, with args, and extra
// as its file descriptors from 3, killed after timeout, and returns its
// answer.
func runEpubChild(f *os.File, timeout time.Duration, extra []*os.File, args ...string) ([]byte, error) {
	result := runIsolatedChild(isolatedChild{Args: append([]string{epubChildArg}, args...), Input: f, ExtraFiles: extra, Timeout: timeout, OutputLimit: maxEpubOut})
	switch {
	case result.TimedOut:
		return nil, errEpubSlow
	case result.Overflow:
		return nil, errEpubTooBig
	case result.Err != nil && result.ExitCode == 1 && len(result.Output) < 300:
		return nil, errors.New(string(result.Output))
	case result.Err != nil:
		return nil, errors.New("it couldn't be read")
	}
	return result.Output, nil
}

// tunnelEpub answers an "epub" request: the book at req.Path, or with
// req.Item, a chapter or picture of it (see the top of this file).
func (g *server) tunnelEpub(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	opened, err := openDownloadsFile(g.downloadsDir, req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	f, st := opened.file, opened.info
	if req.IfMtime != "" && (fileVersion(st) != req.IfMtime || st.Size() != req.IfSize) {
		r.fail(errEpubChanged.Error())
		return
	}
	switch {
	case req.Item == "":
		out, err := readEpubIsolated(f, "book")
		if err != nil {
			r.fail(err.Error())
			return
		}
		var book epubBook
		if json.Unmarshal(out, &book) != nil {
			r.fail(errEpubNotBook.Error())
			return
		}
		r.finish(map[string]any{"book": book, "size": st.Size(), "mtime": fileVersion(st)})
	case epubPictureType(req.Item) != "":
		out, err := readEpubIsolated(f, "picture", req.Item)
		if err != nil {
			r.fail(err.Error())
			return
		}
		if !r.accept(map[string]any{"size": len(out), "mime": epubPictureType(req.Item)}) {
			return
		}
		w := newChunkWriter(t)
		defer w.stop()
		if _, err := w.Write(out); err != nil {
			w.fail(err)
			return
		}
		if w.flush() == nil {
			r.finish(nil)
		}
	default:
		out, err := readEpubIsolated(f, "chapter", req.Item)
		if err != nil {
			r.fail(err.Error())
			return
		}
		var chapter struct {
			HTML string `json:"html"`
		}
		if json.Unmarshal(out, &chapter) != nil {
			r.fail("It couldn't be read.")
			return
		}
		r.finish(map[string]any{"html": chapter.HTML})
	}
}
