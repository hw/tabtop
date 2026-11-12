package main

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// chunkTransport is the only transport contract needed by download flow control.
type chunkTransport interface {
	Read(context.Context) (websocket.MessageType, []byte, error)
	Write(context.Context, websocket.MessageType, []byte) error
	Close(websocket.StatusCode, string) error
	CloseNow() error
}

// chunkWriter sends what's written to it to the page in data messages of
// fileChunk bytes. The page acknowledges each once it has used it, with an
// empty data message, and at most fileWindow are unacknowledged, so a slow
// or paused download holds the sender back here instead of piling up in
// the page. Once the page goes, or leaves the writer waiting for room for
// fileStall, writes fail.
type chunkWriter struct {
	t             chunkTransport
	ctx           context.Context
	cancel        context.CancelFunc
	credits       chan struct{}
	sent          atomic.Int64
	stall         *time.Timer
	stallDuration time.Duration
	buf           []byte
}

// errStalled is a chunkWriter's error once the page stops acknowledging.
var errStalled = errors.New("the download stalled")

func newChunkWriter(t chunkTransport) *chunkWriter {
	return newChunkWriterWithStall(t, fileStall)
}

func newChunkWriterWithStall(t chunkTransport, stallDuration time.Duration) *chunkWriter {
	w := &chunkWriter{t: t, credits: make(chan struct{}, fileWindow), stall: time.NewTimer(stallDuration), stallDuration: stallDuration}
	w.stall.Stop() // runs only while waiting for room
	for range fileWindow {
		w.credits <- struct{}{}
	}
	w.ctx, w.cancel = context.WithCancel(context.Background())
	go func() {
		defer w.cancel() // ends the writes if the page goes
		for acked := int64(0); ; acked++ {
			typ, p, err := t.Read(w.ctx)
			if err != nil {
				t.CloseNow()
				return
			}
			if typ != websocket.MessageBinary || len(p) != 0 || acked >= w.sent.Load() {
				t.Close(websocket.StatusPolicyViolation, "bad acknowledgement")
				return
			}
			w.credits <- struct{}{} // never blocks: one was taken for each chunk sent
		}
	}()
	return w
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	// Made when first written to: a writer made to wait (for a slot, say)
	// holds none.
	if w.buf == nil {
		w.buf = make([]byte, 0, fileChunk)
	}
	n := 0
	for len(p) > 0 {
		k := min(len(p), fileChunk-len(w.buf))
		w.buf = append(w.buf, p[:k]...)
		p, n = p[k:], n+k
		if len(w.buf) == fileChunk {
			if err := w.flush(); err != nil {
				return n, err
			}
		}
	}
	return n, nil
}

// flush sends what's buffered, once the page has room for it.
func (w *chunkWriter) flush() error {
	if len(w.buf) == 0 {
		return nil
	}
	// Only time spent waiting for the page counts: a zip can take long
	// between chunks on its own, walking a big folder.
	select {
	case <-w.credits:
	default:
		w.stall.Reset(w.stallDuration)
		select {
		case <-w.credits:
		case <-w.ctx.Done():
			return w.ctx.Err()
		case <-w.stall.C:
			return errStalled
		}
		w.stall.Stop()
	}
	w.sent.Add(1)
	if err := w.t.Write(w.ctx, websocket.MessageBinary, w.buf); err != nil {
		return err
	}
	w.buf = w.buf[:0]
	return nil
}

// fail ends the tunnel after err from Write or from what was being sent.
func (w *chunkWriter) fail(err error) {
	switch {
	case errors.Is(err, errStalled):
		w.t.Close(websocket.StatusPolicyViolation, "the download stalled")
	case w.ctx.Err() != nil: // the page went
	default:
		w.t.Close(websocket.StatusInternalError, "read error")
	}
}

// stop ends the acknowledgement reader.
func (w *chunkWriter) stop() {
	w.cancel()
	w.stall.Stop()
}
