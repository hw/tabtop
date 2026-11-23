package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strconv"
	"testing"
	"time"
)

// TestGoRichTextWithMoli: rich text (contenteditable) edited by the
// engine's own input, as goinput.go gives it, in Moli: what Moli doesn't do
// itself of an edit the page lets be (a deletion, a new paragraph or line)
// done by the agent (goagent.js's editDefault), as a browser would; and
// left alone when the page takes the edit itself.
func TestGoRichTextWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set")
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><div id="ed" contenteditable="true"></div><script>window.inputs = []; document.getElementById("ed").addEventListener("input", (e) => inputs.push(e.inputType));</script>`)
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	e, err := startGoEngine(goEngineConfig{engine: moli, mode: goUnsandboxed,
		allow: func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") }})
	if err != nil {
		t.Fatal(err)
	}
	defer e.kill("rich text test")
	c, err := dialCDP(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	page, _, err := c.newPageTarget(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.call(ctx, page, "Page.enable", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.call(ctx, page, "Page.navigate", map[string]string{"url": site.URL}, nil); err != nil {
		t.Fatal(err)
	}
	eval := func(expression string) string {
		t.Helper()
		var r struct {
			Result struct{ Value any }
		}
		if err := c.call(ctx, page, "Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true}, &r); err != nil {
			t.Fatal(err)
		}
		s, _ := r.Result.Value.(string)
		return s
	}
	for eval(`document.readyState === "complete" && !!document.getElementById("ed") ? "yes" : ""`) != "yes" {
		if ctx.Err() != nil {
			t.Fatal("the page didn't load")
		}
		time.Sleep(20 * time.Millisecond)
	}
	eval(goAgentJS)
	key := func(name string, keyCode, modifiers int, text string) {
		t.Helper()
		for _, typ := range []string{"keyDown", "keyUp"} {
			p := map[string]any{"type": typ, "key": name, "code": name, "windowsVirtualKeyCode": keyCode, "modifiers": modifiers}
			if typ == "keyDown" && text != "" {
				p["text"] = text
			}
			if err := c.call(ctx, page, "Input.dispatchKeyEvent", p, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	// at has the rich text be html, focused, with the selection from the
	// nth text node's offset to the mth's (-1: the paragraph's start, the
	// first element's, offset 0).
	at := func(html string, from, fromAt, to, toAt int) {
		t.Helper()
		eval(`(() => {
			const ed = document.getElementById("ed");
			ed.innerHTML = ` + strconv.Quote(html) + `;
			ed.focus();
			const walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT), texts = [];
			for (let n = walk.nextNode(); n; n = walk.nextNode()) texts.push(n);
			const point = (i) => i < 0 ? ed.firstElementChild ?? ed : texts[i];
			getSelection().setBaseAndExtent(point(` + strconv.Itoa(from) + `), ` + strconv.Itoa(fromAt) + `, point(` + strconv.Itoa(to) + `), ` + strconv.Itoa(toAt) + `);
			inputs.length = 0;
		})()`)
	}
	html := func() string { return eval(`document.getElementById("ed").innerHTML`) }
	for _, c := range []struct {
		what                   string
		html                   string
		from, fromAt, to, toAt int
		key                    string
		keyCode, modifiers     int
		text, want             string
	}{
		{"Backspace in a word", "<p>hello</p>", 0, 5, 0, 5, "Backspace", 8, 0, "", "<p>hell</p>"},
		{"Backspace at a paragraph's start", "<p>ab</p><p>cd</p>", 1, 0, 1, 0, "Backspace", 8, 0, "", "<p>abcd</p>"},
		{"Backspace at the start", "<p>ab</p>", 0, 0, 0, 0, "Backspace", 8, 0, "", "<p>ab</p>"},
		{"Backspace emptying a paragraph", "<p>a</p>", 0, 1, 0, 1, "Backspace", 8, 0, "", "<p><br></p>"},
		{"Backspace over a selection", "<p>hello</p>", 0, 1, 0, 4, "Backspace", 8, 0, "", "<p>ho</p>"},
		{"Ctrl+Backspace, a word", "<p>hello world</p>", 0, 11, 0, 11, "Backspace", 8, 2, "", "<p>hello </p>"},
		{"Delete in a word", "<p>abc</p>", 0, 1, 0, 1, "Delete", 46, 0, "", "<p>ac</p>"},
		{"Delete at a paragraph's end", "<p>ab</p><p>cd</p>", 0, 2, 0, 2, "Delete", 46, 0, "", "<p>abcd</p>"},
		{"Enter in a paragraph", "<p>abcd</p>", 0, 2, 0, 2, "Enter", 13, 0, "\r", "<p>ab</p><p>cd</p>"},
		{"Enter at a paragraph's end", "<p>ab</p>", 0, 2, 0, 2, "Enter", 13, 0, "\r", "<p>ab</p><p><br></p>"},
		{"Enter in text of no paragraph", "abcd", 0, 2, 0, 2, "Enter", 13, 0, "\r", "ab<div>cd</div>"},
		{"Shift+Enter, a line", "<p>abcd</p>", 0, 2, 0, 2, "Enter", 13, 8, "\r", "<p>ab<br>cd</p>"},
		{"Shift+Enter at the end", "<p>ab</p>", 0, 2, 0, 2, "Enter", 13, 8, "\r", "<p>ab<br><br></p>"},
		{"a character, Moli's own", "<p>ab</p>", 0, 1, 0, 1, "x", 88, 0, "x", "<p>axb</p>"},
	} {
		at(c.html, c.from, c.fromAt, c.to, c.toAt)
		key(c.key, c.keyCode, c.modifiers, c.text)
		if got := html(); got != c.want {
			t.Errorf("%s: %q, want %q", c.what, got, c.want)
		}
	}
	// The page told, as a browser tells it.
	at("<p>ab</p>", 0, 2, 0, 2)
	key("Backspace", 8, 0, "")
	if got := eval(`inputs.join()`); got != "deleteContentBackward" {
		t.Errorf("the page's input events: %q", got)
	}
	// Typed after an edit: where the caret was left.
	at("<p>abcd</p>", 0, 2, 0, 2)
	key("Enter", 13, 0, "\r")
	key("x", 88, 0, "x")
	if got := html(); got != "<p>ab</p><p>xcd</p>" {
		t.Errorf("typed after Enter: %q", got)
	}
	// plaintext-only: its text alone, Enter a line, not a paragraph.
	eval(`document.getElementById("ed").setAttribute("contenteditable", "plaintext-only")`)
	at("ab", 0, 1, 0, 1)
	key("Enter", 13, 0, "\r")
	if got := html(); got != "a<br>b" {
		t.Errorf("Enter in plaintext-only: %q", got)
	}
	// A paste (the agent's act, as goinput.go asks it): styled in rich
	// text, its markup but what styles it left out; in plaintext-only,
	// given back to be put in as typed; taken by a page that takes pastes.
	eval(`(() => { const s = JSON.parse(__tabtop.snapshot()); const find = (n) => n.a?.includes("ed") && n.a[n.a.indexOf("ed") - 1] === "id" ? n.i : (n.c ?? []).map(find).find(Boolean); window.edID = find(s.doc); })()`)
	paste := func(html string) string {
		return eval(`__tabtop.act(JSON.stringify({ kind: "edit", id: edID, inputType: "insertFromPaste", value: "plain", html: ` + strconv.Quote(html) + `, edit: true }))`)
	}
	at("<p>ab</p>", 0, 2, 0, 2)
	if res := paste(`<b onclick="x()">bold</b><script>bad()</script><img src="x" onerror="bad()"><a href="javascript:bad()">link</a><a href="https://example.com/">web</a>`); res != "insert" {
		t.Errorf("a paste in plaintext-only: %q, not given back", res)
	}
	eval(`document.getElementById("ed").setAttribute("contenteditable", "true")`)
	at("<p>ab</p>", 0, 2, 0, 2)
	if res := paste(`<b onclick="x()">bold</b><script>bad()</script><img src="x" onerror="bad()"><a href="javascript:bad()">link</a><a href="https://example.com/">web</a>`); res != "ok" {
		t.Errorf("a styled paste: %q", res)
	}
	if got := html(); got != `<p>ab<b>bold</b><a>link</a><a href="https://example.com/">web</a></p>` {
		t.Errorf("a styled paste: %q", got)
	}
	eval(`document.getElementById("ed").addEventListener("paste", (e) => { e.preventDefault(); window.pasteTaken = e.clipboardData.getData("text/html"); })`)
	at("<p>ab</p>", 0, 2, 0, 2)
	if res := paste("<i>it</i>"); res != "ok" || html() != "<p>ab</p>" || eval(`window.pasteTaken`) != "<i>it</i>" {
		t.Errorf("a paste the page takes: %q, %q, it was given %q", res, html(), eval(`window.pasteTaken`))
	}
	// The page takes the edit itself: left to it.
	eval(`document.getElementById("ed").addEventListener("beforeinput", (e) => e.preventDefault())`)
	at("<p>ab</p><p>cd</p>", 1, 0, 1, 0)
	key("Backspace", 8, 0, "")
	key("Enter", 13, 0, "\r")
	if got := html(); got != "<p>ab</p><p>cd</p>" {
		t.Errorf("an edit the page took: %q", got)
	}
}
