package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOfflinePollInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found")
	}
	cfg := defaultServerConfig()
	cfg.offlineClient = true
	cfg.offlinePollRotate = 35 * time.Millisecond
	cfg.base = "/desk/"
	cfg.novncDir, cfg.downloadsDir = t.TempDir(), t.TempDir()
	cfg.usersFile, cfg.nobleDir = newUsersFile(t, "-").usersFile, fakeNoble(t)
	g, err := newServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.offlinePoll.stop)
	data := bytes.Repeat([]byte("interop poll data\n"), 500000)
	if err := os.WriteFile(filepath.Join(cfg.downloadsDir, "interop.bin"), data, 0600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, "testdata/offline_poll_interop.mjs", t.TempDir(), code(0))
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	h := g.handler()
	var switches atomic.Int32
	var wg sync.WaitGroup
	var writeMu sync.Mutex
	var requestsMu sync.Mutex
	requests := map[int]context.CancelFunc{}
	type message struct {
		ID          int
		Method, URL string
		Headers     map[string]string
		Body        []byte
		Cancel      bool
		Digest      string
		Upgrades    int
	}
	type reply struct {
		ID     int    `json:"id"`
		Status int    `json:"status"`
		Body   []byte `json:"body"`
	}
	var result message
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 2*pollSendLimit)
	for scanner.Scan() {
		var m message
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			t.Error(err)
			break
		}
		if m.Digest != "" {
			result = m
			continue
		}
		if m.Cancel {
			requestsMu.Lock()
			if cancel := requests[m.ID]; cancel != nil {
				cancel()
			}
			requestsMu.Unlock()
			continue
		}
		reqCtx, reqCancel := context.WithCancel(ctx)
		requestsMu.Lock()
		requests[m.ID] = reqCancel
		requestsMu.Unlock()
		wg.Go(func() {
			defer reqCancel()
			req := httptest.NewRequestWithContext(reqCtx, m.Method, m.URL, bytes.NewReader(m.Body))
			req.Header.Set("Origin", "null")
			for name, value := range m.Headers {
				req.Header.Set(name, value)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code == http.StatusOK && strings.HasSuffix(req.URL.Path, "/switch") {
				switches.Add(1)
			}
			requestsMu.Lock()
			delete(requests, m.ID)
			requestsMu.Unlock()
			if reqCtx.Err() == nil {
				writeMu.Lock()
				json.NewEncoder(input).Encode(reply{m.ID, w.Code, w.Body.Bytes()})
				writeMu.Unlock()
			}
		})
	}
	if err := scanner.Err(); err != nil {
		t.Error(err)
		cancel()
	}
	waitErr := cmd.Wait()
	cancel()
	wg.Wait()
	if waitErr != nil {
		t.Fatalf("offline client: %v\n%s", waitErr, stderr.String())
	}
	want := fmt.Sprintf("%x", sha256.Sum256(data))
	if result.Digest != want || result.Upgrades != 2 || switches.Load() < 2 {
		t.Fatalf("download digest %q (want %q), %d upgrades, %d switches", result.Digest, want, result.Upgrades, switches.Load())
	}
}
