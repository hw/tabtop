package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// mseTunnelPair is a server's tunnel and its client's, over a real
// WebSocket, as a buffered stream's stage is served (serveMSEStage).
func mseTunnelPair(t *testing.T) (srv, cli *tunnel) {
	t.Helper()
	fromClient, fromServer := make([]byte, 32), make([]byte, 32)
	rand.Read(fromClient)
	rand.Read(fromServer)
	conns := make(chan *websocket.Conn, 1)
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conns <- c
		<-r.Context().Done()
	}))
	t.Cleanup(hs.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cc, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(hs.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	cc.SetReadLimit(64 << 20)
	sc := <-conns
	sc.SetReadLimit(64 << 20)
	if srv, err = newTunnel(sc, fromClient, fromServer); err != nil {
		t.Fatal(err)
	}
	if cli, err = newTunnel(cc, fromServer, fromClient); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cc.CloseNow(); sc.CloseNow() })
	return srv, cli
}

// mseSend sends one stage frame as go.js does (header and data, each
// message acknowledged by the server).
func mseSend(t *testing.T, cli *tunnel, track int, kind byte, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	frame := make([]byte, 6, 6+len(data))
	frame[0], frame[1] = byte(track), kind
	binary.BigEndian.PutUint32(frame[2:], uint32(len(data)))
	frame = append(frame, data...)
	if err := cli.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatal(err)
	}
	if _, _, err := cli.Read(ctx); err != nil { // its acknowledgement
		t.Fatal(err)
	}
}

// mseReply is the server's next text message, as JSON.
func mseReply(t *testing.T, cli *tunnel) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		typ, p, err := cli.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ != websocket.MessageText {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(p, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
}

func mseHeld(m *fetchManager) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mseBytes
}

// TestMSEFinalizeGivesBackStage: a stage finalized (Save) gives back what
// it held of all stages' bytes, and its write into the folder, whether
// the save then works or not. (They were kept for good: after 2 GiB of
// saves, every spill was refused till tabtopd restarted, and the folder
// couldn't be deleted.)
func TestMSEFinalizeGivesBackStage(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("tab-1", ".")
	if err != nil {
		t.Fatal(err)
	}
	srv, cli := mseTunnelPair(t)
	served := make(chan struct{})
	go func() {
		defer close(served)
		m.serveMSEStage(srv, stage, &tunnelResponder{t: srv}, "by", "127.0.0.1", "who", nil, "")
	}()
	mseSend(t, cli, 0, mseKindInit, []byte("not really an init"))
	mseSend(t, cli, 0, mseKindPart, []byte("not really a part"))
	if held := mseHeld(m); held == 0 {
		t.Fatal("nothing held while staged")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := cli.Write(ctx, websocket.MessageText, []byte(`{"finalize":true}`)); err != nil {
		t.Fatal(err)
	}
	// Its first reply (the save started), then its last (it fails: these
	// aren't MP4); either way, nothing's held.
	for i := 0; i < 50; i++ {
		if r := mseReply(t, cli); r["error"] != nil || r["fetch"] != nil && r["fetch"].(map[string]any)["done"] == true {
			break
		}
	}
	<-served
	if held := mseHeld(m); held != 0 {
		t.Errorf("%d bytes still held after the save", held)
	}
	if end, busy := g.defaultRoot().writes.startDeleting("."); busy {
		t.Error("the folder still busy after the save")
	} else {
		end()
	}
}

// TestMSEFinalizeAfterForgotDoesntPanic: a stage forgotten (its tab
// closed, its time up) while Save reads it is a failed save, not a second
// close of its abort channel (a panic that ended tabtopd).
func TestMSEFinalizeAfterForgotDoesntPanic(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("tab-1", ".")
	if err != nil {
		t.Fatal(err)
	}
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := stage.appendFrame(store, 0, mseKindInit, []byte("init")); err != nil {
		t.Fatal(err)
	}
	if err := stage.appendFrame(store, 0, mseKindPart, []byte("part")); err != nil {
		t.Fatal(err)
	}
	// Forgotten (another goroutine: the tab's end, its timer), then taken.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panicked: %v", r)
		}
	}()
	m.forgetMSEStage(stage.id)
	if _, _, err := m.takeMSEStage(stage); err == nil {
		t.Fatal("a forgotten stage was taken for saving")
	}
	// And raced, many times: one or the other has it, never both.
	for i := 0; i < 200; i++ {
		s, err := m.openMSEStage("tab-race", ".")
		if err != nil {
			t.Fatal(err)
		}
		s.appendFrame(store, 0, mseKindInit, []byte("init"))
		s.appendFrame(store, 0, mseKindPart, []byte("part"))
		go m.forgetMSEStage(s.id)
		if _, release, err := m.takeMSEStage(s); err == nil {
			release()
		}
		m.forgetMSEStage(s.id)
	}
	if held := mseHeld(m); held != 0 {
		t.Errorf("%d bytes held after the races", held)
	}
}

// TestMSEStageKeptWhileUsed: a stage is kept while it's being spilled to,
// however long the stream plays, and while it waits for the next spill (a
// paused video, or a stream slow to reach a spill's 4 MiB); forgotten once
// it's had nothing for mseStageKept.
func TestMSEStageKeptWhileUsed(t *testing.T) {
	old := mseStageKept
	mseStageKept = 300 * time.Millisecond
	defer func() { mseStageKept = old }()
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("tab-1", ".")
	if err != nil {
		t.Fatal(err)
	}
	srv, cli := mseTunnelPair(t)
	go m.serveMSEStage(srv, stage, &tunnelResponder{t: srv}, "by", "127.0.0.1", "who", nil, "")
	mseSend(t, cli, 0, mseKindInit, []byte("init"))
	// Spilled to, every 200 ms, for well past mseStageKept from its opening.
	for i := 0; i < 5; i++ {
		time.Sleep(200 * time.Millisecond)
		mseSend(t, cli, 0, mseKindPart, []byte("part"))
		if m.mseStage(stage.id) == nil {
			t.Fatalf("forgotten while used, after %d spills", i+1)
		}
	}
	time.Sleep(700 * time.Millisecond)
	if m.mseStage(stage.id) != nil {
		t.Error("kept after mseStageKept with nothing")
	}
}

// TestMSESaveWhenBusyKeepsStage: Save while the fetches are all going is
// refused ("wait"), and the stage, with all it holds, is kept to save
// later (it was deleted: everything captured lost).
func TestMSESaveWhenBusyKeepsStage(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("tab-1", ".")
	if err != nil {
		t.Fatal(err)
	}
	defer m.forgetMSEStage(stage.id)
	// The fetches all going.
	m.mu.Lock()
	if m.jobs == nil {
		m.jobs = map[string]*fetchJob{}
	}
	var fake []string
	for i := 0; i < maxFetches; i++ {
		id := string(rune('a' + i))
		fake = append(fake, id)
		m.jobs[id] = &fetchJob{id: id, done: make(chan struct{}), total: -1}
	}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		for _, id := range fake {
			delete(m.jobs, id)
		}
		m.mu.Unlock()
	}()
	srv, cli := mseTunnelPair(t)
	served := make(chan struct{})
	go func() {
		defer close(served)
		m.serveMSEStage(srv, stage, &tunnelResponder{t: srv}, "by", "127.0.0.1", "who", nil, "")
	}()
	mseSend(t, cli, 0, mseKindInit, []byte("init"))
	mseSend(t, cli, 0, mseKindPart, []byte("part"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := cli.Write(ctx, websocket.MessageText, []byte(`{"finalize":true}`)); err != nil {
		t.Fatal(err)
	}
	if r := mseReply(t, cli); r["error"] == nil {
		t.Fatalf("saved with every fetch going: %v", r)
	}
	if m.mseStage(stage.id) == nil {
		t.Error("the stage was given up, its save refused as busy")
	}
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.root.Stat(stage.dir); err != nil {
		t.Errorf("the stage's files are gone, its save refused as busy: %v", err)
	}
}
