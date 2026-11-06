package main

import (
	"archive/zip"
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// newShareServer is an e2e server with share links on, kept in a file, and
// a logged-in session.
func newShareServer(t *testing.T) (*server, string, testSession, string) {
	t.Helper()
	g, srv := newE2EServer(t)
	file := filepath.Join(t.TempDir(), "conf", "shares.json")
	g.sharesFile = file
	g.shares = newShareStore(file, g.clock)
	s := login(t, testCtx(t), srv.URL, code(0))
	return g, srv.URL, s, file
}

// makeShare makes a link to p through the tunnel and returns its URL.
func makeShare(t *testing.T, srvURL string, s testSession, p string, expires int64, max int) string {
	t.Helper()
	reply := openSession(t, testCtx(t), srvURL, s).request(t, testCtx(t), tunnelRequest{Type: "share", Path: p, Expires: expires, Max: max})
	token, _ := reply["token"].(string)
	if reply["ok"] != true || !shareToken.MatchString(token) {
		t.Fatalf("share %s: %v", p, reply)
	}
	return srvURL + filesPrefix + token + "/" + filepath.Base(p)
}

func shareFetch(t *testing.T, method, url string, header ...string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := http.DefaultTransport.RoundTrip(req) // no redirects followed
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func shareCount(g *server) int {
	l := g.shares.list("")
	if len(l) == 0 {
		return -1
	}
	return l[0].Count
}

func TestShareFile(t *testing.T) {
	g, srv, s, file := newShareServer(t)
	data := bytes.Repeat([]byte("0123456789"), 1000)
	os.WriteFile(filepath.Join(g.downloadsDir, "a file.txt"), data, 0o644)
	url := makeShare(t, srv, s, "a file.txt", 3600, 0)
	if raw, _ := os.ReadFile(file); bytes.Contains(raw, []byte(strings.Split(url, "/")[4])) || !bytes.Contains(raw, []byte(`"a file.txt"`)) {
		t.Errorf("shares file holds the token, or not the link: %s", raw)
	}

	// HEAD tells, and doesn't count.
	res, _ := shareFetch(t, "HEAD", url)
	if res.StatusCode != 200 || res.ContentLength != int64(len(data)) || shareCount(g) != 0 {
		t.Fatalf("HEAD: %d, length %d, count %d", res.StatusCode, res.ContentLength, shareCount(g))
	}
	res, body := shareFetch(t, "GET", url)
	if res.StatusCode != 200 || !bytes.Equal(body, data) || shareCount(g) != 1 {
		t.Fatalf("GET: %d, %d bytes, count %d", res.StatusCode, len(body), shareCount(g))
	}
	for k, want := range map[string]string{
		"Content-Type":            "application/octet-stream",
		"Content-Disposition":     `attachment; filename="a file.txt"`,
		"X-Content-Type-Options":  "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
		"Accept-Ranges":           "bytes",
	} {
		if got := res.Header.Get(k); got != want {
			t.Errorf("%s: %q, want %q", k, got, want)
		}
	}
	if !strings.Contains(res.Header.Get("Cache-Control"), "no-store") {
		t.Errorf("Cache-Control %q", res.Header.Get("Cache-Control"))
	}
	// Carrying on part way, as wget -c does: doesn't count again.
	res, body = shareFetch(t, "GET", url, "Range", "bytes=9990-")
	if res.StatusCode != http.StatusPartialContent || string(body) != "0123456789" || shareCount(g) != 1 {
		t.Errorf("range: %d %q, count %d", res.StatusCode, body, shareCount(g))
	}
	// The name in the URL is only for wget: another works too.
	if res, _ := shareFetch(t, "GET", strings.TrimSuffix(url, "a file.txt")+"other"); res.StatusCode != 200 {
		t.Errorf("another name: %d", res.StatusCode)
	}

	// The link survives a restart, read back from the file.
	g.shares = newShareStore(file, g.clock)
	if res, body := shareFetch(t, "GET", url); res.StatusCode != 200 || !bytes.Equal(body, data) {
		t.Errorf("after reloading: %d", res.StatusCode)
	}
	// A file changed or replaced isn't served.
	os.WriteFile(filepath.Join(g.downloadsDir, "a file.txt"), []byte("something else"), 0o644)
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != 404 {
		t.Errorf("replaced file: %d", res.StatusCode)
	}
}

func TestShareLimit(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("hello"), 0o644)
	url := makeShare(t, srv, s, "f", 3600, 1)
	// Two at once: only one gets it.
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Go(func() {
			res, _ := shareFetch(t, "GET", url)
			codes[i] = res.StatusCode
		})
	}
	wg.Wait()
	sort.Ints(codes)
	if codes[0] != 200 || codes[1] != http.StatusGone {
		t.Fatalf("two at once with a limit of 1: %v", codes)
	}
	// The address that downloaded it may carry on; another may not.
	if res, _ := shareFetch(t, "GET", url, "Range", "bytes=2-"); res.StatusCode != http.StatusPartialContent {
		t.Errorf("resume from the same address: %d", res.StatusCode)
	}
	// But not with ranges that make the whole file again, uncounted.
	if res, body := shareFetch(t, "GET", url, "Range", "bytes=1-,0-"); res.StatusCode != http.StatusGone {
		t.Errorf("several ranges from the same address: %d, %q", res.StatusCode, body)
	}
	l := g.shares.list("")[0]
	link := g.shares.links[func() string {
		for id, x := range g.shares.links {
			if x.handle() == l.Handle {
				return id
			}
		}
		return ""
	}()]
	if err := g.shares.use(link, "203.0.113.9", true); err == nil {
		t.Error("another address carried on with a used-up link")
	}
}

func TestShareExpiresAndRevokes(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("hello"), 0o644)
	now := time.Now()
	g.shares.clock.now = func() time.Time { return now }
	url := makeShare(t, srv, s, "f", 3600, 0)
	now = now.Add(time.Hour)
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != 404 {
		t.Errorf("expired: %d", res.StatusCode)
	}

	// Revoked from the security page.
	url = makeShare(t, srv, s, "f", 3600, 0)
	reply := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "sessions"})
	shares, _ := reply["shares"].([]any)
	if len(shares) != 1 || shares[0].(map[string]any)["mine"] != true {
		t.Fatalf("listed: %v", reply["shares"])
	}
	handle := shares[0].(map[string]any)["handle"].(string)
	if r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "unshare", Name: handle}); r["ok"] != true {
		t.Fatalf("unshare: %v", r)
	}
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != 404 {
		t.Errorf("revoked: %d", res.StatusCode)
	}

	// Ending the session that made links revokes them; Log out
	// everywhere revokes all.
	other := login(t, testCtx(t), srv, code(1))
	byOther := makeShare(t, srv, other, "f", 3600, 0)
	mine := makeShare(t, srv, s, "f", 3600, 0)
	if r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "end-session", Name: sessionHandle(other.id)}); r["ok"] != true {
		t.Fatalf("end-session: %v", r)
	}
	if res, _ := shareFetch(t, "GET", byOther); res.StatusCode != 404 {
		t.Errorf("link of an ended session: %d", res.StatusCode)
	}
	if res, _ := shareFetch(t, "GET", mine); res.StatusCode != 200 {
		t.Errorf("this session's link, after ending another: %d", res.StatusCode)
	}
	openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "logout-all"})
	if res, _ := shareFetch(t, "GET", mine); res.StatusCode != 404 {
		t.Errorf("after Log out everywhere: %d", res.StatusCode)
	}
}

func TestShareFolder(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	dir := filepath.Join(g.downloadsDir, "photos")
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("bb"), 0o644)
	url := makeShare(t, srv, s, "photos", 3600, 0)
	if res, body := shareFetch(t, "HEAD", url); res.StatusCode != 200 || len(body) != 0 || shareCount(g) != 0 {
		t.Fatalf("HEAD: %d, count %d", res.StatusCode, shareCount(g))
	}
	res, body := shareFetch(t, "GET", url)
	if res.StatusCode != 200 || res.Header.Get("Content-Disposition") != `attachment; filename=photos.zip` {
		t.Fatalf("GET: %d %q", res.StatusCode, res.Header.Get("Content-Disposition"))
	}
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	if strings.Join(names, " ") != "photos/ photos/a.txt photos/sub/ photos/sub/b.txt" {
		t.Errorf("zip holds %v", names)
	}
}

func TestShareMissesLimited(t *testing.T) {
	g, srv, _, _ := newShareServer(t)
	_ = g
	bad := srv + filesPrefix + strings.Repeat("A", 22) + "/x"
	for i := range maxShareMisses {
		if res, _ := shareFetch(t, "GET", bad); res.StatusCode != 404 {
			t.Fatalf("miss %d: %d", i+1, res.StatusCode)
		}
	}
	if res, _ := shareFetch(t, "GET", bad); res.StatusCode != http.StatusTooManyRequests {
		t.Errorf("past the limit: %d", res.StatusCode)
	}
}

// With share links off, and for paths that aren't links, /fs/
// paths go to the files page as before.
func TestShareRoutes(t *testing.T) {
	g, srv, _, _ := newShareServer(t)
	for _, p := range []string{"photos/2024", "short/x", strings.Repeat("A", 22) + "/a/b"} {
		if res, _ := shareFetch(t, "GET", srv+filesPrefix+p); res.StatusCode != http.StatusSeeOther {
			t.Errorf("%s: %d, want the files page", p, res.StatusCode)
		}
	}
	g.shares = nil
	if res, _ := shareFetch(t, "GET", srv+filesPrefix+strings.Repeat("A", 22)+"/x"); res.StatusCode != http.StatusSeeOther {
		t.Errorf("links off: %d, want the files page", res.StatusCode)
	}
	if r := openSession(t, testCtx(t), srv, login(t, testCtx(t), srv, code(1))).request(t, testCtx(t), tunnelRequest{Type: "share", Path: "x", Expires: 3600}); r["error"] == nil {
		t.Errorf("share with links off: %v", r)
	}
}

func TestStartsPartWay(t *testing.T) {
	for rng, want := range map[string]bool{"": false, "bytes=0-": false, "bytes=0-99": false, "bytes=00-": false,
		"bytes=100-": true, "bytes=-500": false, "items=3-": false,
		// Several ranges: a download, counted (ServeContent can send all
		// of the file for them).
		"bytes=5-9,20-": false, "bytes=1-,0-": false} {
		if got := startsPartWay(rng); got != want {
			t.Errorf("%q: %v, want %v", rng, got, want)
		}
	}
}

// A browser gets a page, which doesn't count; its Download button counts
// once and sends it on to the file, which then doesn't count again.
func TestSharePage(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	data := []byte("hello, page")
	os.WriteFile(filepath.Join(g.downloadsDir, "f.txt"), data, 0o644)
	url := makeShare(t, srv, s, "f.txt", 3600, 1)
	browser := []string{"Accept", "text/html,application/xhtml+xml,*/*;q=0.8"}

	for range 3 { // a chat app's preview, a mail scanner, the person
		res, body := shareFetch(t, "GET", url, browser...)
		if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") ||
			!bytes.Contains(body, []byte(`<form method="post">`)) || !bytes.Contains(body, []byte("f.txt")) {
			t.Fatalf("page: %d %s %s", res.StatusCode, res.Header.Get("Content-Type"), body)
		}
		if res.Header.Get("Vary") != "Accept" || res.Header.Get("Content-Security-Policy") != sharePageCSP ||
			res.Header.Get("Content-Disposition") != "" || shareCount(g) != 0 {
			t.Fatalf("page headers %v, count %d", res.Header, shareCount(g))
		}
	}
	res, _ := shareFetch(t, "POST", url, browser...)
	loc := res.Header.Get("Location")
	if res.StatusCode != http.StatusSeeOther || !strings.HasPrefix(loc, "?t=") || shareCount(g) != 1 {
		t.Fatalf("Download: %d %q, count %d", res.StatusCode, loc, shareCount(g))
	}
	for range 2 { // and again, as a browser carrying on with it would
		res, body := shareFetch(t, "GET", url+loc, browser...)
		if res.StatusCode != 200 || !bytes.Equal(body, data) || res.Header.Get("Content-Disposition") == "" || shareCount(g) != 1 {
			t.Fatalf("the file, with the ticket: %d %q, count %d", res.StatusCode, body, shareCount(g))
		}
	}
	// Used up: the button and the page say so; a made-up ticket gets the
	// page saying so too.
	if res, _ := shareFetch(t, "POST", url, browser...); res.StatusCode != http.StatusGone {
		t.Errorf("Download again: %d", res.StatusCode)
	}
	if res, body := shareFetch(t, "GET", url+"?t=madeup", browser...); res.StatusCode != http.StatusGone || !bytes.Contains(body, []byte("as many times")) {
		t.Errorf("page, used up: %d %s", res.StatusCode, body)
	}
	if res, _ := shareFetch(t, "PUT", url); res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("PUT: %d", res.StatusCode)
	}
	// A browser asking for a link that doesn't exist gets a page saying so.
	if res, body := shareFetch(t, "GET", srv+filesPrefix+strings.Repeat("B", 22)+"/x", browser...); res.StatusCode != 404 ||
		!bytes.Contains(body, []byte("or has ended")) {
		t.Errorf("missing, as a page: %d", res.StatusCode)
	}

	// A folder: the button, then the zip.
	os.MkdirAll(filepath.Join(g.downloadsDir, "d"), 0o755)
	os.WriteFile(filepath.Join(g.downloadsDir, "d", "a"), []byte("a"), 0o644)
	url = makeShare(t, srv, s, "d", 3600, 0)
	res, _ = shareFetch(t, "POST", url, browser...)
	res, body := shareFetch(t, "GET", url+res.Header.Get("Location"), browser...)
	if _, err := zip.NewReader(bytes.NewReader(body), int64(len(body))); res.StatusCode != 200 || err != nil {
		t.Errorf("folder, with the ticket: %d %v", res.StatusCode, err)
	}
}

// makeUploadLink makes an upload link into dir and returns its URL.
func makeUploadLink(t *testing.T, srvURL string, s testSession, dir string, max int, maxBytes int64) string {
	t.Helper()
	reply := openSession(t, testCtx(t), srvURL, s).request(t, testCtx(t),
		tunnelRequest{Type: "share", Path: dir, Expires: 3600, Max: max, Upload: true, MaxBytes: maxBytes})
	token, _ := reply["token"].(string)
	if reply["ok"] != true || reply["upload"] != true {
		t.Fatalf("upload link %s: %v", dir, reply)
	}
	return srvURL + filesPrefix + token + "/"
}

func sendBody(t *testing.T, method, url, contentType string, body io.Reader, header ...string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func TestUploadLink(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.MkdirAll(filepath.Join(g.downloadsDir, "in"), 0o755)
	os.WriteFile(filepath.Join(g.downloadsDir, "in", "a.txt"), []byte("old"), 0o644)
	url := makeUploadLink(t, srv, s, "in", 3, 100)

	// As curl -T sends it: a clash gets a free name, never replacing.
	res, body := sendBody(t, "PUT", url+"a.txt", "", strings.NewReader("new"))
	if res.StatusCode != 201 || body != "Uploaded a (1).txt\n" {
		t.Fatalf("PUT: %d %q", res.StatusCode, body)
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "in", "a.txt")); string(b) != "old" {
		t.Errorf("a.txt replaced: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "in", "a (1).txt")); string(b) != "new" {
		t.Errorf("a (1).txt: %q", b)
	}
	// What isn't allowed.
	for _, c := range []struct {
		name, body string
		code       int
	}{
		{".hidden", "x", 400},
		{"%2E%2E", "x", 400},
		{"", "x", 400},
		{"big", strings.Repeat("x", 98), http.StatusRequestEntityTooLarge}, // 3 + 98 > 100
	} {
		if res, body := sendBody(t, "PUT", url+c.name, "", strings.NewReader(c.body)); res.StatusCode != c.code {
			t.Errorf("PUT %q: %d %q, want %d", c.name, res.StatusCode, body, c.code)
		}
	}
	// Too big, without a length, is cut off where it passes the limit,
	// and nothing is left.
	res, _ = sendBody(t, "PUT", url+"chunked", "", io.MultiReader(strings.NewReader(strings.Repeat("y", 120))))
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("chunked, too big: %d", res.StatusCode)
	}
	// The page's form, without its script.
	var form bytes.Buffer
	mw := multipart.NewWriter(&form)
	fw, _ := mw.CreateFormFile("file", `C:\Users\x\b.txt`)
	fw.Write([]byte("bee"))
	mw.Close()
	res, body = sendBody(t, "POST", url, mw.FormDataContentType(), &form, "Accept", "text/html")
	if res.StatusCode != 200 || !strings.Contains(body, "Uploaded b.txt") {
		t.Fatalf("form: %d %s", res.StatusCode, body)
	}
	// Three files is all it takes; those refused didn't count.
	if res, body := sendBody(t, "PUT", url+"c.txt", "", strings.NewReader("c")); res.StatusCode != 201 {
		t.Errorf("a third file: %d %q", res.StatusCode, body)
	}
	if res, body := sendBody(t, "PUT", url+"d.txt", "", strings.NewReader("d")); res.StatusCode != http.StatusForbidden {
		t.Errorf("a fourth file: %d %q", res.StatusCode, body)
	}
	names, _ := os.ReadDir(filepath.Join(g.downloadsDir, "in"))
	var got []string
	for _, n := range names {
		got = append(got, n.Name())
	}
	if strings.Join(got, ",") != "a (1).txt,a.txt,b.txt,c.txt" {
		t.Errorf("the folder holds %v", got)
	}
	// The page, and what curl is told; neither lists what's there.
	if res, body := shareFetch(t, "GET", url, "Accept", "text/html"); res.StatusCode != 200 || !strings.Contains(string(body), "Upload files to in") ||
		strings.Contains(string(body), "a.txt") {
		t.Errorf("page: %d %s", res.StatusCode, body)
	}
	if res, body := shareFetch(t, "GET", url); res.StatusCode != 200 || !strings.Contains(string(body), "curl -T") {
		t.Errorf("for curl: %d %s", res.StatusCode, body)
	}
	if res, _ := shareFetch(t, "GET", strings.TrimSuffix(url, "/")); res.StatusCode != http.StatusSeeOther {
		t.Errorf("without the slash: %d", res.StatusCode)
	}
	// Listed, with what came.
	l := g.shares.list("")[0]
	if !l.Upload || l.Count != 3 || l.Bytes != 7 || len(l.Uses) != 3 || l.Uses[1].Name != "b.txt" {
		t.Errorf("listed as %+v", l)
	}
}

// An upload link's folder must be a folder, and an upload link can't be
// downloaded.
func TestUploadLinkLimits(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("x"), 0o644)
	reply := openSession(t, testCtx(t), srv, s).request(t, testCtx(t),
		tunnelRequest{Type: "share", Path: "f", Expires: 3600, Upload: true, MaxBytes: 10})
	if reply["error"] == nil {
		t.Errorf("an upload link to a file: %v", reply)
	}
	reply = openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "share", Path: "", Expires: 3600, Upload: true})
	if reply["error"] == nil {
		t.Errorf("an upload link with no size limit: %v", reply)
	}
	url := makeUploadLink(t, srv, s, "", 0, 10) // Downloads itself
	if res, _ := sendBody(t, "PUT", url+"top.txt", "", strings.NewReader("top")); res.StatusCode != 201 {
		t.Fatalf("PUT into Downloads: %d", res.StatusCode)
	}
	if res, _ := shareFetch(t, "GET", url+"top.txt"); res.StatusCode != http.StatusSeeOther {
		t.Errorf("GET of what was uploaded: %d", res.StatusCode)
	}
	// Two at once with one file left: one gets it.
	url = makeUploadLink(t, srv, s, "", 1, 1000)
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Go(func() {
			res, _ := sendBody(t, "PUT", url+fmt.Sprintf("race%d", i), "", strings.NewReader("r"))
			codes[i] = res.StatusCode
		})
	}
	wg.Wait()
	sort.Ints(codes)
	if codes[0] != 201 || codes[1] != http.StatusForbidden {
		t.Errorf("two at once: %v", codes)
	}
	// Ending: revoked, it takes nothing more.
	openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "logout-all"})
	if res, _ := sendBody(t, "PUT", url+"late", "", strings.NewReader("x")); res.StatusCode != 404 {
		t.Errorf("after revoking: %d", res.StatusCode)
	}
}

// A link changed from the security page: given more downloads, or longer.
func TestShareChange(t *testing.T) {
	g, srv, s, file := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("hello"), 0o644)
	now := time.Now()
	g.shares.clock.now = func() time.Time { return now }
	url := makeShare(t, srv, s, "f", 3600, 1)
	handle := g.shares.list("")[0].Handle
	reshare := func(req tunnelRequest) map[string]any {
		req.Type, req.Name = "reshare", cmp.Or(req.Name, handle)
		return openSession(t, testCtx(t), srv, s).request(t, testCtx(t), req)
	}
	shareFetch(t, "GET", url)
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != http.StatusGone {
		t.Fatalf("used up: %d", res.StatusCode)
	}
	// Two more, and a day from now.
	if r := reshare(tunnelRequest{Expires: 86400, Max: 3}); r["ok"] != true {
		t.Fatalf("reshare: %v", r)
	}
	now = now.Add(2 * time.Hour)
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != 200 {
		t.Errorf("after giving it more, and longer: %d", res.StatusCode)
	}
	// Kept as changed, across a restart.
	if l := newShareStore(file, g.clock).list("")[0]; l.Max != 3 || !l.Expires.Equal(now.Add(-2*time.Hour).Add(24*time.Hour)) {
		t.Errorf("kept as %+v", l)
	}
	// Expires 0 keeps when it ends.
	before := g.shares.list("")[0].Expires
	reshare(tunnelRequest{Max: 0})
	if l := g.shares.list("")[0]; l.Max != 0 || !l.Expires.Equal(before) {
		t.Errorf("no limit, same end: %+v", l)
	}
	for _, c := range []struct {
		req  tunnelRequest
		want string
	}{
		{tunnelRequest{Max: 1}, "downloaded 2 times already"},
		{tunnelRequest{Expires: 30}, "lifetime"},
		{tunnelRequest{Expires: 8 * 86400}, "lifetime"},
		{tunnelRequest{MaxBytes: 5}, "download link"},
		{tunnelRequest{Name: "0000000000000000"}, "ended"},
	} {
		if r := reshare(c.req); !strings.Contains(fmt.Sprint(r["error"]), c.want) {
			t.Errorf("%+v: %v, want %q", c.req, r, c.want)
		}
	}
	// An upload link's size limit.
	os.MkdirAll(filepath.Join(g.downloadsDir, "in"), 0o755)
	up := makeUploadLink(t, srv, s, "in", 0, 10)
	sendBody(t, "PUT", up+"a", "", strings.NewReader("12345678"))
	var uh string
	for _, l := range g.shares.list("") {
		if l.Upload {
			uh = l.Handle
		}
	}
	if r := reshare(tunnelRequest{Name: uh, MaxBytes: 4}); !strings.Contains(fmt.Sprint(r["error"]), "taken 8 B already") {
		t.Errorf("below what it took: %v", r)
	}
	if r := reshare(tunnelRequest{Name: uh, MaxBytes: 100}); r["ok"] != true {
		t.Fatalf("more room: %v", r)
	}
	if res, body := sendBody(t, "PUT", up+"b", "", strings.NewReader("123456789")); res.StatusCode != 201 {
		t.Errorf("with more room: %d %q", res.StatusCode, body)
	}
}

// piece sends data as the piece of upload id at offset of a file size
// bytes long, as the upload page does.
func piece(t *testing.T, url, id string, offset, size int64, data []byte) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("PUT", url+"?u="+id, bytes.NewReader(data))
	req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+int64(len(data))-1, size))
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

// failingReader gives n bytes of data, then fails, as a connection lost
// part way.
type failingReader struct {
	data []byte
	n    int
}

func (f *failingReader) Read(p []byte) (int, error) {
	if f.n == 0 {
		return 0, io.ErrUnexpectedEOF
	}
	k := copy(p, f.data[:min(f.n, len(f.data))])
	f.data, f.n = f.data[k:], f.n-k
	return k, nil
}

func TestUploadLinkPieces(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.MkdirAll(filepath.Join(g.downloadsDir, "in"), 0o755)
	url := makeUploadLink(t, srv, s, "in", 2, 1<<20) + "big.bin"
	data := bytes.Repeat([]byte("0123456789abcdef"), 40000) // 640000 bytes
	size := int64(len(data))
	id := "abcdefghijklmnop"

	res, _ := piece(t, url, id, 0, size, data[:200000])
	if res.StatusCode != 204 || res.Header.Get("Upload-Offset") != "200000" {
		t.Fatalf("first piece: %d %q", res.StatusCode, res.Header.Get("Upload-Offset"))
	}
	// Its whole size is held against the link: another file of 500 KB
	// doesn't fit beside it.
	if res, _ := sendBody(t, "PUT", strings.TrimSuffix(url, "big.bin")+"other", "", bytes.NewReader(make([]byte, 500000))); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("another file beside it: %d", res.StatusCode)
	}
	// Not where it has got to.
	if res, _ := piece(t, url, id, 100, size, data[100:300]); res.StatusCode != http.StatusConflict || res.Header.Get("Upload-Offset") != "200000" {
		t.Errorf("wrong offset: %d %q", res.StatusCode, res.Header.Get("Upload-Offset"))
	}
	// The second piece, cut off part way: what came is kept.
	req, _ := http.NewRequest("PUT", url+"?u="+id, &failingReader{data: data[200000:400000], n: 50000})
	req.ContentLength = 200000
	req.Header.Set("Content-Range", fmt.Sprintf("bytes 200000-399999/%d", size))
	if res, err := http.DefaultTransport.RoundTrip(req); err == nil {
		res.Body.Close()
	}
	var got int64
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		res, _ := shareFetch(t, "HEAD", url+"?u="+id)
		got, _ = strconv.ParseInt(res.Header.Get("Upload-Offset"), 10, 64)
		if got > 200000 {
			break
		}
	}
	if got <= 200000 || got > 250000 {
		t.Fatalf("after a piece cut off, it has %d", got)
	}
	// Carried on from there, to the end.
	if res, _ := piece(t, url, id, got, size, data[got:500000]); res.StatusCode != 204 {
		t.Fatalf("carrying on: %d", res.StatusCode)
	}
	res, body := piece(t, url, id, 500000, size, data[500000:])
	if res.StatusCode != 201 || body != "Uploaded big.bin\n" {
		t.Fatalf("last piece: %d %q", res.StatusCode, body)
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "in", "big.bin")); !bytes.Equal(b, data) {
		t.Errorf("big.bin holds %d bytes", len(b))
	}
	if l := g.shares.list("")[0]; l.Count != 1 || l.Bytes != size {
		t.Errorf("counted as %d files, %d bytes", l.Count, l.Bytes)
	}
	if left, _ := filepath.Glob(filepath.Join(g.downloadsDir, "in", uploadTempPrefix+"*")); len(left) > 0 {
		t.Errorf("left %v", left)
	}
	// A piece that isn't the first, of an upload that isn't going.
	if res, _ := piece(t, url, "zzzzzzzzzzzzzzzz", 10, 20, []byte("x")); res.StatusCode != http.StatusConflict || res.Header.Get("Upload-Offset") != "0" {
		t.Errorf("unknown upload: %d %q", res.StatusCode, res.Header.Get("Upload-Offset"))
	}
	// Too big for what's left.
	if res, _ := piece(t, url, "yyyyyyyyyyyyyyyy", 0, 1<<20, []byte("x")); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("too big: %d", res.StatusCode)
	}
}

// One given up is deleted after partialKeep, freeing its place.
func TestUploadLinkPiecesGivenUp(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	var fire []func()
	g.shares.clock.afterFunc = func(_ time.Duration, f func()) lifecycleTimer {
		fire = append(fire, f)
		return time.NewTimer(time.Hour)
	}
	url := makeUploadLink(t, srv, s, "", 1, 1000)
	if res, _ := piece(t, url+"a.bin", "abcdefghijklmnop", 0, 100, make([]byte, 10)); res.StatusCode != 204 {
		t.Fatalf("first piece: %d", res.StatusCode)
	}
	if res, _ := sendBody(t, "PUT", url+"b.bin", "", strings.NewReader("b")); res.StatusCode != http.StatusForbidden {
		t.Errorf("a second file, with the one it takes going: %d", res.StatusCode)
	}
	for _, f := range fire {
		f()
	}
	if left, _ := filepath.Glob(filepath.Join(g.downloadsDir, uploadTempPrefix+"*")); len(left) > 0 {
		t.Errorf("left %v", left)
	}
	if res, _ := sendBody(t, "PUT", url+"b.bin", "", strings.NewReader("b")); res.StatusCode != 201 {
		t.Errorf("a file, once the one given up has gone: %d", res.StatusCode)
	}
}

// A link shown again, from Share links: across a restart with
// the same key, not with another; and the shares file never holds it.
func TestShareShownAgain(t *testing.T) {
	g, srv, s, file := newShareServer(t)
	keyFile := filepath.Join(filepath.Dir(file), "share-link.key")
	g.shares.key = loadShareKey(keyFile)
	os.WriteFile(filepath.Join(g.downloadsDir, "f.txt"), []byte("x"), 0o644)
	url := makeShare(t, srv, s, "f.txt", 3600, 0)
	token := strings.Split(url, "/")[4]
	l := g.shares.list("")[0]
	if !l.Shown {
		t.Fatalf("not listed as shown again: %+v", l)
	}
	again := func() map[string]any {
		return openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "share-again", Name: l.Handle})
	}
	if r := again(); r["token"] != token || r["name"] != "f.txt" || r["dir"] != false {
		t.Fatalf("shown again: %v", r)
	}
	if raw, _ := os.ReadFile(file); bytes.Contains(raw, []byte(token)) {
		t.Error("the shares file holds the token")
	}
	if st, _ := os.Stat(keyFile); st.Mode().Perm() != 0o600 {
		t.Errorf("the key file is %v", st.Mode().Perm())
	}
	// A restart, with the same key file.
	g.shares = newShareStore(file, g.clock)
	g.shares.key = loadShareKey(keyFile)
	if r := again(); r["token"] != token {
		t.Errorf("after a restart: %v", r)
	}
	// Another key: it still works, but can't be shown.
	g.shares.key = newShareKey()
	if r := again(); !strings.Contains(fmt.Sprint(r["error"]), "can't be shown again") {
		t.Errorf("with another key: %v", r)
	}
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != 200 {
		t.Errorf("the link, with another key: %d", res.StatusCode)
	}
	// One made before links were kept to show (no sealed token).
	for _, x := range g.shares.links {
		x.Sealed = ""
	}
	if g.shares.list("")[0].Shown {
		t.Error("an old link is listed as shown again")
	}
}

// Labels, made and changed, and several links revoked at once.
func TestShareLabelsAndRevokingSeveral(t *testing.T) {
	g, srv, s, file := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("x"), 0o644)
	req := func(r tunnelRequest) map[string]any {
		return openSession(t, testCtx(t), srv, s).request(t, testCtx(t), r)
	}
	if r := req(tunnelRequest{Type: "share", Path: "f", Expires: 3600, Label: "  for Alice  "}); r["ok"] != true {
		t.Fatalf("share: %v", r)
	}
	if r := req(tunnelRequest{Type: "share", Path: "f", Expires: 3600, Label: "two\nlines"}); r["error"] == nil {
		t.Errorf("a label with a line break: %v", r)
	}
	if r := req(tunnelRequest{Type: "share", Path: "f", Expires: 3600, Label: strings.Repeat("x", maxLabel+1)}); r["error"] == nil {
		t.Errorf("a label too long: %v", r)
	}
	l := g.shares.list("")[0]
	if l.Label != "for Alice" {
		t.Fatalf("label %q", l.Label)
	}
	if r := req(tunnelRequest{Type: "reshare", Name: l.Handle, Label: "for Bob"}); r["ok"] != true {
		t.Fatalf("reshare: %v", r)
	}
	if got := newShareStore(file, g.clock).list("")[0].Label; got != "for Bob" {
		t.Errorf("kept as %q", got)
	}
	got, _ := g.activity.list(0)
	if !strings.Contains(got[0].Text, `to f ("for Bob")`) {
		t.Errorf("activity: %+v", got[0])
	}
	// Three links; two revoked in one go.
	makeShare(t, srv, s, "f", 3600, 0)
	makeShare(t, srv, s, "f", 3600, 0)
	all := g.shares.list("")
	r := req(tunnelRequest{Type: "unshare", Names: []string{all[0].Handle, all[1].Handle, "0000000000000000"}})
	if r["revoked"] != float64(2) || len(g.shares.list("")) != 1 {
		t.Errorf("revoking two: %v, %d left", r, len(g.shares.list("")))
	}
	if got, _ := g.activity.list(1); got[0].Text != "revoked the links to f, f" {
		t.Errorf("activity: %q", got[0].Text)
	}
}

// Several links changed at once; and sessions named, as the sessions list
// and the activity log show.
func TestChangeManyAndSessionNames(t *testing.T) {
	g, srv, s, file := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("x"), 0o644)
	now := time.Now()
	g.shares.clock.now = func() time.Time { return now }
	req := func(r tunnelRequest) map[string]any {
		return openSession(t, testCtx(t), srv, s).request(t, testCtx(t), r)
	}
	if r := req(tunnelRequest{Type: "name-session", Label: "work laptop"}); r["ok"] != true {
		t.Fatalf("name-session: %v", r)
	}
	if r := req(tunnelRequest{Type: "name-session", Label: strings.Repeat("x", 51)}); r["error"] == nil {
		t.Errorf("a name too long: %v", r)
	}
	sessions := req(tunnelRequest{Type: "sessions"})
	me := sessions["sessions"].([]any)[0].(map[string]any)
	if me["label"] != "work laptop" || sessions["now"] == nil {
		t.Errorf("sessions: %v", sessions)
	}
	makeShare(t, srv, s, "f", 3600, 1)
	makeShare(t, srv, s, "f", 3600, 0)
	makeShare(t, srv, s, "f", 3600, 0)
	all := g.shares.list("")
	r := req(tunnelRequest{Type: "reshare-many", Names: []string{all[0].Handle, all[1].Handle}, Expires: 7 * 86400, Label: "for Alice", Relabel: true})
	if r["changed"] != float64(2) {
		t.Fatalf("reshare-many: %v", r)
	}
	for _, l := range newShareStore(file, g.clock).list("") {
		changed := l.Handle == all[0].Handle || l.Handle == all[1].Handle
		if changed != (l.Label == "for Alice") || changed != l.Expires.Equal(now.Add(7*24*time.Hour)) {
			t.Errorf("after changing two: %+v", l)
		}
	}
	ones := 0
	for _, l := range g.shares.list("") {
		if l.Max == 1 {
			ones++
		}
	}
	if ones != 1 {
		t.Errorf("limits changed: %d links allow 1 download", ones)
	}
	// Keeping the end, and the label.
	before := g.shares.list("")[0]
	req(tunnelRequest{Type: "reshare-many", Names: []string{before.Handle}})
	for _, l := range g.shares.list("") {
		if l.Handle == before.Handle && (!l.Expires.Equal(before.Expires) || l.Label != before.Label) {
			t.Errorf("kept: %+v, was %+v", l, before)
		}
	}
	got, _ := g.activity.list(0)
	found := false
	for _, e := range got {
		if strings.HasPrefix(e.Text, "changed 2 links (f, f): to end 7 days from now, labelled \"for Alice\"") && e.Session == "work laptop" {
			found = true
		}
	}
	if !found {
		t.Errorf("activity: %+v", got)
	}
}

// A save that fails part way leaves the file as it was.
func TestWriteFileAtomicFailing(t *testing.T) {
	file := filepath.Join(t.TempDir(), "conf", "state.json")
	if err := writeFileAtomic(file, []byte("good")); err != nil {
		t.Fatal(err)
	}
	syncFile = func(*os.File) error { return errors.New("disk on fire") }
	defer func() { syncFile = (*os.File).Sync }()
	if err := writeFileAtomic(file, []byte("half")); err == nil {
		t.Error("a failed sync wasn't reported")
	}
	if b, _ := os.ReadFile(file); string(b) != "good" {
		t.Errorf("the file holds %q", b)
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(file), ".shares-*")); len(left) > 0 {
		t.Errorf("left %v", left)
	}
}

// The folder is synced after the rename, so the new name is on disk too.
func TestWriteFileAtomicSyncsFolder(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	var synced []string
	syncFile = func(f *os.File) error {
		synced = append(synced, f.Name())
		return f.Sync()
	}
	defer func() { syncFile = (*os.File).Sync }()
	if err := writeFileAtomic(file, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if len(synced) != 2 || synced[1] != filepath.Dir(file) {
		t.Errorf("synced %v", synced)
	}
}

// Uploads in pieces starting at once never take more than
// maxLinkPartials places.
func TestUploadLinkPiecesCap(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	// starts starts n uploads at once, through urls in turn, and counts
	// those kept and refused.
	starts := func(urls []string, n int, tag string) (kept, refused int) {
		codes := make([]int, n)
		var wg sync.WaitGroup
		for i := range n {
			wg.Go(func() {
				res, _ := piece(t, urls[i%len(urls)]+fmt.Sprintf("f%s%d.bin", tag, i), fmt.Sprintf("upload%s%09d", tag, i), 0, 100, make([]byte, 10))
				codes[i] = res.StatusCode
			})
		}
		wg.Wait()
		for _, c := range codes {
			switch c {
			case http.StatusNoContent:
				kept++
			case http.StatusServiceUnavailable:
				refused++
			default:
				t.Errorf("answered %d", c)
			}
		}
		return kept, refused
	}
	held := func() (int, int) {
		g.shares.partials.mu.Lock()
		defer g.shares.partials.mu.Unlock()
		return len(g.shares.partials.m), g.shares.partials.starting + len(g.shares.partials.startingFor)
	}
	// Through one link: no more than its share.
	one := makeUploadLink(t, srv, s, "", 0, 1<<30)
	if kept, refused := starts([]string{one}, 40, "a"); kept != maxLinkPartialsPerLink || refused != 40-maxLinkPartialsPerLink {
		t.Errorf("one link: %d kept, %d refused", kept, refused)
	}
	// Through many: no more than all may.
	var many []string
	for range 10 {
		many = append(many, makeUploadLink(t, srv, s, "", 0, 1<<30))
	}
	kept, refused := starts(many, 10*maxLinkPartialsPerLink, "b")
	inMap, starting := held()
	if kept != maxLinkPartials-maxLinkPartialsPerLink || refused != 10*maxLinkPartialsPerLink-kept || inMap != maxLinkPartials || starting != 0 {
		t.Errorf("many links: %d kept, %d refused, %d held, %d starting", kept, refused, inMap, starting)
	}
}

// The same file started again, from the first piece, through the same link
// from the same address (its page reloaded), takes the place of the one
// left, and the room it held in the link's limits; and an upload link's
// uploads in pieces go when it's revoked.
func TestUploadLinkPiecesRestartAndRevoke(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	url := makeUploadLink(t, srv, s, "", 0, 150) + "a.bin"
	if res, _ := piece(t, url, "firstattempt0001", 0, 100, make([]byte, 10)); res.StatusCode != http.StatusNoContent {
		t.Fatalf("first: %d", res.StatusCode)
	}
	// A second 100 bytes wouldn't fit beside the first, but takes its place.
	if res, body := piece(t, url, "secondattempt002", 0, 100, make([]byte, 10)); res.StatusCode != http.StatusNoContent {
		t.Fatalf("started again: %d %s", res.StatusCode, body)
	}
	g.shares.partials.mu.Lock()
	n := len(g.shares.partials.m)
	g.shares.partials.mu.Unlock()
	if n != 1 {
		t.Errorf("%d kept, not 1", n)
	}
	if des, _ := os.ReadDir(g.downloadsDir); len(des) != 1 {
		t.Errorf("in the folder: %v", des)
	}
	g.revokeShares(func(*shareLink) bool { return true })
	g.shares.partials.mu.Lock()
	n = len(g.shares.partials.m)
	g.shares.partials.mu.Unlock()
	if des, _ := os.ReadDir(g.downloadsDir); n != 0 || len(des) != 0 {
		t.Errorf("after revoking: %d kept, %v in the folder", n, des)
	}
}

// An upload in pieces asked about again after it's saved, as a page that
// lost the answer to its last piece does, is told it's done: no second
// file, no second place in the link's limits.
func TestUploadLinkPiecesDoneTwice(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	url := makeUploadLink(t, srv, s, "", 0, 1000) + "a.bin"
	data := []byte("0123456789")
	id := "abcdefghijklmnop"
	if res, body := piece(t, url, id, 0, 10, data); res.StatusCode != 201 || body != "Uploaded a.bin\n" {
		t.Fatalf("the whole file: %d %q", res.StatusCode, body)
	}
	if res, _ := shareFetch(t, "HEAD", url+"?u="+id); res.Header.Get("Upload-Offset") != "10" {
		t.Errorf("asked after: offset %q", res.Header.Get("Upload-Offset"))
	}
	// The last byte again, as the page sends it.
	if res, body := piece(t, url, id, 9, 10, data[9:]); res.StatusCode != 201 || body != "Uploaded a.bin\n" {
		t.Errorf("again: %d %q", res.StatusCode, body)
	}
	if res, _ := piece(t, url, id, 0, 99, make([]byte, 99)); res.StatusCode != http.StatusConflict {
		t.Errorf("another file under the same id: %d", res.StatusCode)
	}
	files, _ := filepath.Glob(filepath.Join(g.downloadsDir, "a*.bin"))
	if l := g.shares.list("")[0]; len(files) != 1 || l.Count != 1 || l.Bytes != 10 {
		t.Errorf("files %v, counted %d, %d bytes", files, l.Count, l.Bytes)
	}
}

// Addresses that miss links are forgotten once they've stopped, and only
// so many are kept at once.
func TestShareMissesBounded(t *testing.T) {
	now := time.Now()
	s := newShareStore("", lifecycleClock{now: func() time.Time { return now }})
	for i := range 500 {
		s.lookup(strings.Repeat("A", 22), fmt.Sprintf("198.51.%d.%d", i/250, i%250))
	}
	if n := len(s.misses); n != 500 {
		t.Fatalf("%d addresses counted", n)
	}
	now = now.Add(shareMissWindow + time.Second)
	s.lookup(strings.Repeat("A", 22), "203.0.113.1")
	if n := len(s.misses); n != 1 {
		t.Errorf("after the window: %d addresses counted", n)
	}
	for i := range maxMissAddresses + 50 {
		now = now.Add(time.Millisecond)
		s.lookup(strings.Repeat("A", 22), fmt.Sprintf("10.%d.%d.%d", i>>16&255, i>>8&255, i&255))
	}
	if n := len(s.misses); n > maxMissAddresses {
		t.Errorf("%d addresses counted, past %d", n, maxMissAddresses)
	}
	if _, kept := s.misses["203.0.113.1"]; kept {
		t.Error("the oldest wasn't the one forgotten")
	}
}

// A folder's address, /fs/<folder>/, with a name shaped like a link's, is
// taken as a link; not found, the page offers the folder, the same whether
// there's one or not.
func TestShareMissOffersFolder(t *testing.T) {
	g, srv, _, _ := newShareServer(t)
	os.Mkdir(filepath.Join(g.downloadsDir, "Project_Notes_2026_dra"), 0o755)
	var pages []string
	for _, name := range []string{"Project_Notes_2026_dra", "No_Such_Folder_2026_xx"} {
		res, body := shareFetch(t, "GET", srv+g.abs(filesPrefix)+name+"/", "Accept", "text/html")
		page := strings.ReplaceAll(string(body), name, "NAME")
		if res.StatusCode != http.StatusNotFound || !strings.Contains(page, `<a href="`+g.abs(filesPrefix)+`#/NAME">open it there</a>`) {
			t.Errorf("%s: %d\n%s", name, res.StatusCode, body)
		}
		pages = append(pages, page)
	}
	if pages[0] != pages[1] {
		t.Error("the page tells whether the folder is there")
	}
	// Not for a file's link, or a program.
	if _, body := shareFetch(t, "GET", srv+g.abs(filesPrefix)+"No_Such_Folder_2026_xx/f.txt", "Accept", "text/html"); strings.Contains(string(body), "open it there") {
		t.Error("offered a folder for a file's link")
	}
	if _, body := shareFetch(t, "GET", srv+g.abs(filesPrefix)+"No_Such_Folder_2026_xx/"); strings.Contains(string(body), "open it there") {
		t.Error("offered a folder to a program")
	}
}

// TestShareDownloadStalls: a download nothing takes is cut off, its place
// given back; and only so many go at once from one address.
func TestShareDownloadStalls(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	shareStall = 300 * time.Millisecond
	defer func() { shareStall = fileStall }()
	os.WriteFile(filepath.Join(g.downloadsDir, "big"), bytes.Repeat([]byte("x"), 64<<20), 0o644)
	url := makeShare(t, srv, s, "big", 3600, 0)
	going := func() int {
		g.shares.mu.Lock()
		defer g.shares.mu.Unlock()
		return g.shares.downloadsAll
	}
	host := strings.TrimPrefix(srv, "http://")
	path := strings.TrimPrefix(url, srv)
	var conns []net.Conn
	for range maxShareDownloadsPerAddress {
		c, err := net.Dial("tcp", host)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\n\r\n", path, host)
		conns = append(conns, c)
	}
	for deadline := time.Now().Add(5 * time.Second); going() < maxShareDownloadsPerAddress; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%d going, not %d", going(), maxShareDownloadsPerAddress)
		}
	}
	// One more from here: refused, while they hold their places.
	if res, _ := shareFetch(t, "HEAD", url); res.StatusCode != http.StatusOK {
		t.Errorf("HEAD: %d", res.StatusCode)
	}
	counted := g.shares.list("")[0].Count
	req, _ := http.NewRequest("GET", url, nil)
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("one more at once: %d", res.StatusCode)
	}
	if n := g.shares.list("")[0].Count; n != counted {
		t.Errorf("one refused was counted: %d, then %d", counted, n)
	}
	// Not read: cut off, and their places given back.
	for deadline := time.Now().Add(10 * time.Second); going() > 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%d still going, unread", going())
		}
	}
}

// TestShareFilesNotLost: a links file or key file that can't be read is
// left as it is, not saved over; one that isn't what it should be is set
// aside, what it holds kept.
func TestShareFilesNotLost(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any file")
	}
	dir := t.TempDir()
	aside := func(file string) []string {
		got, _ := filepath.Glob(file + ".broken-*")
		return got
	}
	// Links: a typo, then unreadable.
	links := filepath.Join(dir, "shares.json")
	os.WriteFile(links, []byte(`{"links": [,]}`), 0o600)
	s := newShareStore(links, lifecycleClock{})
	s.mu.Lock()
	s.saveLocked()
	s.mu.Unlock()
	if got := aside(links); len(got) != 1 {
		t.Errorf("set aside: %v", got)
	} else if b, _ := os.ReadFile(got[0]); string(b) != `{"links": [,]}` {
		t.Errorf("set aside as %q", b)
	}
	os.WriteFile(links, []byte(`{"links": []}`), 0o600)
	os.Chmod(links, 0o000)
	s = newShareStore(links, lifecycleClock{})
	s.mu.Lock()
	s.saveLocked()
	s.mu.Unlock()
	os.Chmod(links, 0o600)
	if b, _ := os.ReadFile(links); string(b) != `{"links": []}` {
		t.Errorf("an unreadable links file was saved over: %q", b)
	}
	// The key: not a key, then unreadable.
	key := filepath.Join(dir, "share.key")
	os.WriteFile(key, []byte("short"), 0o600)
	if k := loadShareKey(key); len(k) != 32 {
		t.Fatalf("a key of %d bytes", len(k))
	}
	if got := aside(key); len(got) != 1 {
		t.Errorf("not a key, set aside: %v", got)
	}
	good, _ := os.ReadFile(key)
	os.Chmod(key, 0o000)
	loadShareKey(key)
	os.Chmod(key, 0o600)
	if b, _ := os.ReadFile(key); !bytes.Equal(b, good) {
		t.Error("an unreadable key was saved over")
	}
}

// TestShareLimitOfLinks: past maxShares, a link is refused, saying why,
// rather than another ended to make room.
func TestShareLimitOfLinks(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("x"), 0o644)
	st, _ := os.Stat(filepath.Join(g.downloadsDir, "f"))
	for range maxShares {
		if _, _, err := g.shares.create("f", st, shareSpec{Life: time.Hour}, "", "192.0.2.1"); err != nil {
			t.Fatal(err)
		}
	}
	r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "share", Path: "f", Expires: 3600})
	g.shares.mu.Lock()
	n := len(g.shares.links)
	g.shares.mu.Unlock()
	if r["error"] != errTooManyShares.Error() || n != maxShares {
		t.Errorf("one more: %v; %d links", r, n)
	}
}

// TestShareNotModifiedNotCounted: a client asking only if the file has
// changed (wget -N), told it hasn't, hasn't downloaded it: the link's
// download is still there.
func TestShareNotModifiedNotCounted(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f"), []byte("hello"), 0o644)
	url := makeShare(t, srv, s, "f", 3600, 1)
	later := time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)
	if res, _ := shareFetch(t, "GET", url, "If-Modified-Since", later); res.StatusCode != http.StatusNotModified {
		t.Fatalf("not modified: %d", res.StatusCode)
	}
	if res, body := shareFetch(t, "GET", url); res.StatusCode != 200 || string(body) != "hello" {
		t.Errorf("then downloaded: %d %q", res.StatusCode, body)
	}
	// And used up, it's refused plainly, not as a file.
	res, body := shareFetch(t, "GET", url)
	if res.StatusCode != http.StatusGone || res.Header.Get("Content-Disposition") != "" || strings.Contains(string(body), "hello") {
		t.Errorf("used up: %d %v %q", res.StatusCode, res.Header, body)
	}
}

// TestUploadLinkFloodNotLogged: file after file through an upload link with
// no limit on files, from one address, is logged once in a while, not for
// each, so it can't push all else out of the activity log.
func TestUploadLinkFloodNotLogged(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	url := makeUploadLink(t, srv, s, "", 0, 1<<20)
	for i := range 30 {
		if res, body := sendBody(t, "PUT", url+fmt.Sprintf("f%d.txt", i), "", strings.NewReader("x")); res.StatusCode != http.StatusCreated {
			t.Fatalf("upload %d: %d %s", i, res.StatusCode, body)
		}
	}
	entries, _ := g.activity.list(0)
	n := 0
	for _, e := range entries {
		if e.Kind == "upload" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("%d upload entries for 30 files from one address", n)
	}
	if got := g.shares.list("")[0].Count; got != 30 {
		t.Errorf("counted %d", got)
	}
}

// TestShareChangeCountsUploadsGoing: a link's file limit can't be lowered
// below what it has, with the uploads going on, which can't be refused once
// begun.
func TestShareChangeCountsUploadsGoing(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	makeUploadLink(t, srv, s, "", 10, 1<<20)
	h := g.shares.list("")[0].Handle
	g.shares.mu.Lock()
	for _, l := range g.shares.links {
		l.Count, l.pending, l.pendingBytes = 2, 3, 300
	}
	g.shares.mu.Unlock()
	if _, err := g.shares.change(h, 0, 3, 1<<20, ""); err == nil || !strings.Contains(err.Error(), "5 times already, with those going on") {
		t.Errorf("limit of 3, with 2 and 3 going: %v", err)
	}
	if _, err := g.shares.change(h, 0, 5, 1<<20, ""); err != nil {
		t.Errorf("limit of 5: %v", err)
	}
	if _, err := g.shares.change(h, 0, 5, 200, ""); err == nil {
		t.Error("room of 200 bytes, with 300 coming")
	}
}

// TestShareNotDownloadsItself: Downloads itself can't be shared to
// download, however its path is put; it can be given an upload link.
func TestShareNotDownloadsItself(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.Mkdir(filepath.Join(g.downloadsDir, "a"), 0o755)
	for _, p := range []string{"", "/", ".", "./", "/./", "a/..", "a/../.", "//"} {
		r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "share", Path: p, Expires: 3600})
		if r["error"] != "Share a file or folder in Downloads, not Downloads itself." {
			t.Errorf("%q: %v", p, r)
		}
	}
	if r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t),
		tunnelRequest{Type: "share", Path: "./", Expires: 3600, Upload: true, MaxBytes: 1 << 20}); r["ok"] != true {
		t.Errorf("an upload link into Downloads: %v", r)
	}
}

// TestUploadLinkUploadsAtOnce: whole-file uploads that send nothing (each
// holding a temporary file and a buffer) are held to so many through one
// link, and through all; those past that are turned away, not held.
func TestUploadLinkUploadsAtOnce(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	host := strings.TrimPrefix(srv, "http://")
	held := func() int {
		g.shares.mu.Lock()
		defer g.shares.mu.Unlock()
		return g.shares.uploadsAll
	}
	// start sends n uploads' headers through url, then nothing.
	start := func(url string, n int) {
		path := strings.TrimPrefix(url, srv)
		for i := range n {
			c, err := net.Dial("tcp", host)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { c.Close() })
			fmt.Fprintf(c, "PUT %sf%d.bin HTTP/1.1\r\nHost: %s\r\nContent-Length: 1\r\n\r\n", path, i, host)
		}
		time.Sleep(500 * time.Millisecond) // all at the server, as many held as are
	}
	start(makeUploadLink(t, srv, s, "", 0, 1), 65)
	if n := held(); n != maxLinkUploadsAtOnce {
		t.Errorf("through one link, 65 at once: %d held", n)
	}
	for range 6 {
		start(makeUploadLink(t, srv, s, "", 0, 1), maxLinkUploadsAtOnce)
	}
	if n := held(); n != maxLinkUploadsAll {
		t.Errorf("through many: %d held", n)
	}
}

// TestShareDirectDownload: a preview's Direct Download: a link for one
// download, counted as it's made, with a ticket that fetches the file (not
// the link's page) over HTTPS; once it's all gone, the link goes.
func TestShareDirectDownload(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f.txt"), []byte("hello"), 0o644)
	req := tunnelRequest{Type: "share", Path: "f.txt", Expires: 3600, Max: 1, Direct: true, Label: "Direct Download"}
	r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), req)
	ticket, _ := r["ticket"].(string)
	if r["ok"] != true || ticket == "" {
		t.Fatalf("%v", r)
	}
	if l := g.shares.list(""); len(l) != 1 || l[0].Count != 1 {
		t.Fatalf("counted as made: %+v", l)
	}
	url := srv + filesPrefix + r["token"].(string) + "/f.txt?t=" + ticket
	if res, body := shareFetch(t, "GET", url, "Accept", "text/html"); res.StatusCode != 200 || string(body) != "hello" ||
		!strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") {
		t.Errorf("with its ticket, from a browser: %d %v %q", res.StatusCode, res.Header, body)
	}
	if l := g.shares.list(""); len(l) != 0 {
		t.Errorf("still listed: %+v", l)
	}
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != http.StatusNotFound {
		t.Errorf("again: %d", res.StatusCode)
	}
	// Only for one download, of a file.
	for _, bad := range []tunnelRequest{{Type: "share", Path: "f.txt", Expires: 3600, Max: 2, Direct: true},
		{Type: "share", Path: "", Expires: 3600, Max: 1, Direct: true, Upload: true, MaxBytes: 10}} {
		if r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), bad); r["error"] != "A direct download is of a file, once." {
			t.Errorf("%+v: %v", bad, r)
		}
	}
}

// TestUploadFormPartsCapped: a form posted through an upload link has at
// most maxFormParts parts read, refused ones too, so it can't hold on to
// more and more of the server's memory.
func TestUploadFormPartsCapped(t *testing.T) {
	_, srv, s, _ := newShareServer(t)
	url := makeUploadLink(t, srv, s, "", 1, 1)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for i := range 10000 {
		w, _ := mw.CreateFormFile("file", fmt.Sprintf(".hidden-%d", i)) // a name refused
		w.Write([]byte("x"))
	}
	mw.Close()
	res, out := sendBody(t, "POST", url, mw.FormDataContentType(), &body)
	lines := strings.Count(out, "\n")
	if res.StatusCode != http.StatusRequestEntityTooLarge || lines > maxFormParts+1 || !strings.Contains(out, "Only 100 files can be sent at once") {
		t.Errorf("%d, %d lines: %.200s", res.StatusCode, lines, out)
	}
}
