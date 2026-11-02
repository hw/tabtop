package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestDirectoryEventsClose(t *testing.T) {
	for _, flooded := range []bool{false, true} {
		t.Run(fmt.Sprint("fullQueue=", flooded), func(t *testing.T) {
			dir := t.TempDir()
			source, err := openDirectoryEvents(dir, changesWatchMask)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(source.Close)
			if flooded {
				for i := range 100 {
					if err := os.WriteFile(filepath.Join(dir, fmt.Sprint(i)), []byte("x"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				eventually(t, "full event queue", func() bool { return len(source.events) == cap(source.events) })
			}
			done := make(chan struct{})
			go func() { source.Close(); source.Close(); close(done) }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("Close did not join a blocked reader")
			}
			if err := source.Err(); err != nil {
				t.Fatalf("normal cancellation: %v", err)
			}
			// Closing the source also closes delivery, including a full queue.
			for range source.events {
			}
		})
	}
}

func TestDecodeDirectoryEvents(t *testing.T) {
	record := func(mask, cookie uint32, name string) []byte {
		b := make([]byte, unix.SizeofInotifyEvent+len(name)+1)
		binary.NativeEndian.PutUint32(b[4:8], mask)
		binary.NativeEndian.PutUint32(b[8:12], cookie)
		binary.NativeEndian.PutUint32(b[12:16], uint32(len(name)+1))
		copy(b[16:], name)
		return b
	}
	buf := append(record(unix.IN_MOVED_TO|unix.IN_ISDIR, 42, "folder"), record(unix.IN_IGNORED, 0, "")...)
	var got []directoryEvent
	if err := decodeDirectoryEvents(buf, func(e directoryEvent) bool { got = append(got, e); return true }); err != nil {
		t.Fatal(err)
	}
	clear(buf)
	if len(got) != 2 || got[0].name != "folder" || got[0].cookie != 42 || got[0].kind&(eventDirectory|eventMovedTo) != (eventDirectory|eventMovedTo) || got[1].kind&eventGone == 0 {
		t.Fatalf("decoded: %+v", got)
	}
	for _, bad := range [][]byte{make([]byte, 3), record(unix.IN_CLOSE_WRITE, 0, "file")[:17]} {
		if err := decodeDirectoryEvents(bad, func(directoryEvent) bool { t.Fatal("emitted truncated event"); return true }); !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("truncated event: %v", err)
		}
	}
}
