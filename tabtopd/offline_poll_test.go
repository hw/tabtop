package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/coder/websocket"
	"golang.org/x/crypto/chacha20poly1305"
)

func TestOfflinePollRotation(t *testing.T) {
	cfg := defaultServerConfig()
	cfg.offlineClient = true
	cfg.base = "/desk/"
	cfg.novncDir = t.TempDir()
	cfg.downloadsDir = t.TempDir()
	cfg.usersFile = newUsersFile(t, "-").usersFile
	cfg.nobleDir = fakeNoble(t)
	g, err := newServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.offlinePoll.stop)
	h := g.handler()
	root := "http://localhost/desk/session/poll"
	ctx := testCtx(t)
	call := func(method, url, token string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
		req.Header.Set("Origin", "null")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	sendJSON := func(method, url, token, field, value string, status int) map[string]string {
		t.Helper()
		data, err := json.Marshal(map[string]string{field: value})
		if err != nil {
			t.Fatal(err)
		}
		w := call(method, url, token, data)
		if w.Code != status {
			t.Fatalf("%s %s returned %d: %s", method, url, w.Code, w.Body)
		}
		var response map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}

	create := func() pollOpened {
		t.Helper()
		w := call("POST", root, "", []byte(`{"requestId":"79fddbae-43a5-47c1-993b-32b727151119"}`))
		var opened pollOpened
		if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &opened) != nil || opened.RotateAfter != 45000 {
			t.Fatalf("create returned %d: %s", w.Code, w.Body)
		}
		return opened
	}
	opened := create()
	tunnelID, active, token := opened.TunnelID, opened.ConnectionID, opened.Token
	if again := create(); again != opened {
		t.Fatalf("create retry returned a different tunnel: %v", again)
	}
	connections := root + "/" + tunnelID + "/connections"
	if response := call("GET", connections+"/"+active+"?after=0", "wrong", nil); response.Code != 404 {
		t.Fatalf("wrong token returned %d", response.Code)
	}
	after, sent := uint64(0), uint64(0)
	receive := func(id string, after uint64) pollBatch {
		t.Helper()
		w := call("GET", fmt.Sprintf("%s/%s?after=%d", connections, id, after), token, nil)
		if w.Code != 200 {
			t.Fatalf("receive after %d returned %d: %s", after, w.Code, w.Body)
		}
		var batch pollBatch
		if err := json.Unmarshal(w.Body.Bytes(), &batch); err != nil {
			t.Fatal(err)
		}
		return batch
	}
	send := func(retry bool, frames ...[]byte) {
		t.Helper()
		var body []byte
		for _, frame := range frames {
			body = binary.BigEndian.AppendUint32(body, uint32(len(frame)))
			body = append(body, frame...)
		}
		url := fmt.Sprintf("%s/%s/send?seq=%d", connections, active, sent+1)
		sent += uint64(len(frames))
		for {
			w := call("POST", url, token, body)
			if w.Code != 200 || w.Body.String() != fmt.Sprintf("{\"accepted\":%d}\n", sent) {
				t.Fatalf("send returned %d: %s", w.Code, w.Body)
			}
			if !retry {
				break
			}
			retry = false
		}
	}

	id, secret, _ := g.newSession("192.0.2.1", "poll-test")
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := eph.PublicKey().Bytes()
	send(true, append(append([]byte{tunnelVersion, helloSession}, pub...), id...))
	hello := receive(active, 0)
	if hello.First != 1 || len(hello.Messages) != 1 || len(hello.Messages[0]) != 33 || hello.Messages[0][0] != tunnelVersion {
		t.Fatalf("unexpected server handshake: %+v", hello)
	}
	after++
	serverPub := hello.Messages[0][1:]
	ee, err := x25519(eph, serverPub)
	if err != nil {
		t.Fatal(err)
	}
	keys := sessionKeys(ee, secret, pub, serverPub, id)
	encrypt, _ := chacha20poly1305.New(keys[:32])
	decrypt, _ := chacha20poly1305.New(keys[32:64])

	plain := bytes.Repeat([]byte("abcd"), (fileWindow+4)*fileChunk/4)
	if err := os.WriteFile(filepath.Join(cfg.downloadsDir, "bridge.txt"), plain, 0600); err != nil {
		t.Fatal(err)
	}
	txNonce, rxNonce := uint64(0), uint64(0)
	encrypted := func(kind byte, data []byte) []byte {
		ct := encrypt.Seal(nil, tunnelNonce(txNonce), append([]byte{kind}, data...), nil)
		txNonce++
		return ct
	}
	send(true, encrypted(msgText, []byte(`{"type":"file","path":"bridge.txt"}`)))

	var got []byte
	rotations, credits := 0, 0
	for {
		batch := receive(active, after)
		if batch.Close != nil {
			if batch.Close.Code != websocket.StatusNormalClosure {
				t.Fatalf("unexpected close: %+v", batch.Close)
			}
			break
		}
		if batch.First != after+1 || len(batch.Messages) == 0 {
			t.Fatalf("unexpected receive sequence: %+v", batch)
		}
		if rotations < 3 {
			old := active
			next := sendJSON("POST", connections, token, "connectionId", old, 201)["connectionId"]
			if next == "" || next == old {
				t.Fatalf("invalid standby id %q", next)
			}
			if retry := sendJSON("POST", connections, token, "connectionId", old, 201)["connectionId"]; retry != next {
				t.Fatalf("prepare retry returned %q, want %q", retry, next)
			}
			for i := 0; i < 2; i++ {
				switchReply := sendJSON("POST", connections+"/"+old+"/switch", token, "connectionId", next, 200)
				if switchReply["connectionId"] != next {
					t.Fatalf("switch returned %v", switchReply)
				}
			}
			if oldReply := receive(old, after); oldReply.Switched != next {
				t.Fatalf("retired connection received %+v", oldReply)
			}
			active = next
			// Replay the response discarded at handoff through the new ID.
			replay := receive(active, after)
			if replay.First != batch.First || len(replay.Messages) < len(batch.Messages) {
				t.Fatalf("handoff lost part of a receive batch")
			}
			for i, frame := range batch.Messages {
				if !bytes.Equal(replay.Messages[i], frame) {
					t.Fatalf("handoff changed frame %d", i)
				}
			}
			if w := call("DELETE", connections+"/"+old, token, nil); w.Code != 204 {
				t.Fatalf("retiring connection returned %d", w.Code)
			}
			rotations++
		}
		var acks [][]byte
		for _, msg := range batch.Messages {
			decoded, err := decrypt.Open(nil, tunnelNonce(rxNonce), msg, nil)
			if err != nil {
				t.Fatalf("receive nonce %d: %v", rxNonce, err)
			}
			after++
			rxNonce++
			if decoded[0] == msgData {
				got = append(got, decoded[1:]...)
				if credits < 4 {
					acks = append(acks, encrypted(msgData, nil))
					credits++
				}
			}
		}
		if len(acks) > 0 {
			send(true, acks...)
		}
	}
	if rotations != 3 || !bytes.Equal(plain, got) {
		t.Fatalf("download after %d rotations: got %d bytes, want %d", rotations, len(got), len(plain))
	}
	if w := call("DELETE", connections+"/"+active, token, nil); w.Code != 204 {
		t.Fatalf("releasing tunnel returned %d", w.Code)
	}
	if w := call("GET", connections+"/"+active+"?after=0", token, nil); w.Code != 404 {
		t.Fatalf("released tunnel returned %d", w.Code)
	}
}

func TestOfflinePollAccessAndPreflight(t *testing.T) {
	g := &server{serverConfig: serverConfig{base: "/", vncOff: true}}
	request := func(h http.Handler, method, url, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(context.Background(), method, url, nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	const endpoint = "http://localhost/session/poll"
	if w := request(g.handler(), "POST", endpoint, "null"); w.Code != 404 {
		t.Fatalf("disabled bridge returned %d", w.Code)
	}
	g.offlineClient = true
	h := g.handler()
	if w := request(h, "OPTIONS", endpoint, "null"); w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatalf("preflight returned %d %v", w.Code, w.Header())
	}
	nested := endpoint + "/tunnel/connections/connection/switch"
	if w := request(h, "OPTIONS", nested, "null"); w.Code != 204 ||
		w.Header().Get("Access-Control-Allow-Headers") != "Authorization, Content-Type" {
		t.Fatalf("switch preflight returned %d %v", w.Code, w.Header())
	}
	for _, origin := range []string{"", "https://example.com"} {
		if w := request(h, "OPTIONS", endpoint, origin); w.Code != 403 || w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("origin %q returned %d %v", origin, w.Code, w.Header())
		}
	}
	if w := request(h, "OPTIONS", "http://example.com/session/poll", "null"); w.Code != 403 {
		t.Fatalf("unapproved host returned %d", w.Code)
	}
}
