package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type chunkFrame struct {
	kind websocket.MessageType
	data []byte
}
type fakeChunkTransport struct {
	frames chan chunkFrame
	writes chan []byte
	closed chan struct{}
	codes  chan websocket.StatusCode
	once   sync.Once
}

func newFakeChunkTransport() *fakeChunkTransport {
	return &fakeChunkTransport{frames: make(chan chunkFrame, 4), writes: make(chan []byte, fileWindow+4), closed: make(chan struct{}), codes: make(chan websocket.StatusCode, 1)}
}
func (c *fakeChunkTransport) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case f := <-c.frames:
		return f.kind, f.data, nil
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	case <-c.closed:
		return 0, nil, io.EOF
	}
}
func (c *fakeChunkTransport) Write(ctx context.Context, kind websocket.MessageType, p []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.closed:
		return io.EOF
	case c.writes <- bytes.Clone(p):
		return nil
	}
}
func (c *fakeChunkTransport) Close(code websocket.StatusCode, _ string) error {
	c.once.Do(func() { c.codes <- code; close(c.closed) })
	return nil
}
func (c *fakeChunkTransport) CloseNow() error { return c.Close(websocket.StatusNormalClosure, "") }

func fillChunkWindow(t *testing.T, w *chunkWriter) {
	t.Helper()
	if _, err := w.Write(make([]byte, fileWindow*fileChunk)); err != nil {
		t.Fatal(err)
	}
}

func TestChunkWriterWaitsForAcknowledgement(t *testing.T) {
	c := newFakeChunkTransport()
	w := newChunkWriterWithStall(c, time.Second)
	defer w.stop()
	fillChunkWindow(t, w)
	done := make(chan error, 1)
	go func() { _, err := w.Write(make([]byte, fileChunk)); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("sent beyond window: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	c.frames <- chunkFrame{kind: websocket.MessageBinary}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("ack did not release writer")
	}
}

func TestChunkWriterStallAndDisconnect(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		c := newFakeChunkTransport()
		w := newChunkWriterWithStall(c, 20*time.Millisecond)
		fillChunkWindow(t, w)
		if disconnect {
			c.CloseNow()
		}
		_, err := w.Write(make([]byte, fileChunk))
		if disconnect {
			if err == nil {
				t.Fatal("disconnect did not stop writer")
			}
		} else {
			if !errors.Is(err, errStalled) {
				t.Fatalf("stall error: %v", err)
			}
			w.fail(err)
			if code := <-c.codes; code != websocket.StatusPolicyViolation {
				t.Fatalf("stall close: %v", code)
			}
		}
		w.stop()
	}
}

func TestChunkWriterRejectsInvalidAcknowledgements(t *testing.T) {
	for _, frame := range []chunkFrame{{kind: websocket.MessageBinary}, {kind: websocket.MessageBinary, data: []byte{1}}, {kind: websocket.MessageText}} {
		c := newFakeChunkTransport()
		w := newChunkWriterWithStall(c, time.Second)
		c.frames <- frame
		select {
		case code := <-c.codes:
			if code != websocket.StatusPolicyViolation {
				t.Fatalf("invalid ack close: %v", code)
			}
		case <-time.After(time.Second):
			t.Fatal("invalid ack not rejected")
		}
		w.stop()
	}
}
