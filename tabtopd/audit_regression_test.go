package main

import (
	"bytes"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestWrongSessionSecretDoesNotTouchSession(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	eventually(t, "login handshake ended", func() bool { g.handshakes.mu.Lock(); defer g.handshakes.mu.Unlock(); return g.handshakes.total == 0 })
	g.mu.Lock()
	idle, since, used := g.sessions[s.id].idle, g.sessions[s.id].idleSince, g.sessions[s.id].uses[0].Last
	g.mu.Unlock()
	tc := openSession(t, ctx, srv.URL, testSession{id: s.id, secret: make([]byte, 32)})
	tc.write(ctx, msgText, []byte(`{"type":"sessions"}`))
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("wrong secret: %v", err)
	}
	eventually(t, "failed handshake ended", func() bool { g.handshakes.mu.Lock(); defer g.handshakes.mu.Unlock(); return g.handshakes.total == 0 })
	g.mu.Lock()
	defer g.mu.Unlock()
	state := g.sessions[s.id]
	if len(state.open) != 0 || state.idle != idle || state.idleSince != since || state.uses[0].Last != used {
		t.Fatal("unauthenticated request changed session slots, idle expiration or usage history")
	}
}

type countedFormBody struct {
	io.Reader
	n int
}

func (body *countedFormBody) Read(p []byte) (int, error) {
	n, err := body.Reader.Read(p)
	body.n += n
	return n, err
}

func uploadFormFixture(t *testing.T, quota int64) (*server, *downloadStore, *shareLink) {
	t.Helper()
	g, _ := newE2EServer(t)
	g.shares = newShareStore("", g.clock)
	st, err := os.Stat(g.downloadsDir)
	if err != nil {
		t.Fatal(err)
	}
	_, link, err := g.shares.create(".", st, shareSpec{Life: time.Hour, Upload: true, MaxBytes: quota}, "owner", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return g, store, link
}

func TestUploadFormRejectsWithoutDraining(t *testing.T) {
	for _, kind := range []string{"quota", "filename", "ignored"} {
		t.Run(kind, func(t *testing.T) {
			quota := int64(1)
			if kind == "ignored" {
				quota = 1 << 30
			}
			g, store, link := uploadFormFixture(t, quota)
			var body bytes.Buffer
			mw := multipart.NewWriter(&body)
			var part io.Writer
			if kind == "ignored" {
				part, _ = mw.CreateFormField("ignored")
			} else {
				name := "large.bin"
				if kind == "filename" {
					name = ".hidden"
				}
				part, _ = mw.CreateFormFile("file", name)
			}
			part.Write(bytes.Repeat([]byte{'x'}, 8<<20))
			mw.Close()
			reader := &countedFormBody{Reader: bytes.NewReader(body.Bytes())}
			r := httptest.NewRequest("POST", "/fs/token/", reader)
			r.Header.Set("Content-Type", mw.FormDataContentType())
			w := httptest.NewRecorder()
			g.receiveForm(w, r, link, store, false, "127.0.0.1")
			if w.Code < 400 || reader.n >= body.Len()/2 || w.Header().Get("Connection") != "close" {
				t.Fatalf("rejected form consumed %d of %d bytes; status %d, headers %v", reader.n, body.Len(), w.Code, w.Header())
			}
			if g.shares.formsAll != 0 || g.shares.uploadsAll != 0 {
				t.Fatal("rejection leaked admission slots")
			}
		})
	}
}

func TestUploadFormAdmissionPrecedesBodyParsing(t *testing.T) {
	g, store, link := uploadFormFixture(t, 1<<30)
	for range maxUploadFormsPerLink {
		_, done, err := g.shares.startForm(link)
		if err != nil {
			t.Fatal(err)
		}
		defer done()
	}
	reader := &countedFormBody{Reader: bytes.NewBufferString("not even parsed")}
	r := httptest.NewRequest("POST", "/", reader)
	w := httptest.NewRecorder()
	g.receiveForm(w, r, link, store, false, "127.0.0.1")
	if w.Code != http.StatusServiceUnavailable || reader.n != 0 {
		t.Fatalf("admission read %d bytes, status %d", reader.n, w.Code)
	}
}

func TestReplacingDirectoryAliasesSerialize(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "real"), 0755)
	os.Symlink("real", filepath.Join(dir, "alias"))
	os.WriteFile(filepath.Join(dir, "real", "f.txt"), []byte("old"), 0644)
	store, _ := openDownloadStore(dir)
	defer store.Close()
	st, _ := store.stat("real/f.txt")
	version := fileVersion(st)
	u, err := store.startUpload("real")
	if err != nil {
		t.Fatal(err)
	}
	u.Write([]byte("first"))
	target, unlock, err := store.beginReplacement("real/f.txt")
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	release := func() { once.Do(unlock) }
	defer release()
	if err := unchangedSince(target, "f.txt", version, 3); err != nil {
		t.Fatal(err)
	}
	started, result := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		target, unlock, err := store.beginReplacement("alias/f.txt")
		if err != nil {
			result <- err
			return
		}
		defer unlock()
		result <- unchangedSince(target, "f.txt", version, 3)
	}()
	<-started
	select {
	case err := <-result:
		t.Fatalf("alias bypassed replacement lock: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	if _, err := u.finishAt("f.txt", true, target); err != nil {
		t.Fatal(err)
	}
	release()
	if err := <-result; !errors.Is(err, errChangedSince) {
		t.Fatalf("second writer did not detect conflict: %v", err)
	}
}

func TestReplacingPinsDestinationAcrossAliasRetarget(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"real", "other"} {
		os.Mkdir(filepath.Join(dir, name), 0755)
		os.WriteFile(filepath.Join(dir, name, "f.txt"), []byte("old"), 0644)
	}
	os.Symlink("real", filepath.Join(dir, "alias"))
	store, _ := openDownloadStore(dir)
	defer store.Close()
	u, err := store.startUpload("alias")
	if err != nil {
		t.Fatal(err)
	}
	u.Write([]byte("new"))
	target, unlock, err := store.beginReplacement("alias/f.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	os.Remove(filepath.Join(dir, "alias"))
	os.Symlink("other", filepath.Join(dir, "alias"))
	os.WriteFile(filepath.Join(dir, "other", filepath.Base(u.tmp)), []byte("keep"), 0644)
	if _, err := u.finishAt("f.txt", true, target); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"real": "new", "other": "old"} {
		got, _ := os.ReadFile(filepath.Join(dir, name, "f.txt"))
		if string(got) != want {
			t.Fatalf("%s: %q, want %q", name, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "real", filepath.Base(u.tmp))); !os.IsNotExist(err) {
		t.Fatal("pinned temporary file was not removed")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "other", filepath.Base(u.tmp))); string(got) != "keep" {
		t.Fatal("cleanup followed a retargeted alias")
	}
}
