package main

// Rebuilding a book's contents list from its chapters' headings (see
// Rebuild contents in the book's details dialog): anchored h1–h3 in each
// spine chapter, or its filename when there are no addressable headings.
// Written into EPUB 3's toc nav (landmarks and page-list in that file are
// kept), and into the NCX when the book already has one.

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// Match the IDs retained by epubPolicy when chapters are rendered.
var tocHeadingID = regexp.MustCompile(`^[\pL\pN_.:-]{1,200}$`)

// buildTOCFromSpine is the contents made from the book's linear spine: each
// chapter's addressable h1–h3, or one chapter-level entry from its filename.
func (z *epubZip) buildTOCFromSpine() ([]epubTOCItem, error) {
	book, err := z.readBook()
	if err != nil {
		return nil, err
	}
	var out []epubTOCItem
	for _, chapter := range book.Spine {
		if len(out) >= maxEpubTOC {
			break
		}
		items := z.headingsInChapter(chapter, maxEpubTOC-len(out))
		if len(items) == 0 {
			out = append(out, epubTOCItem{Label: tocFilenameLabel(chapter), Item: chapter, Level: 1})
			continue
		}
		out = append(out, items...)
	}
	if len(out) == 0 {
		return nil, errEpubNotBook
	}
	return out, nil
}

// headingsInChapter returns at most limit addressable h1–h3 headings. Frag is the existing ID, kept unchanged in the book.
// Unanchored headings cannot target a section; omit them rather than produce
// multiple contents links that all jump to the beginning of the chapter.
func (z *epubZip) headingsInChapter(name string, limit int) []epubTOCItem {
	if limit <= 0 {
		return nil
	}
	b, err := z.read(name, maxEpubChapter)
	if err != nil {
		return nil
	}
	var out []epubTOCItem
	d := epubXML(b, true)
	depth := 0
	var label *strings.Builder
	labelDepth := 0
	var cur epubTOCItem
	for len(out) < limit {
		tok, err := d.Token()
		if err != nil {
			break
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			depth++
			switch tok.Name.Local {
			case "h1", "h2", "h3":
				if label != nil {
					break
				}
				cur = epubTOCItem{Item: name, Frag: attr(tok, "id"), Level: int(tok.Name.Local[1] - '0')}
				label, labelDepth = &strings.Builder{}, depth
			}
		case xml.CharData:
			if label != nil && label.Len() < 1000 {
				label.Write(tok)
			}
		case xml.EndElement:
			if label != nil && depth == labelDepth {
				cur.Label = strings.Join(strings.Fields(label.String()), " ")
				if cur.Label != "" && tocHeadingID.MatchString(cur.Frag) {
					out = append(out, cur)
				}
				label = nil
			}
			depth--
		}
	}
	return out
}

// tocFilenameLabel is a chapter path as a contents label: its base name,
// without the extension.
func tocFilenameLabel(chapter string) string {
	base := path.Base(chapter)
	name := strings.TrimSuffix(base, path.Ext(base))
	if u, err := url.PathUnescape(name); err == nil {
		name = u
	}
	name = strings.Join(strings.Fields(strings.ReplaceAll(name, "_", " ")), " ")
	if name == "" {
		return "Chapter"
	}
	return name
}

// epubRelative is the path of target relative to fromDir, with / separators.
func epubRelative(fromDir, target string) string {
	if fromDir == "" || fromDir == "." {
		return target
	}
	from := strings.Split(fromDir, "/")
	to := strings.Split(target, "/")
	i := 0
	for i < len(from) && i < len(to) && from[i] == to[i] {
		i++
	}
	var b strings.Builder
	for j := i; j < len(from); j++ {
		b.WriteString("../")
	}
	b.WriteString(strings.Join(to[i:], "/"))
	return b.String()
}

// epubHref is the href from the file at from to item, with frag if any,
// percent-encoded as EPUB nav and NCX write them.
func epubHref(from, item, frag string) string {
	rel := epubRelative(path.Dir(from), item)
	parts := strings.Split(rel, "/")
	for i, p := range parts {
		if p != ".." && p != "." {
			parts[i] = url.PathEscape(p)
		}
	}
	href := strings.Join(parts, "/")
	if frag != "" {
		href += "#" + url.PathEscape(frag)
	}
	return href
}

// tocNavHTML is items as a single EPUB 3 toc <nav> element.
func tocNavHTML(items []epubTOCItem, navPath string) string {
	var b strings.Builder
	b.WriteString(`<nav epub:type="toc" id="toc"><h1>Contents</h1>` + "\n")
	appendNavOL(&b, items, navPath)
	b.WriteString(`</nav>`)
	return b.String()
}

// writeNavDocument is items as a minimal EPUB 3 nav document at navPath.
func writeNavDocument(items []epubTOCItem, navPath string) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` + "\n")
	b.WriteString(`<head><title>Contents</title></head><body>` + "\n")
	b.WriteString(tocNavHTML(items, navPath))
	b.WriteString(`</body></html>`)
	return []byte(b.String())
}

// rewriteNavDocument is the nav file at navPath with its toc <nav> replaced
// by items. Landmarks, page-list and the rest of the document are kept. If
// there is no toc nav, one is inserted before </body> (or appended).
func rewriteNavDocument(old []byte, items []epubTOCItem, navPath string) []byte {
	toc := []byte(tocNavHTML(items, navPath))
	start, end := findTOCNavBounds(old)
	if start >= 0 && end > start {
		var out bytes.Buffer
		out.Write(old[:start])
		out.Write(toc)
		out.Write(old[end:])
		return out.Bytes()
	}
	bodyEnd := bytes.LastIndex(bytes.ToLower(old), []byte("</body>"))
	if bodyEnd >= 0 {
		var out bytes.Buffer
		out.Write(old[:bodyEnd])
		out.WriteByte('\n')
		out.Write(toc)
		out.WriteByte('\n')
		out.Write(old[bodyEnd:])
		return out.Bytes()
	}
	var out bytes.Buffer
	out.Write(old)
	out.WriteByte('\n')
	out.Write(toc)
	return out.Bytes()
}

// findTOCNavBounds is the byte range of the toc <nav>…</nav> in b, or
// (-1, -1) if there isn't one. Prefers epub:type/type containing "toc".
func findTOCNavBounds(b []byte) (start, end int) {
	lower := bytes.ToLower(b)
	search := 0
	for {
		i := bytes.Index(lower[search:], []byte("<nav"))
		if i < 0 {
			return -1, -1
		}
		i += search
		gt := bytes.IndexByte(b[i:], '>')
		if gt < 0 {
			return -1, -1
		}
		tagEnd := i + gt + 1
		tag := strings.ToLower(string(b[i:tagEnd]))
		// A toc nav: type/epub:type includes toc as a token (not "toc-…" alone
		// as a different landmark name — "toc" as a space-separated value).
		if !navTypeHas(tag, "toc") {
			search = tagEnd
			continue
		}
		self := strings.HasSuffix(strings.TrimSpace(tag), "/>")
		if self {
			return i, tagEnd
		}
		depth := 1
		at := tagEnd
		for depth > 0 {
			next := bytes.Index(lower[at:], []byte("<nav"))
			closeAt := bytes.Index(lower[at:], []byte("</nav>"))
			if closeAt < 0 {
				return -1, -1
			}
			if next >= 0 && next < closeAt {
				open := at + next
				ogt := bytes.IndexByte(b[open:], '>')
				if ogt < 0 {
					return -1, -1
				}
				otag := string(b[open : open+ogt+1])
				if !strings.HasSuffix(strings.TrimSpace(otag), "/>") {
					depth++
				}
				at = open + ogt + 1
				continue
			}
			depth--
			at += closeAt
			if depth == 0 {
				return i, at + len("</nav>")
			}
			at += len("</nav>")
		}
	}
}

func navTypeHas(tag, want string) bool {
	// Match type="… toc …" or epub:type='…toc…' as space-separated tokens.
	for _, key := range []string{`epub:type=`, `type=`} {
		k := strings.Index(tag, key)
		if k < 0 {
			continue
		}
		rest := tag[k+len(key):]
		if rest == "" {
			continue
		}
		q := rest[0]
		if q != '"' && q != '\'' {
			continue
		}
		end := strings.IndexByte(rest[1:], q)
		if end < 0 {
			continue
		}
		for _, p := range strings.Fields(rest[1 : 1+end]) {
			if p == want {
				return true
			}
		}
	}
	return false
}

func appendNavOL(b *strings.Builder, items []epubTOCItem, navPath string) {
	b.WriteString("<ol>\n")
	for i := 0; i < len(items); {
		it := items[i]
		href := epubHref(navPath, it.Item, it.Frag)
		b.WriteString(`<li><a href="` + xmlText(href) + `">` + xmlText(it.Label) + `</a>`)
		j := i + 1
		for j < len(items) && items[j].Level > it.Level {
			j++
		}
		if j > i+1 {
			appendNavOL(b, items[i+1:j], navPath)
		}
		b.WriteString("</li>\n")
		i = j
	}
	b.WriteString("</ol>\n")
}

// rewriteNCXNavMap is the NCX at ncxPath with its navMap replaced by items.
// The rest of the file (docTitle, docAuthor) is kept. If it has no navMap,
// a minimal NCX is written.
func rewriteNCXNavMap(old []byte, items []epubTOCItem, ncxPath string) []byte {
	start := bytes.Index(old, []byte("<navMap"))
	end := bytes.Index(old, []byte("</navMap>"))
	if start < 0 || end < 0 || end < start {
		return writeMinimalNCX(items, ncxPath)
	}
	gt := bytes.IndexByte(old[start:], '>')
	if gt < 0 {
		return writeMinimalNCX(items, ncxPath)
	}
	var mid strings.Builder
	mid.Write(old[start : start+gt+1])
	mid.WriteByte('\n')
	id := 0
	appendNCXPoints(&mid, items, ncxPath, &id)
	mid.WriteString("</navMap>")
	var out bytes.Buffer
	out.Write(old[:start])
	out.WriteString(mid.String())
	out.Write(old[end+len("</navMap>"):])
	return out.Bytes()
}

func writeMinimalNCX(items []epubTOCItem, ncxPath string) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` + "\n")
	b.WriteString(`<head/><docTitle><text>Contents</text></docTitle><navMap>` + "\n")
	id := 0
	appendNCXPoints(&b, items, ncxPath, &id)
	b.WriteString(`</navMap></ncx>`)
	return []byte(b.String())
}

func appendNCXPoints(b *strings.Builder, items []epubTOCItem, ncxPath string, id *int) {
	for i := 0; i < len(items); {
		it := items[i]
		*id++
		n := *id
		src := epubHref(ncxPath, it.Item, it.Frag)
		fmt.Fprintf(b, `<navPoint id="np-%d" playOrder="%d"><navLabel><text>%s</text></navLabel><content src="%s"/>`,
			n, n, xmlText(it.Label), xmlText(src))
		j := i + 1
		for j < len(items) && items[j].Level > it.Level {
			j++
		}
		if j > i+1 {
			appendNCXPoints(b, items[i+1:j], ncxPath, id)
		}
		b.WriteString("</navPoint>\n")
		i = j
	}
}

// findNavItem is the manifest id and path of the book's nav document, if any.
func findNavItem(sc *opfScan) (id, href string) {
	for _, el := range sc.itemEls {
		if strings.Contains(" "+el.attrs["properties"]+" ", " nav ") {
			return el.attrs["id"], el.href
		}
	}
	return "", ""
}

// findNCXItem is the path of the book's NCX, if any.
func findNCXItem(sc *opfScan) string {
	for _, it := range sc.items {
		if it.mediaType == "application/x-dtbncx+xml" {
			return it.href
		}
	}
	return ""
}

// freeOPFName is a filename beside the OPF not used in the book, starting
// from base (e.g. "nav.xhtml").
func (z *epubZip) freeOPFName(opfPath, base string) string {
	dir := path.Dir(opfPath)
	taken := map[string]bool{}
	for _, f := range z.all {
		taken[f.Name] = true
	}
	ext := path.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	name := base
	for i := 2; taken[path.Join(dir, name)]; i++ {
		name = fmt.Sprintf("%s-%d%s", stem, i, ext)
	}
	return name
}

// freeManifestID is an unused manifest id, starting from base.
func freeManifestID(sc *opfScan, base string) string {
	id := base
	for i := 2; ; i++ {
		if _, ok := sc.items[id]; !ok {
			return id
		}
		id = fmt.Sprintf("%s-%d", base, i)
	}
}
