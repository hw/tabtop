package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMain is also the child that renders Markdown (see
// renderMarkdownIsolated), and reads books (see readEpubIsolated), as
// tabtopd is.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == markdownChildArg {
		os.Exit(renderMarkdownChild())
	}
	if len(os.Args) >= 2 && os.Args[1] == epubChildArg {
		os.Exit(renderEpubChild(os.Args[2:]))
	}
	if len(os.Args) >= 2 && os.Args[1] == sqliteChildArg {
		os.Exit(readSQLiteChild(os.Args[2:]))
	}
	os.Exit(m.Run())
}

func TestRenderMarkdown(t *testing.T) {
	src := "# Title *here*\n\n" +
		"Inline $a_1 + b^2$ and $$\\sum_{i=1}^n i$$, but $5 and $ 6 aren't, nor \\$x\\$.\n\n" +
		"$$\nE = mc^2\n$$\n\n" +
		"```math\n\\frac{1}{2} < x\n```\n\n" +
		"```mermaid\ngraph TD; A-->B\n```\n\n" +
		"```go\nfunc main() { fmt.Println(\"<hi>\") }\n```\n\n" +
		"```weird lang!\nx\n```\n\n" +
		"| a | b |\n|:--|--:|\n| 1 | 2 |\n\n" +
		"- [x] done\n- [ ] not\n\n" +
		"<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n" +
		"[js](javascript:alert(3)) [web](https://example.com) [here](#title-here) ![pic](diagram.png) ![remote](https://example.com/x.png)\n"
	got, err := renderMarkdown(strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`<h1 id="title-here">Title <em>here</em></h1>`,
		`<span class="math inline">a_1 + b^2</span>`,
		`<span class="math display">\sum_{i=1}^n i</span>`,
		"$5 and $ 6 aren", "$x$",
		`<span class="math display">`, "E = mc^2",
		`<div class="math display">\frac{1}{2} &lt; x`,
		`<pre class="mermaid">graph TD; A--&gt;B`,
		`<pre><code class="language-go">func main() { fmt.Println(&#34;&lt;hi&gt;&#34;) }`,
		"<pre><code class=\"language-weird\">x\n</code></pre>",
		`<th style="text-align: left">a</th>`,
		`<input checked="" disabled="" type="checkbox">`,
		`<a href="https://example.com" rel="nofollow noreferrer noopener" target="_blank">web</a>`,
		`<a href="#title-here" rel="nofollow noreferrer">here</a>`,
		`<img src="diagram.png" alt="pic">`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	for _, bad := range []string{"<script", "onerror", "javascript:", "alert(1)", "alert(2)"} {
		if strings.Contains(got, bad) {
			t.Errorf("kept %q:\n%s", bad, got)
		}
	}
	if _, err := renderMarkdown(strings.NewReader(strings.Repeat("x", maxMarkdown+1))); err != errMarkdownTooBig {
		t.Errorf("too big: %v", err)
	}
}

// The markdown request, and the frame's page and script.
func TestMarkdownPreview(t *testing.T) {
	g, srv := newE2EServer(t)
	s := login(t, testCtx(t), srv.URL, code(0))
	os.MkdirAll(filepath.Join(g.downloadsDir, "notes"), 0o755)
	os.WriteFile(filepath.Join(g.downloadsDir, "notes", "a.md"), []byte("# Hi\n\n$x^2$\n"), 0o644)
	os.WriteFile(filepath.Join(g.downloadsDir, "big.md"), make([]byte, maxMarkdown+1), 0o644)
	req := func(p string) map[string]any {
		return openSession(t, testCtx(t), srv.URL, s).request(t, testCtx(t), tunnelRequest{Type: "markdown", Path: p})
	}
	if r := req("notes/a.md"); !strings.Contains(fmt.Sprint(r["html"]), `<h1 id="hi">Hi</h1>`) ||
		!strings.Contains(fmt.Sprint(r["html"]), `<span class="math inline">x^2</span>`) {
		t.Errorf("a.md: %v", r)
	}
	for _, p := range []string{"big.md", "notes", "missing.md", "../etc/passwd"} {
		if r := req(p); r["error"] == nil {
			t.Errorf("%s: %v", p, r)
		}
	}
	// The frame's page: its own CSP, its script, which points at where the
	// libraries are (none here).
	res, err := http.Get(srv.URL + "/tabtop/md-frame.html")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.Header.Get("Content-Security-Policy") != mdFrameCSP || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") ||
		!strings.Contains(string(body), `<script src="md-frame.js"></script>`) || res.Header.Get("X-Frame-Options") != "" {
		t.Errorf("md-frame.html: %v %s", res.Header, body)
	}
	res, _ = http.Get(srv.URL + "/tabtop/md-frame.js")
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(body), `"./preview-missing/"`) || !strings.Contains(string(body), `"./highlight-missing/"`) {
		t.Errorf("md-frame.js points elsewhere")
	}
}

// A file that would take too long is cut off, in its own process; others
// render meanwhile.
func TestMarkdownIsolated(t *testing.T) {
	if html, err := renderMarkdownIsolated(strings.NewReader("# Hi\n")); err != nil || !strings.Contains(html, "<h1") {
		t.Fatalf("%q, %v", html, err)
	}
	slow := strings.Repeat(">", 1_000_000)
	start := time.Now()
	if _, err := renderMarkdownIsolated(strings.NewReader(slow)); err != errMarkdownSlow {
		t.Errorf("nested quotes: %v", err)
	}
	if d := time.Since(start); d > markdownTimeout+2*time.Second {
		t.Errorf("took %v", d)
	}
	if _, err := renderMarkdownIsolated(strings.NewReader(strings.Repeat("x", maxMarkdown+1))); err != errMarkdownTooBig {
		t.Errorf("too big: %v", err)
	}
}

func TestFrontMatter(t *testing.T) {
	for _, c := range []struct{ src, front, rest string }{
		{"---\ntitle: Hi\ntags: [a]\n---\n# Body\n", "title: Hi\ntags: [a]\n", "# Body\n"},
		{"---\r\ntitle: x\r\n...\r\nrest", "title: x\r\n", "rest"},
		{"---\nnot closed\n", "", "---\nnot closed\n"},
		{"# No front matter\n---\n", "", "# No front matter\n---\n"},
	} {
		front, rest := splitFrontMatter([]byte(c.src))
		if string(front) != c.front || string(rest) != c.rest {
			t.Errorf("%q: %q, %q", c.src, front, rest)
		}
	}
	got, _ := renderMarkdown(strings.NewReader("---\ntitle: <b>Hi</b>\n---\n# Body\n"))
	if !strings.Contains(got, `<details class="front-matter"><summary>Front matter</summary><pre><code class="language-yaml">title: &lt;b&gt;Hi&lt;/b&gt;`) ||
		!strings.Contains(got, `<h1 id="body">Body</h1>`) || strings.Contains(got, "<hr") {
		t.Errorf("rendered: %s", got)
	}
}
