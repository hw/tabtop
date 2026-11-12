package main

// Trimming a book: which of its pictures are used, and by what, so the
// book's details can offer to remove those nothing uses (and the old
// cover, once a new one's chosen), and editBook can refuse to remove one
// something still does.
//
// A picture is used by a file in the book that refers to it: a page's
// src, href, xlink:href, data, poster or srcset; a stylesheet's url() or
// @import; or, in the package file, a spine entry, a fallback or a guide
// reference naming it. As a safety net, a file in which its name appears
// at all (in a script, say, or markup this doesn't read) counts as using
// it too: a picture kept that could have gone is better than a page broken.
//
// A cover page is a page with one picture that the book marks as its cover
// page (the guide's type="cover", or epub:type="cover" in it), or, if its
// picture is the cover, that has next to no text besides: the page many
// books open with. A chapter that happens to show only the cover, with
// text, isn't one, nor is a page that's only an illustration. A picture
// only cover pages show can go: they're made to show the cover instead
// (see repointCover). That's the old cover, once a new one's chosen; or a
// former cover a cover page was left showing.

import (
	"bytes"
	"html"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"
)

// The most text, in characters, a cover page the guide doesn't mark may
// have: a caption, say, but not a paragraph.
const maxCoverPageText = 20

// epubPictureUse is a picture in the book, what removing it would save
// (its size, packed), and what uses it.
type epubPictureUse struct {
	Path       string   `json:"path"`
	Bytes      int64    `json:"bytes"`
	Cover      bool     `json:"cover,omitempty"`
	Users      []string `json:"users,omitempty"`       // files that use it, or may
	CoverPages []string `json:"cover_pages,omitempty"` // of those, pages that are only it
}

var (
	// An attribute that can name a file, and its value.
	epubRefAttr = regexp.MustCompile(`(?i)[\s"'](?:src|href|xlink:href|data|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	epubSrcset  = regexp.MustCompile(`(?i)[\s"']srcset\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	// A stylesheet's url(...), and @import "...".
	epubCSSURL    = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)`)
	epubCSSImport = regexp.MustCompile(`(?i)@import\s+(?:"([^"]*)"|'([^']*)')`)
	// An attribute of the package file naming an item by its ID.
	epubIDRef = regexp.MustCompile(`(?i)\s(?:idref|fallback|fallback-style)\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	// A page saying it's the cover (EPUB 3's structural semantics).
	epubTypeCover = regexp.MustCompile(`(?i)\sepub:type\s*=\s*["'](?:[^"']*\s)?cover(?:\s[^"']*)?["']`)
	// A guide reference marking the cover.
	epubGuideCover = regexp.MustCompile(`(?i)\stype\s*=\s*["']cover["']`)
	// What isn't a page's text: its head, styles, scripts, and tags.
	epubNotText = regexp.MustCompile(`(?is)<head\b.*?</head>|<style\b.*?</style>|<script\b.*?</script>|<[^>]*>`)
)

// epubTextFile reports whether name is a file that can refer to others.
func epubTextFile(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".xhtml", ".html", ".htm", ".xml", ".svg", ".css", ".ncx", ".smil", ".js":
		return true
	}
	return false
}

// epubPage reports whether name is a page, which can be a cover page.
func epubPage(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".xhtml", ".html", ".htm":
		return true
	}
	return false
}

// epubRefs is what the file base, holding data, refers to, as paths in
// the book.
func epubRefs(base string, data []byte) map[string]bool {
	refs := map[string]bool{}
	add := func(v string) {
		if p, _, ok := epubResolve(base, html.UnescapeString(v)); ok {
			refs[p] = true
		}
	}
	first := func(m [][]byte) string {
		for _, g := range m[1:] {
			if g != nil {
				return string(g)
			}
		}
		return ""
	}
	for _, m := range epubRefAttr.FindAllSubmatch(data, -1) {
		add(first(m))
	}
	for _, m := range epubSrcset.FindAllSubmatch(data, -1) {
		for _, c := range strings.Split(first(m), ",") {
			if f := strings.Fields(c); len(f) > 0 {
				add(f[0])
			}
		}
	}
	for _, re := range []*regexp.Regexp{epubCSSURL, epubCSSImport} {
		for _, m := range re.FindAllSubmatch(data, -1) {
			add(first(m))
		}
	}
	return refs
}

// unexplained is data without the references epubRefs reads, so what's
// left names a file only in ways it doesn't: a picture named there may be
// used, though no reference says so.
func unexplained(data []byte) []byte {
	for _, re := range []*regexp.Regexp{epubRefAttr, epubSrcset, epubCSSURL, epubCSSImport} {
		data = re.ReplaceAll(data, []byte(" "))
	}
	return data
}

// epubNameToken is a run of the characters a plain file name is made of.
var epubNameToken = regexp.MustCompile(`[A-Za-z0-9_.%+~-]+`)

// namesIn is the picture-like file names data mentions: what mentions
// looks names up in, rather than searching data once for each.
func namesIn(data []byte) map[string]bool {
	names := map[string]bool{}
	for _, m := range epubNameToken.FindAll(data, -1) {
		if bytes.IndexByte(m, '.') >= 0 && epubPictureType(string(m)) != "" {
			names[string(m)] = true
		}
	}
	return names
}

// mentions reports whether data, whose plain picture names are names (see
// namesIn), names the picture p, as it is or escaped as a URL would be. A
// name of other characters (a space, say) is searched for in data itself.
func mentions(data []byte, names map[string]bool, p string) bool {
	name := path.Base(p)
	if epubNameToken.FindString(name) == name {
		return names[name] || names[url.PathEscape(name)]
	}
	return bytes.Contains(data, []byte(name)) || bytes.Contains(data, []byte(url.PathEscape(name)))
}

// pictureScan is where pictureUses looks: the package file (at opfPath,
// already read), the manifest whose IDs the package file may name the
// pictures by, and the files to read.
type pictureScan struct {
	opfPath string
	opf     []byte
	// The manifest as the book has it, so a picture whose item is removed
	// from opf is still found by its ID (in a spine entry, say).
	items map[string]epubManifestItem
	// Files read as these, rather than as the book has them; with only,
	// the only files read (besides the package file, which is opf).
	override map[string][]byte
	only     bool
	// Pages in which a picture's name mentioned isn't a use, only a
	// reference: cover pages made to show the new cover, whose alt text,
	// say, may still name the old one.
	refsOnly map[string]bool
}

// packageScan is a pictureScan of the whole book as it is.
func (z *epubZip) packageScan() (pictureScan, *opfScan, error) {
	opfPath, opf, err := z.packageFile()
	if err != nil {
		return pictureScan{}, nil, err
	}
	sc, err := scanOPF(opf, opfPath)
	if err != nil {
		return pictureScan{}, nil, err
	}
	return pictureScan{opfPath: opfPath, opf: opf, items: sc.items}, sc, nil
}

// epubGuideRef is a guide's <reference>.
var epubGuideRef = regexp.MustCompile(`(?is)<(?:\w+:)?reference\b[^>]*>`)

// pictureUses says, of each of pictures (paths in the book), what uses
// it, as ps says to look. A file too big to read uses every picture.
func (z *epubZip) pictureUses(ps pictureScan, pictures []string, cover string) ([]epubPictureUse, error) {
	opfPath, opf := ps.opfPath, ps.opf
	uses := make([]epubPictureUse, len(pictures))
	index := map[string]int{}
	for i, p := range pictures {
		uses[i] = epubPictureUse{Path: p, Cover: p == cover}
		if f := z.files[p]; f != nil {
			uses[i].Bytes = int64(f.CompressedSize64)
		}
		index[p] = i
	}
	use := func(i int, name string) {
		if !slices.Contains(uses[i].Users, name) {
			uses[i].Users = append(uses[i].Users, name)
		}
	}
	// The package file: spine entries, fallbacks and guide references.
	byID := map[string]int{}
	for id, it := range ps.items {
		if i, ok := index[it.href]; ok {
			byID[id] = i
		}
	}
	for _, m := range epubIDRef.FindAllSubmatch(opf, -1) {
		id := string(m[1])
		if id == "" {
			id = string(m[2])
		}
		if i, ok := byID[id]; ok {
			use(i, opfPath)
		}
	}
	coverMarked := map[string]bool{} // pages the guide marks as the cover
	for _, m := range epubGuideRef.FindAll(opf, -1) {
		marksCover := epubGuideCover.Match(m)
		for ref := range epubRefs(opfPath, m) {
			if marksCover {
				coverMarked[ref] = true
			}
			if i, ok := index[ref]; ok {
				use(i, opfPath)
			}
		}
	}
	// Every other file that can refer to one.
	var names []string
	if !ps.only {
		for name := range z.files {
			names = append(names, name)
		}
	}
	for name := range ps.override {
		if ps.only || z.files[name] == nil {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	for _, name := range names {
		if name == opfPath || !epubTextFile(name) {
			continue
		}
		data, ok := ps.override[name]
		if !ok {
			var err error
			if data, err = z.read(name, maxEpubChapter); err != nil {
				// Not read: taken to use every picture, rather than risk one.
				for i := range uses {
					uses[i].Users = append(uses[i].Users, name)
				}
				continue
			}
		}
		refs := epubRefs(name, data)
		var rest []byte
		var mentioned map[string]bool
		if !ps.refsOnly[name] {
			rest = unexplained(data)
			mentioned = namesIn(rest)
		}
		var used []int
		for i, u := range uses {
			if refs[u.Path] || mentioned != nil && mentions(rest, mentioned, u.Path) {
				used = append(used, i)
			}
		}
		for _, i := range used {
			uses[i].Users = append(uses[i].Users, name)
		}
		// A cover page: a page whose one picture is the cover, marked as
		// the cover, or with next to nothing else to read.
		if len(used) == 1 && epubPage(name) && (coverMarked[name] || epubTypeCover.Match(data) || uses[used[0]].Cover &&
			len([]rune(strings.Join(strings.Fields(html.UnescapeString(string(epubNotText.ReplaceAll(data, []byte(" "))))), " "))) <= maxCoverPageText) {
			uses[used[0]].CoverPages = append(uses[used[0]].CoverPages, name)
		}
	}
	return uses, nil
}

// relativeRef is how a file in the folder dir refers to target, both in
// the book: a relative URL.
func relativeRef(dir, target string) string {
	from := strings.Split(dir, "/")
	if dir == "." || dir == "" {
		from = nil
	}
	to := strings.Split(target, "/")
	common := 0
	for common < len(from) && common < len(to)-1 && from[common] == to[common] {
		common++
	}
	parts := []string{}
	for range from[common:] {
		parts = append(parts, "..")
	}
	for _, s := range to[common:] {
		parts = append(parts, url.PathEscape(s))
	}
	return strings.Join(parts, "/")
}

// pictureReport is the child's answer to "pictures": what uses each
// of the book's pictures.
func (z *epubZip) pictureReport() ([]epubPictureUse, error) {
	if z.protected() {
		return nil, errEpubProtected
	}
	ps, sc, err := z.packageScan()
	if err != nil {
		return nil, err
	}
	pictures, cover := z.allPictures(ps.opfPath, sc)
	return z.pictureUses(ps, pictures, cover)
}

// allPictures is every picture the manifest lists that's in the book, of
// any size (the cover picker leaves out those too big to show; trimming
// wants them most), and the cover, from the package file at opfPath.
func (z *epubZip) allPictures(opfPath string, sc *opfScan) ([]string, string) {
	var pictures []string
	for _, it := range sc.items {
		if z.files[it.href] != nil && epubPictureType(it.href) != "" && (it.mediaType == "" || strings.HasPrefix(it.mediaType, "image/")) &&
			!slices.Contains(pictures, it.href) {
			pictures = append(pictures, it.href)
		}
	}
	slices.Sort(pictures)
	return pictures, epubCover(sc.items, opfPath, sc.coverImage, sc.coverRef)
}

// repointCover is the page base, holding data, with what it refers to as
// from (its src, href and the rest, srcset candidates, and url()s)
// referring to to instead, and how many it changed.
func repointCover(base string, data []byte, from, to string) ([]byte, int) {
	ref := relativeRef(path.Dir(base), to)
	n := 0
	swap := func(re *regexp.Regexp, quoted bool) {
		data = re.ReplaceAllFunc(data, func(m []byte) []byte {
			sub := re.FindSubmatchIndex(m)
			for g := 2; g+1 < len(sub); g += 2 {
				if sub[g] < 0 {
					continue
				}
				v := string(m[sub[g]:sub[g+1]])
				p, frag, ok := epubResolve(base, html.UnescapeString(v))
				if !ok || p != from {
					return m
				}
				nv := ref
				if frag != "" {
					nv += "#" + url.PathEscape(frag)
				}
				if quoted {
					nv = html.EscapeString(nv)
				} else {
					// A url() in a page: in its markup, where a raw & isn't
					// allowed (XHTML), or in a <style>, where &amp; isn't read
					// as one (HTML). As a URL, %26 is & either way.
					nv = strings.ReplaceAll(nv, "&", "%26")
				}
				n++
				return append(append(append([]byte{}, m[:sub[g]]...), nv...), m[sub[g+1]:]...)
			}
			return m
		})
	}
	swap(epubRefAttr, true)
	swap(epubCSSURL, false)
	// A srcset's candidates, each a URL and what it's for ("2x").
	data = epubSrcset.ReplaceAllFunc(data, func(m []byte) []byte {
		sub := epubSrcset.FindSubmatchIndex(m)
		for g := 2; g+1 < len(sub); g += 2 {
			if sub[g] < 0 {
				continue
			}
			cands := strings.Split(string(m[sub[g]:sub[g+1]]), ",")
			hit := false
			for i, c := range cands {
				f := strings.Fields(c)
				if len(f) == 0 {
					continue
				}
				if p, frag, ok := epubResolve(base, html.UnescapeString(f[0])); ok && p == from {
					nv := ref
					if frag != "" {
						nv += "#" + url.PathEscape(frag)
					}
					f[0] = html.EscapeString(nv)
					cands[i] = strings.Join(f, " ")
					hit = true
					n++
				}
			}
			if !hit {
				return m
			}
			return append(append(append([]byte{}, m[:sub[g]]...), strings.Join(cands, ", ")...), m[sub[g+1]:]...)
		}
		return m
	})
	return data, n
}
