package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func rootFixture(t *testing.T) (string, string, string) {
	t.Helper()
	home := t.TempDir()
	data := t.TempDir()
	for _, name := range []string{"Downloads", "Documents"} {
		if err := os.Mkdir(filepath.Join(home, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	return home, data, filepath.Join(home, "Downloads")
}
func TestFileRootsConfiguration(t *testing.T) {
	home, data, downloads := rootFixture(t)
	spec := "Downloads:rw,Documents:ro,data=" + data + ":rw"
	roots, err := parseFileRoots(spec, home, downloads)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 3 || roots[0].ID != "downloads" || roots[1].ID != "documents" || !roots[1].ReadOnly || roots[2].Path != data || roots[1].ShellPath != "~/Documents" {
		t.Fatalf("roots: %+v", roots)
	}
	if roots[0].Binding == roots[1].Binding || len(roots[1].Binding) != 64 {
		t.Fatal("root identities missing")
	}
	os.Symlink(filepath.Join(home, "Documents"), filepath.Join(home, "alias"))
	for _, bad := range []string{"Documents:bad", "Documents:ro,documents:rw", "missing:ro", "../outside", "Documents:ro,alias:rw", "home=" + home + ":rw,Documents:ro", "=Documents", "Downloads:ro,"} {
		if _, err := parseFileRoots(bad, home, downloads); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}
func newRootsServer(t *testing.T, docsMode string) (*server, *httptest.Server) {
	t.Helper()
	home, data, downloads := rootFixture(t)
	g, srv := newE2EServerWith(t, func(c *serverConfig) {
		c.downloadsDir = downloads
		c.fsHome = home
		c.fsRoots = "Downloads:rw,Documents:" + docsMode + ",data=" + data + ":rw"
		c.shareOn = true
		c.fetchOn = true
		c.sharesFile = filepath.Join(t.TempDir(), "shares.json")
		c.activityFile = filepath.Join(t.TempDir(), "activity.jsonl")
	})
	for _, r := range g.roots {
		os.WriteFile(filepath.Join(r.Path, "same.txt"), []byte(r.ID), 0644)
	}
	return g, srv
}
func rootRequest(t *testing.T, ctx context.Context, url string, s testSession, req tunnelRequest) map[string]any {
	t.Helper()
	tc := openSession(t, ctx, url, s)
	defer tc.c.CloseNow()
	return tc.request(t, ctx, req)
}
func TestRootsReadOnlyEnforcement(t *testing.T) {
	g, srv := newRootsServer(t, "ro")
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	for _, typ := range []string{"upload", "mkdir", "create", "rename", "move", "delete", "zip-extract", "file-patch", "epub-edit", "trash-restore", "trash-delete", "trash-empty", "fetch", "share"} {
		req := tunnelRequest{Type: typ, Root: "documents", Path: "same.txt", Name: "new.txt", Upload: typ == "share"}
		if typ == "fetch" {
			req.Name = ""
		}
		reply := rootRequest(t, ctx, srv.URL, s, req)
		if reply["code"] != "read-only" {
			t.Errorf("%s wasn't blocked: %v", typ, reply)
		}
	}
	for _, id := range []string{"downloads", "documents", "data"} {
		reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "list", Root: id})
		if reply["ok"] != true || reply["root"].(map[string]any)["id"] != id {
			t.Fatal(reply)
		}
		if id == "documents" && reply["read_only"] != true {
			t.Fatal("missing read-only capability")
		}
		tc := openSession(t, ctx, srv.URL, s)
		reply = tc.request(t, ctx, tunnelRequest{Type: "file", Root: id, Path: "same.txt"})
		if reply["ok"] != true {
			t.Fatal(reply)
		}
		kind, data, err := tc.read(ctx)
		tc.c.CloseNow()
		if err != nil || kind != msgData || string(data) != id {
			t.Fatalf("%s read %q: %v", id, data, err)
		}
	}
	docs, _ := g.rootByID("documents")
	os.Symlink(g.downloadsDir, filepath.Join(docs.Path, "escape"))
	for _, p := range []string{"../Downloads/same.txt", "escape/same.txt"} {
		if reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "file", Root: "documents", Path: p}); reply["error"] == nil {
			t.Fatal("escaped root", reply)
		}
	}
	if reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "list", Root: "missing"}); reply["error"] == nil {
		t.Fatal("unknown root accepted")
	}
	if reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "move", Root: "downloads", ToRoot: "data", Path: "same.txt"}); reply["error"] == nil {
		t.Fatal("cross-root move accepted")
	}
	if reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "list", Root: "data", RootVersion: docs.Binding}); reply["code"] != "root-changed" {
		t.Fatal("stale root identity accepted", reply)
	}
	// Dry-run cleanup and listing Trash may not create or prune anything.
	rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "cleanup", Root: "documents", DryRun: true})
	rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "trash-list", Root: "documents"})
	if exists(filepath.Join(docs.Path, trashDir)) {
		t.Fatal("read-only access created Trash")
	}
}
func TestRootTrashAndUploadsStayIndependent(t *testing.T) {
	g, srv := newRootsServer(t, "ro")
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	for _, id := range []string{"downloads", "data"} {
		reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "delete", Root: id, Path: "same.txt"})
		if reply["ok"] != true {
			t.Fatal(reply)
		}
		reply = rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "trash-list", Root: id})
		entries := reply["entries"].([]any)
		if len(entries) != 1 {
			t.Fatal(reply)
		}
		entryID := entries[0].(map[string]any)["id"].(string)
		other := "data"
		if id == "data" {
			other = "downloads"
		}
		if reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "trash-restore", Root: other, Name: entryID}); reply["error"] == nil {
			t.Fatal("cross-root restore accepted")
		}
		reply = rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "trash-restore", Root: id, Name: entryID})
		if reply["ok"] != true {
			t.Fatal(reply)
		}
	}
	data, _ := g.rootByID("data")
	if &g.scope(data).root.transfers == &g.defaultFiles().root.transfers || &g.scope(data).root.trashMu == &g.defaultFiles().root.trashMu {
		t.Fatal("runtime state shared")
	}
	docs, _ := g.rootByID("documents")
	b, _ := os.ReadFile(filepath.Join(docs.Path, "same.txt"))
	if string(b) != "documents" {
		t.Fatal("other root changed")
	}
}
func TestRootSharesPersistAndLegacySharesAreDropped(t *testing.T) {
	g, srv := newRootsServer(t, "ro")
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "share", Root: "documents", Path: "same.txt", Expires: 3600})
	token, ok := reply["token"].(string)
	if !ok {
		t.Fatal(reply)
	}
	url := srv.URL + "/fs/" + token + "/same.txt"
	if res, b := shareFetch(t, "GET", url); res.StatusCode != 200 || string(b) != "documents" {
		t.Fatalf("share %d %q", res.StatusCode, b)
	}
	g.shares = newShareStore(g.sharesFile, g.clock)
	if res, b := shareFetch(t, "GET", url); res.StatusCode != 200 || string(b) != "documents" {
		t.Fatalf("reloaded share %d %q", res.StatusCode, b)
	}
	var saved map[string]any
	b, _ := os.ReadFile(g.sharesFile)
	json.Unmarshal(b, &saved)
	if saved["version"] != float64(2) {
		t.Fatal("wrong share format")
	}
	saved["version"] = 1
	b, _ = json.Marshal(saved)
	os.WriteFile(g.sharesFile, b, 0600)
	g.shares = newShareStore(g.sharesFile, g.clock)
	if res, _ := shareFetch(t, "GET", url); res.StatusCode != 404 {
		t.Fatalf("legacy share survived: %d", res.StatusCode)
	}
	if len(g.shares.list("")) != 0 {
		t.Fatal("legacy shares retained")
	}
	entries, _ := g.activity.list(0)
	found := false
	for _, entry := range entries {
		if entry.Root == "documents" && entry.Path == "same.txt" {
			found = true
		}
	}
	if !found {
		t.Fatal("activity didn't record root/path")
	}
}
func TestShareBindingRejectsReassignedRootAndReadOnlyUploadLinks(t *testing.T) {
	g, srv := newRootsServer(t, "rw")
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "share", Root: "documents", Path: "", Upload: true, Expires: 3600, MaxBytes: 1024})
	token, ok := reply["token"].(string)
	if !ok {
		t.Fatal(reply)
	}
	url := srv.URL + "/fs/" + token + "/"
	docs, _ := g.rootByID("documents")
	docs.ReadOnly = true
	if res, _ := shareFetch(t, "POST", url); res.StatusCode != 404 {
		t.Fatalf("read-only public upload returned %d", res.StatusCode)
	}
	docs.ReadOnly = false
	reply = rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "share", Root: "data", Path: "same.txt", Expires: 3600})
	fileToken := reply["token"].(string)
	c := g.serverConfig
	replacement := t.TempDir()
	os.WriteFile(filepath.Join(replacement, "same.txt"), []byte("replacement"), 0644)
	c.fsRoots = "Downloads:rw,Documents:rw,data=" + replacement + ":rw"
	restarted, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	other := httptest.NewServer(restarted.handler())
	defer other.Close()
	if res, _ := shareFetch(t, "GET", other.URL+"/fs/"+fileToken+"/same.txt"); res.StatusCode != 404 {
		t.Fatalf("root reassignment served %d", res.StatusCode)
	}
}
func TestRootFetchManagersAndPinnedDirectories(t *testing.T) {
	g, _ := newRootsServer(t, "ro")
	data, _ := g.rootByID("data")
	service := g.scope(data)
	original := data.Path
	renamed := original + "-moved"
	if err := os.Rename(original, renamed); err != nil {
		t.Fatal(err)
	}
	os.Mkdir(original, 0755)
	os.WriteFile(filepath.Join(original, "same.txt"), []byte("wrong"), 0644)
	// A replacement at the root's path is never served, and the moved-away
	// original isn't served through a stale handle either.
	if item, err := service.openFile("same.txt"); err == nil {
		item.Close()
		t.Fatal("served a root that was replaced")
	}
	if store, err := service.openStore(); err == nil {
		store.Close()
		t.Fatal("opened a root that was replaced")
	}
	// Put back, it's the same folder again.
	if err := os.RemoveAll(original); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(renamed, original); err != nil {
		t.Fatal(err)
	}
	item, err := service.openFile("same.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer item.Close()
	buf := make([]byte, 16)
	n, _ := item.file.Read(buf)
	if string(buf[:n]) != "data" {
		t.Fatal("wrong folder after restoring the root")
	}
	if service.root.fetches == g.defaultRoot().fetches || service.root.fetches.files.root != service.root {
		t.Fatal("fetch state shared")
	}
}
func TestRootResumeAndFetchStateStayInTheirRoot(t *testing.T) {
	g, _ := newRootsServer(t, "ro")
	root, _ := g.rootByID("data")
	service := g.scope(root)
	store, err := service.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	other, err := g.defaultFiles().openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	upload, err := store.startUpload(".")
	if err != nil {
		t.Fatal(err)
	}
	upload.f.Write([]byte("he"))
	id := upload.id()
	service.root.transfers.keepPartial(upload, 5)
	if got, _ := g.defaultFiles().root.transfers.claimPartial(other, id, ".", 5); got != nil {
		got.abort()
		t.Fatal("claimed upload from another root")
	}
	resumed, offset := service.root.transfers.claimPartial(store, id, ".", 5)
	if resumed == nil || offset != 2 {
		t.Fatalf("resume offset %d", offset)
	}
	resumed.abort()
	service.root.transfers.recordDone(id, ".", 5, map[string]any{"name": "done.txt"})
	if g.defaultFiles().root.transfers.wasDone(id) {
		t.Fatal("completed upload crossed roots")
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="fetched.txt"`)
		w.Write([]byte("data fetch"))
	}))
	defer remote.Close()
	service.root.fetches.client = http.DefaultClient
	address, _ := url.Parse(remote.URL)
	job, err := service.root.fetches.start(address, ".", fetchOrigin{by: "owner", ip: "127.0.0.1", who: "test"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-job.done:
	case <-time.After(5 * time.Second):
		t.Fatal("fetch didn't finish")
	}
	if got, _ := os.ReadFile(filepath.Join(root.Path, "fetched.txt")); string(got) != "data fetch" {
		t.Fatal("fetch went to the wrong root", job.state())
	}
	if exists(filepath.Join(g.downloadsDir, "fetched.txt")) {
		t.Fatal("fetch wrote Downloads")
	}
	entries, _ := g.activity.list(0)
	found := false
	for _, entry := range entries {
		if entry.Root == "data" && entry.Kind == "fetch" {
			found = true
		}
	}
	if !found {
		t.Fatal("fetch activity omitted its root")
	}
}

func TestRootAccessPolicyCoversAllMutations(t *testing.T) {
	globals := map[string]bool{"roots": true, "share-again": true, "reshare": true, "reshare-many": true, "unshare": true, "cleanup": true, "trash-all": true}
	for name, route := range tunnelRoutes {
		if route.files && route.access == noFileRoot && !globals[name] {
			t.Errorf("file route %s lacks a root access policy", name)
		}
	}
	// A move between roots writes its own root; a copy only reads it.
	if !tunnelRoutes["transfer"].writes(tunnelRequest{Type: "transfer"}) || tunnelRoutes["transfer"].writes(tunnelRequest{Type: "transfer", Copy: true}) {
		t.Error("transfer's write policy")
	}
	for _, name := range []string{"upload", "mkdir", "create", "rename", "move", "delete", "zip-extract", "file-patch", "epub-edit", "trash-restore", "trash-delete", "trash-empty"} {
		if tunnelRoutes[name].access != writeFileRoot {
			t.Errorf("%s lacks write policy", name)
		}
	}
	for _, name := range []string{"list", "file", "zip", "zip-preview", "zip-download", "file-search", "markdown", "epub", "sqlite", "preview-resource", "changes", "watch", "trash-list"} {
		if tunnelRoutes[name].access != readFileRoot {
			t.Errorf("%s lacks read policy", name)
		}
	}
}

// A root's ID, made from its name, takes what a name can have: "~" is
// Home, and a space is a dash.
func TestRootIDsFromNames(t *testing.T) {
	home := t.TempDir()
	other := filepath.Join(t.TempDir(), "My Files")
	os.MkdirAll(other, 0o755)
	eq := filepath.Join(t.TempDir(), "run=3")
	os.MkdirAll(eq, 0o755)
	script := filepath.Join(t.TempDir(), "Документы")
	os.MkdirAll(script, 0o755)
	for spec, want := range map[string]string{"~": "home=Home", other: "my-files=My Files", eq: "run-3=run=3",
		script: rootIDFor("Документы") + "=Документы"} {
		roots, _, err := parseFileRootsAll(spec, home, filepath.Join(home, "Downloads"))
		if err != nil || len(roots) != 1 || roots[0].ID+"="+roots[0].Label != want {
			t.Fatalf("%q: %v %v", spec, roots, err)
		}
	}
}

// A root holding the gateway's own files is told apart from one beside
// them, links followed.
func TestStateFileIn(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config", "tabtop"), 0o755)
	os.MkdirAll(filepath.Join(home, "Downloads"), 0o755)
	os.Symlink(home, filepath.Join(home, "Downloads", "up"))
	key := filepath.Join(home, ".config", "tabtop", "passkeys.json") // not made yet
	files := []string{"", key}
	for dir, held := range map[string]bool{home: true, filepath.Join(home, ".config"): true, filepath.Join(home, "Downloads"): false,
		filepath.Join(home, "Downloads", "up"): true} {
		if got := stateFileIn(dir, files) != ""; got != held {
			t.Errorf("%s: held %v", dir, got)
		}
	}
}

// Downloads, where the desktop saves, is the default root by its place,
// whatever it's named.
func TestDefaultRootByPlace(t *testing.T) {
	home := t.TempDir()
	downloads := filepath.Join(home, "Downloads")
	os.MkdirAll(downloads, 0o755)
	roots, _, err := parseFileRootsAll("Files="+downloads+":rw", home, downloads)
	if err != nil || len(roots) != 1 || roots[0].ID != "files" || !roots[0].Default {
		t.Fatalf("roots: %+v %v", roots, err)
	}
	g := &server{roots: roots}
	if root, err := g.rootByID(""); err != nil || root != roots[0] {
		t.Fatalf("with none named: %v %v", root, err)
	}
}
