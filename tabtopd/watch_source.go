package main

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const downloadWatchMask = unix.IN_CLOSE_WRITE | unix.IN_MOVED_FROM | unix.IN_MOVED_TO
const changesWatchMask = unix.IN_CREATE | unix.IN_DELETE | unix.IN_MOVED_FROM | unix.IN_MOVED_TO | unix.IN_CLOSE_WRITE | unix.IN_ATTRIB | unix.IN_DELETE_SELF | unix.IN_MOVE_SELF

// directoryEvents owns one inotify descriptor and reader. Registration is
// synchronous: callers may announce readiness as soon as open returns.
// Close interrupts both reads and blocked deliveries, then joins the reader.
type directoryEvents struct {
	events chan directoryEvent
	done   chan struct{}
	stop   chan struct{}
	file   *os.File
	once   sync.Once
	err    error // published by closing done
}

func openDirectoryEvents(dir string, mask uint32) (*directoryEvents, error) {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "inotify")
	if _, err := unix.InotifyAddWatch(fd, dir, mask|unix.IN_ONLYDIR); err != nil {
		f.Close()
		return nil, err
	}
	s := &directoryEvents{events: make(chan directoryEvent, 64), done: make(chan struct{}), stop: make(chan struct{}), file: f}
	go s.read()
	return s, nil
}

func (s *directoryEvents) Close() {
	s.once.Do(func() { close(s.stop); s.file.Close() })
	<-s.done
}

func (s *directoryEvents) Err() error { <-s.done; return s.err }

func (s *directoryEvents) read() {
	defer close(s.done)
	defer close(s.events)
	defer s.file.Close()
	buf := make([]byte, 64<<10)
	for {
		n, err := s.file.Read(buf)
		if err != nil {
			if !errors.Is(err, os.ErrClosed) {
				s.err = err
			}
			return
		}
		if n == 0 {
			s.err = io.ErrUnexpectedEOF
			return
		}
		err = decodeDirectoryEvents(buf[:n], func(e directoryEvent) bool {
			select {
			case s.events <- e:
				return true
			case <-s.stop:
				return false
			}
		})
		if err != nil {
			s.err = err
			return
		}
		select {
		case <-s.stop:
			return
		default:
		}
	}
}

// Copy decoded fields out of the syscall buffer; policies never depend on
// inotify structs or unsafe pointers. Kernel event lengths are checked too.
func decodeDirectoryEvents(buf []byte, emit func(directoryEvent) bool) error {
	for len(buf) > 0 {
		if len(buf) < unix.SizeofInotifyEvent {
			return io.ErrUnexpectedEOF
		}
		mask := binary.NativeEndian.Uint32(buf[4:8])
		cookie := binary.NativeEndian.Uint32(buf[8:12])
		length := uint64(binary.NativeEndian.Uint32(buf[12:16]))
		if length > uint64(len(buf)-unix.SizeofInotifyEvent) {
			return io.ErrUnexpectedEOF
		}
		end := unix.SizeofInotifyEvent + int(length)
		kind := eventChanged
		if mask&unix.IN_ISDIR != 0 {
			kind |= eventDirectory
		}
		if mask&unix.IN_MOVED_FROM != 0 {
			kind |= eventMovedFrom
		}
		if mask&unix.IN_MOVED_TO != 0 {
			kind |= eventMovedTo
		}
		if mask&unix.IN_CLOSE_WRITE != 0 {
			kind |= eventWritten
		}
		if mask&(unix.IN_DELETE_SELF|unix.IN_MOVE_SELF|unix.IN_IGNORED) != 0 {
			kind |= eventGone
		}
		// Overflow means some changes were lost: folder listings should refresh.
		if mask&unix.IN_Q_OVERFLOW != 0 {
			kind |= eventOverflow
		}
		e := directoryEvent{kind: kind, cookie: cookie, name: strings.TrimRight(string(buf[unix.SizeofInotifyEvent:end]), "\x00")}
		if !emit(e) {
			return nil
		}
		buf = buf[end:]
	}
	return nil
}
