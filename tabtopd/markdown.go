package main

// Markdown previews: tabtopd turns a .md file into HTML for the files
// page's preview, which shows it in a sandboxed frame of its own (see
// md-frame.js), where nothing in it can reach the site. The HTML is made
// with goldmark, GitHub's flavour (tables, task lists, strikethrough,
// autolinks), with raw HTML in the file left out, and then cleaned with
// bluemonday, allowing only plain formatting, as defence in depth: the
// frame is what keeps the site safe, this keeps what's shown plain.
//
// Math ($…$ inline, $$…$$ and ```math blocks for display) and Mermaid
// diagrams (```mermaid blocks) are left as their source, escaped, marked
// with a class, and the frame renders them: KaTeX, to MathML, and Mermaid,
// to SVG. Code blocks keep their language as a class, which the frame
// colours with highlight.js.

import (
	"bytes"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// The biggest Markdown file previewed, as for other text (see limits in
// preview.js).
const maxMarkdown = 2_000_000

var markdownConverter = goldmark.New(
	goldmark.WithExtensions(extension.GFM, previewMarkdown{}),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
)

// headingIDs makes headings' IDs, as goldmark's own do ("A title" is
// a-title, the next a-title-1, and so on), but in time linear in the
// headings: goldmark's tries each number from 1 again for every heading
// with the same text, so a file of many of them took minutes.
type headingIDs struct {
	used map[string]bool
	next map[string]int // for each ID, the number to try next
}

func newHeadingIDs() *headingIDs {
	return &headingIDs{used: map[string]bool{}, next: map[string]int{}}
}

func (h *headingIDs) Generate(value []byte, kind ast.NodeKind) []byte {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(string(value))) {
		switch {
		case unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-':
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteByte('-')
		}
		if b.Len() >= 90 {
			break
		}
	}
	base := b.String()
	if base == "" {
		base = "heading"
	}
	id := base
	for n := h.next[base]; h.used[id]; n++ {
		if n == 0 {
			continue
		}
		id = fmt.Sprintf("%s-%d", base, n)
		h.next[base] = n + 1
	}
	h.used[id] = true
	return []byte(id)
}

func (h *headingIDs) Put(value []byte) { h.used[string(value)] = true }

// markdownPolicy is what's kept of the HTML goldmark makes.
// Keep this policy distinct from EPUB and raw HTML: docs/preview-security.md.
var markdownPolicy = func() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	p.AllowAttrs("class").Matching(regexp.MustCompile(
		`^(math (inline|display)|mermaid|language-[A-Za-z0-9_+-]{1,32}|task-list-item|contains-task-list|front-matter)$`)).
		OnElements("span", "div", "pre", "code", "li", "ul", "ol", "details")
	p.AllowElements("details", "summary")
	p.AllowAttrs("id").Matching(regexp.MustCompile(`^[\pL\pN_-]{1,100}$`)).OnElements("h1", "h2", "h3", "h4", "h5", "h6")
	p.AllowAttrs("type").Matching(regexp.MustCompile(`^checkbox$`)).OnElements("input")
	p.AllowAttrs("checked", "disabled").OnElements("input")
	p.AllowAttrs("align").Matching(regexp.MustCompile(`^(left|center|right)$`)).OnElements("th", "td")
	p.AllowStyles("text-align").MatchingEnum("left", "center", "right").OnElements("th", "td")
	p.AllowDataURIImages()
	p.RequireNoReferrerOnLinks(true)
	p.AddTargetBlankToFullyQualifiedLinks(true)
	return p
}()

var errMarkdownTooBig = errors.New("it's too big to preview")

// renderMarkdown reads Markdown from r, at most maxMarkdown bytes, and
// returns it as HTML, cleaned.
func renderMarkdown(r io.Reader) (string, error) {
	src, err := io.ReadAll(io.LimitReader(r, maxMarkdown+1))
	if err != nil {
		return "", err
	}
	if len(src) > maxMarkdown {
		return "", errMarkdownTooBig
	}
	var out bytes.Buffer
	front, src := splitFrontMatter(src)
	if front != nil {
		fmt.Fprintf(&out, "<details class=\"front-matter\"><summary>Front matter</summary><pre><code class=\"language-yaml\">%s</code></pre></details>\n",
			html.EscapeString(string(front)))
	}
	ctx := parser.NewContext(parser.WithIDs(newHeadingIDs()))
	if err := markdownConverter.Convert(src, &out, parser.WithContext(ctx)); err != nil {
		return "", err
	}
	return markdownPolicy.Sanitize(out.String()), nil
}

// Rendering runs in a child process, tabtopd itself run with
// markdownChildArg, on one core, killed after markdownTimeout: goldmark
// takes time that grows with the square of some shapes of text (thousands
// of nested quotes, say), so a file made to take minutes, as one sent
// through an upload link could be, costs a few seconds of one core, and
// the preview shows its source instead. Admission uses the shared preview work policy (preview_work.go).
const (
	markdownChildArg = "-render-markdown"
	markdownTimeout  = 5 * time.Second
	maxMarkdownHTML  = 32 << 20
)

var (
	markdownSlots   = newPreviewWork(previewReadConcurrency)
	errMarkdownSlow = errors.New("it takes too long to render")
	errMarkdownBusy = errors.New("other files are being rendered; try again in a moment")
)

// renderMarkdownChild is main for the child: Markdown on stdin, HTML, or
// on failure why, on stdout.
func renderMarkdownChild() int {
	html, err := renderMarkdown(os.Stdin)
	if err != nil {
		fmt.Fprint(os.Stdout, err)
		return 1
	}
	io.WriteString(os.Stdout, html)
	return 0
}

// renderMarkdownIsolated is renderMarkdown, in a child process.
func renderMarkdownIsolated(src io.Reader) (string, error) {
	release, ok := markdownSlots.acquire()
	if !ok {
		return "", errMarkdownBusy
	}
	defer release()
	result := runIsolatedChild(isolatedChild{Args: []string{markdownChildArg}, Input: io.LimitReader(src, maxMarkdown+1), Timeout: markdownTimeout, OutputLimit: maxMarkdownHTML})
	switch {
	case result.TimedOut:
		return "", errMarkdownSlow
	case result.Overflow:
		return "", errMarkdownTooBig
	case result.Err != nil:
		if string(result.Output) == errMarkdownTooBig.Error() {
			return "", errMarkdownTooBig
		}
		return "", errors.New("it couldn't be rendered")
	}
	return string(result.Output), nil
}

// splitFrontMatter takes the YAML front matter many notes start with (a
// "---" line, then lines up to one of "---" or "...") off src, and returns
// it, and the rest; or nil and src, if src doesn't start with any. It's
// shown folded away, as YAML, rather than as a rule and stray text.
func splitFrontMatter(src []byte) (front, rest []byte) {
	first, _, ok := bytes.Cut(src, []byte("\n"))
	if !ok || string(bytes.TrimRight(first, " \t\r")) != "---" {
		return nil, src
	}
	start := len(first) + 1
	for i, at := 0, start; i < 1000 && at < len(src); i++ {
		line, _, _ := bytes.Cut(src[at:], []byte("\n"))
		if t := string(bytes.TrimRight(line, " \t\r")); t == "---" || t == "..." {
			return src[start:at], src[min(len(src), at+len(line)+1):]
		}
		at += len(line) + 1
	}
	return nil, src
}

// previewMarkdown is the goldmark extension for math, and for the fenced
// blocks the frame renders.
type previewMarkdown struct{}

func (previewMarkdown) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(parser.WithInlineParsers(util.Prioritized(mathParser{}, 150)))
	// After goldmark's own (at 1000), so this one's fenced code blocks
	// are what's used.
	m.Renderer().AddOptions(renderer.WithNodeRenderers(util.Prioritized(previewRenderer{}, 100)))
}

var kindMath = ast.NewNodeKind("Math")

// mathNode is $…$ (or, display, $$…$$): TeX, as it was written.
type mathNode struct {
	ast.BaseInline
	tex     []byte
	display bool
}

func (n *mathNode) Kind() ast.NodeKind            { return kindMath }
func (n *mathNode) Dump(source []byte, level int) { ast.DumpHelper(n, source, level, nil, nil) }

// mathParser finds $…$ on one line, and $$…$$, over as many as it takes.
// As on GitHub, $ followed by a space, or a closing $ after one or before
// a digit, isn't math, so prices stay prices; \$ is a dollar sign. A
// search that finds no closing $ is remembered (see mathMisses), so a line
// of many dollars that aren't math is read once, not once for each.
type mathParser struct{}

func (mathParser) Trigger() []byte { return []byte{'$'} }

var mathMissesKey = parser.NewContextKey()

// mathMisses is where in the source no closing $ or $$ can be found: none
// for $ from inlineFrom to inlineTo (the end of its line), and none for $$
// anywhere from displayFrom (-1 if not known).
type mathMisses struct{ inlineFrom, inlineTo, displayFrom int }

func (mathParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, seg := block.PeekLine()
	open := 1
	if len(line) > 1 && line[1] == '$' {
		open = 2
	}
	if open == 1 && (len(line) < 2 || line[1] == ' ' || line[1] == '\t' || line[1] == '\n' || line[1] == '\r') {
		return nil
	}
	misses, _ := pc.Get(mathMissesKey).(*mathMisses)
	if misses == nil {
		misses = &mathMisses{inlineFrom: -1, inlineTo: -1, displayFrom: -1}
		pc.Set(mathMissesKey, misses)
	}
	at := seg.Start
	if open == 1 && at >= misses.inlineFrom && at < misses.inlineTo || open == 2 && misses.displayFrom >= 0 && at >= misses.displayFrom {
		return nil
	}
	startLine, startSeg := block.Position()
	restore := func() ast.Node {
		block.SetPosition(startLine, startSeg)
		return nil
	}
	block.Advance(open)
	var tex []byte
	for {
		line, seg := block.PeekLine()
		if line == nil {
			misses.displayFrom = at
			return restore()
		}
		end := closingDollar(line, open)
		if end >= 0 {
			tex = append(tex, line[:end]...)
			block.Advance(end + open)
			break
		}
		if open == 1 {
			misses.inlineFrom, misses.inlineTo = at, seg.Stop
			return restore()
		}
		tex = append(tex, line...)
		block.AdvanceLine()
	}
	if len(bytes.TrimSpace(tex)) == 0 {
		return restore()
	}
	return &mathNode{tex: tex, display: open == 2}
}

// closingDollar is where in line math opened with open dollars closes, or
// -1.
func closingDollar(line []byte, open int) int {
	for i := 0; i < len(line); i++ {
		switch {
		case line[i] == '\\':
			i++
		case line[i] != '$':
		case open == 2:
			if i+1 < len(line) && line[i+1] == '$' {
				return i
			}
		case i > 0 && line[i-1] != ' ' && line[i-1] != '\t' && (i+1 >= len(line) || line[i+1] < '0' || line[i+1] > '9'):
			return i
		}
	}
	return -1
}

type previewRenderer struct{}

func (previewRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(kindMath, renderMath)
	reg.Register(ast.KindFencedCodeBlock, renderFence)
}

func renderMath(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		n := node.(*mathNode)
		kind := "inline"
		if n.display {
			kind = "display"
		}
		fmt.Fprintf(w, `<span class="math %s">%s</span>`, kind, html.EscapeString(string(n.tex)))
	}
	return ast.WalkSkipChildren, nil
}

var fenceLanguage = regexp.MustCompile(`^[A-Za-z0-9_+-]{1,32}$`)

// renderFence renders a fenced code block: math and Mermaid as their
// source for the frame to render, others as code, marked with their
// language.
func renderFence(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkSkipChildren, nil
	}
	n := node.(*ast.FencedCodeBlock)
	var body strings.Builder
	for i := 0; i < n.Lines().Len(); i++ {
		seg := n.Lines().At(i)
		body.Write(seg.Value(source))
	}
	code := html.EscapeString(body.String())
	lang := strings.ToLower(string(n.Language(source)))
	switch {
	case lang == "math":
		fmt.Fprintf(w, "<div class=\"math display\">%s</div>\n", code)
	case lang == "mermaid":
		fmt.Fprintf(w, "<pre class=\"mermaid\">%s</pre>\n", code)
	case fenceLanguage.MatchString(lang):
		fmt.Fprintf(w, "<pre><code class=\"language-%s\">%s</code></pre>\n", lang, code)
	default:
		fmt.Fprintf(w, "<pre><code>%s</code></pre>\n", code)
	}
	return ast.WalkSkipChildren, nil
}
