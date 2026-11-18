package main

import (
	"bytes"
	"compress/flate"
	"context"
	"crypto/rand"
	"io"
	"testing"

	"github.com/coder/websocket"
)

// goWrites is a msgConn that keeps what's written to it.
type goWrites struct {
	typ []websocket.MessageType
	msg [][]byte
}

func (w *goWrites) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	<-ctx.Done()
	return 0, nil, ctx.Err()
}
func (w *goWrites) Write(_ context.Context, typ websocket.MessageType, p []byte) error {
	w.typ, w.msg = append(w.typ, typ), append(w.msg, bytes.Clone(p))
	return nil
}
func (w *goWrites) Close(websocket.StatusCode, string) error      { return nil }
func (w *goWrites) CloseNow() error                               { return nil }
func (w *goWrites) CloseRead(ctx context.Context) context.Context { return ctx }

// A large message goes compressed to a page that takes it, as request
// number 0's bytes; small ones, ones that don't shrink, and any to a page
// that doesn't, as text.
func TestGoSendLarge(t *testing.T) {
	big := []byte(`{"type":"go-snapshot","doc":"` + string(bytes.Repeat([]byte("<p>same again</p>"), 5000)) + `"}`)
	noise := make([]byte, 40<<10)
	rand.Read(noise)
	for _, c := range []struct {
		name     string
		deflate  bool
		msg      []byte
		compress bool
	}{
		{"large, taken", true, big, true},
		{"large, not taken", false, big, false},
		{"small", true, []byte(`{"type":"go-changes"}`), false},
		{"doesn't shrink", true, noise, false},
	} {
		w := &goWrites{}
		b := &goBrowser{t: w, deflate: c.deflate}
		b.sendLarge(c.msg)
		if c.compress {
			if w.typ[0] != websocket.MessageBinary || !bytes.Equal(w.msg[0][:4], []byte{0, 0, 0, 0}) || len(w.msg[0]) > len(c.msg)/4 {
				t.Errorf("%s: sent as %v, %d bytes", c.name, w.typ[0], len(w.msg[0]))
				continue
			}
			got, err := io.ReadAll(flate.NewReader(bytes.NewReader(w.msg[0][4:])))
			if err != nil || !bytes.Equal(got, c.msg) {
				t.Errorf("%s: decompressed %d bytes, %v", c.name, len(got), err)
			}
		} else if w.typ[0] != websocket.MessageText || !bytes.Equal(w.msg[0], c.msg) {
			t.Errorf("%s: sent as %v", c.name, w.typ[0])
		}
	}
}
